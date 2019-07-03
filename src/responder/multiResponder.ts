import { IEthereumResponseData, StartStopService } from "../dataEntities";
import { EthereumResponder } from "./responder";
import { GasQueue, PisaTransactionIdentifier, GasQueueItem, GasQueueItemRequest } from "./gasQueue";
import { GasPriceEstimator } from "./gasPriceEstimator";
import { ethers } from "ethers";
import { BlockProcessor } from "../blockMonitor";
import { BigNumber } from "ethers/utils";
import { inspect } from "util";
import logger from "../logger";
import { QueueConsistencyError, ArgumentError } from "../dataEntities/errors";
import { Block } from "../dataEntities/block";
import { Component } from "../blockMonitor/component";

enum ResponderState {
    Pending = 1,
    Mined = 2
}
type ResponderAppointmentAnchorState =
    | {
          state: ResponderState.Pending;
          identifier: PisaTransactionIdentifier;
      }
    | {
          state: ResponderState.Mined;
          identifier: PisaTransactionIdentifier;
          blockNumber: number;
          nonce: number;
      };

export type ResponderAnchorState = Map<PisaTransactionIdentifier, ResponderAppointmentAnchorState>;

export class MultiResponder extends EthereumResponder implements Component<ResponderAnchorState, Block> {
    private queue: GasQueue;
    private chainId: number;
    // private minedTransactions: WeakMap<Block, GasQueueItem> = new Map();
    private respondedTransactions: Set<PisaTransactionIdentifier> = new Set();

    // every time a new response arrives, I record it
    // then we add it to the anchor state
    // when it's mined we update the anchor state
    // of course, eventually it is removed
    // if a reorg happens the state is reverted

    /**
     * Can handle multiple response for a given signer. This responder requires exclusive
     * use of the signer, as it carefully manages the nonces of the transactions created by
     * the signer. Can handle a concurrent number of responses up to maxQueueDepth
     * @param signer
     *   The signer used to sign transaction created by this responder. This responder
     *   requires exclusive use of this signer.
     * @param gasEstimator
     * @param transactionTracker
     * @param maxConcurrentResponses
     *   Parity and Geth set maximums on the number of pending transactions in the
     *   pool that can emanate from a single account. Current defaults:
     *   Parity: max(16, 1% of the pool): https://wiki.parity.io/Configuring-Parity-Ethereum --tx-queue-per-sender
     *   Geth: 64: https://github.com/ethereum/go-ethereum/wiki/Command-Line-Options --txpool.accountqueue
     * @param replacementRate
     *   This responder replaces existing transactions on the network.
     *   This replacement rate is set by the nodes. The value should be the percentage increase
     *   eg. 13. Must be positive.
     *   Parity: 12.5%: https://github.com/paritytech/parity-ethereum/blob/master/miner/src/pool/scoring.rs#L38
     *   Geth: 10% default : https://github.com/ethereum/go-ethereum/wiki/Command-Line-Options --txpool.pricebump
     */
    constructor(
        signer: ethers.Signer,
        private readonly blockProcessor: BlockProcessor<Block>,
        private readonly gasEstimator: GasPriceEstimator,
        private readonly transactionTracker: TransactionTracker,
        public readonly maxConcurrentResponses: number = 12,
        public readonly replacementRate: number = 13
    ) {
        super(signer);
        if (replacementRate < 0) throw new ArgumentError("Cannot have negative replacement rate.", replacementRate);
        if (maxConcurrentResponses < 1) {
            throw new ArgumentError("Maximum concurrent requests cannot be negative.", maxConcurrentResponses);
        }
        this.txMined = this.txMined.bind(this);
        this.broadcast = this.broadcast.bind(this);
    }

    public reduce(prevState: ResponderAnchorState, block: Block): ResponderAnchorState {
        const result: ResponderAnchorState = new Map();

        // check the block for each of the current items in the queue
        for (const state of prevState.keys()) {
            // for each item there should be somthing in the responder state
            let stateFound: boolean = false;
            for (const tx of block.transactions) {
                // a contract creation - cant be of interest
                if (!tx.to) continue;

                // look for matching transactions
                const txIdentifier = new PisaTransactionIdentifier(tx.chainId, tx.data, tx.to, tx.value, tx.gasLimit);
                if (txIdentifier.equals(state)) {
                    // found a transaction with this identifier - therefore block is observed
                    result.set(state, {
                        identifier: txIdentifier,
                        blockNumber: block.number,
                        nonce: tx.nonce,
                        state: ResponderState.Mined
                    });
                    stateFound = true;
                    break;
                }
            }

            if (!stateFound) {
                result.set(state, {
                    state: ResponderState.Pending,
                    identifier: state
                });
            }
        }

        return result;
    }

    public handleNewStateEvent(
        prevHead: Block,
        prevState: ResponderAnchorState,
        head: Block,
        state: ResponderAnchorState
    ) {
        // after a reorg occurs - or any new head block, we need to check all the unmined transactions
        // are they in the gas queue, if a transaction is not mined, but is not
        // in the gas queue then we need to unlock some nonces and we need to add
        // the item to the queue - and potentially issue more transactions

        const missingTransactions = []

        for (const transaction of state.values()) {
            switch (transaction.state) {
                case ResponderState.Pending: {
                    // check that this is in the gas queue
                    if (
                        this.queue.queueItems.findIndex(i => i.request.identifier.equals(transaction.identifier)) === -1
                    ) {
                        // this item is in pending state -- but not in the queue we need to add it back in
                        missingTransactions.push(transaction);
                    }
                }
            }
        }

        const txMined = (block: Block, st: ResponderAppointmentAnchorState): boolean => {
            return st.state === ResponderState.Mined;
        };

        const txConfirmed = () => {};

        // on reorg we need to check which of the mined transactions have still been mined
        // we could check this on each new head state - we have to unless we
        // know that there's been a reorg - we could check all the transactions
        // that are not in the chain at the point of the previous stste

        for (const block of this.blockProcessor.blockCache.ancestry(head.hash)) {
            // go back through the ancestory, getting any transactions that are in the set
            this.minedTransactions.get(block);
        }
    }

    // we do some async setup
    private async setup() {
        if (!this.queue) {
            const address = await this.signer.getAddress();
            const nonce = await this.provider.getTransactionCount(address);
            this.chainId = (await this.provider.getNetwork()).chainId;
            this.queue = new GasQueue([], nonce, this.replacementRate, this.maxConcurrentResponses);
        }
    }

    public async startResponse(appointmentId: string, responseData: IEthereumResponseData) {
        try {
            await this.setup();
            if (this.queue.depthReached()) {
                throw new Error(`Cannot add to queue. Max queue depth ${this.queue.maxQueueDepth} reached.`);
            }

            // form a queue item request
            const abiInterface = new ethers.utils.Interface(responseData.contractAbi);
            const data = abiInterface.functions[responseData.functionName].encode(responseData.functionArgs);
            const txIdentifier = new PisaTransactionIdentifier(
                this.chainId,
                data,
                responseData.contractAddress,
                new BigNumber(0),
                new BigNumber(EthereumResponder.GAS_LIMIT)
            );
            const idealGas = await this.gasEstimator.estimate(responseData);
            const request = new GasQueueItemRequest(txIdentifier, idealGas, responseData);

            // add the queue item to the queue, since the queue is ordered this may mean
            // that we need to replace some transactions on the network. Find those and
            // broadcast them
            const replacedQueue = this.queue.add(request);
            const replacedTransactions = replacedQueue.difference(this.queue);
            this.queue = replacedQueue;
            // and update the local list of tx identifiers
            this.respondedTransactions.add(txIdentifier);

            await Promise.all(replacedTransactions.map(this.broadcast));
        } catch (doh) {
            if (doh instanceof QueueConsistencyError) logger.error(doh.stack!);
            else {
                logger.error(`Unexpected error trying to respond for: ${appointmentId}.`);
                if (doh.stack) logger.error(doh.stack);
                else logger.error(doh);
            }
        }
    }

    /**
     * A newly mined transaction requires updating the local representation of the
     * transaction pool. If a transaction has been mined, but was already replaced
     * then more transactions may need to be re-issued.
     * @param txIdentifier
     * Identifier of the mined transaction
     * @param nonce
     * Nonce of the mined transaction. Should always correspond to the nonce at the
     * front of the current transaction queue. Will throw QueueConsistencyError otherwise.
     * This enforces that this method is called in the same order that transactions are mined
     */
    public async txMined(txIdentifier: PisaTransactionIdentifier, nonce: number) {
        try {
            // since we've made this method available publicly we need to ensure that the class has been initialised
            await this.setup();

            if (this.queue.queueItems.length === 0) {
                throw new QueueConsistencyError(
                    `Transaction mined for empty queue at nonce ${nonce}. ${inspect(txIdentifier)}`
                );
            }
            if (!this.queue.contains(txIdentifier)) {
                throw new QueueConsistencyError(`Transaction identifier not found in queue. ${inspect(txIdentifier)}`);
            }
            const frontItem = this.queue.queueItems[0];
            if (frontItem.nonce !== nonce) {
                throw new QueueConsistencyError(
                    `Front of queue nonce ${frontItem.nonce} does not correspond to nonce ${nonce}. ${inspect(
                        txIdentifier
                    )}`
                );
            }

            if (txIdentifier.equals(frontItem.request.identifier)) {
                // the mined transaction was the one at the front of the current queue
                // this is what we hoped for, simply dequeue the transaction
                this.queue = this.queue.dequeue();
            } else {
                // the mined transaction was not the one at the front of the current queue
                // - it was at the front of a past queue. This means that the transaction
                // at the front of the current queue can no longer be mined as it shares the same
                // nonce. We need to find the transaction in the current queue that corresponds to
                // the mined tx and remove it. In doing so free up a later nonce.
                // and bump up all transactions with a lower nonce so that the tx that is
                // at the front of the current queue - but was not mined - remains there
                const reducedQueue = this.queue.consume(txIdentifier);
                const replacedTransactions = reducedQueue.difference(this.queue);
                this.queue = reducedQueue;

                // since we had to bump up some transactions - change their nonces
                // we'll have to issue new transactions to the network
                await Promise.all(replacedTransactions.map(this.broadcast));
            }
        } catch (doh) {
            if (doh instanceof QueueConsistencyError) logger.error(doh.stack!);
            else {
                logger.error(`Unexpected error after mining transaction. ${txIdentifier}.`);
                if (doh.stack) logger.error(doh.stack);
                else logger.error(doh);
            }
        }
    }

    private async broadcast(queueItem: GasQueueItem) {
        try {
            this.transactionTracker.addTx(queueItem.request.identifier, this.txMined);
            await this.signer.sendTransaction(queueItem.toTransactionRequest());
        } catch (doh) {
            // we've failed to broadcast a transaction however this isn't a fatal
            // error. Periodically, we look to see if a transaction has been mined
            // for whatever reason if not then we'll need to re-issue the transaction
            // anyway
            if (doh.stack) logger.error(doh.stack);
            else logger.error(doh);
        }
    }
}

export class TransactionTracker extends StartStopService {
    constructor(private readonly blockProcessor: BlockProcessor<Block>) {
        super("transaction-tracker");
        this.checkTxs = this.checkTxs.bind(this);
    }
    private lastBlockNumber: number;
    private readonly txCallbacks: Map<
        PisaTransactionIdentifier,
        (txIdentifier: PisaTransactionIdentifier, nonce: number) => {}
    > = new Map();

    protected async startInternal() {
        this.lastBlockNumber = this.blockProcessor.head.number;
        this.blockProcessor.on(BlockProcessor.NEW_HEAD_EVENT, this.checkTxs);
    }

    protected async stopInternal() {
        this.blockProcessor.off(BlockProcessor.NEW_HEAD_EVENT, this.checkTxs);
    }

    public addTx(
        identifier: PisaTransactionIdentifier,
        callback: (txIdentifier: PisaTransactionIdentifier, nonce: number) => {}
    ) {
        this.txCallbacks.set(identifier, callback);
    }

    public hasTx(identifier: PisaTransactionIdentifier) {
        return this.txCallbacks.has(identifier);
    }

    public checkTxs(blockNumber: number, blockHash: string) {
        let blockStub = this.blockProcessor.blockCache.getBlockStub(blockHash);

        for (let index = blockNumber; index > this.lastBlockNumber; index--) {
            if (!blockStub) continue;
            // check all the transactions in that block
            const txs = this.blockProcessor.blockCache.getBlockStub(blockStub.hash)!.transactions;
            if (!txs) continue;

            for (const tx of txs) {
                // if the transaction doesn't have a to field populated it is a contract creation tx
                // which means it cant be a transaction to a PISA contract
                if (!tx.to) continue;

                // look for matching transactions
                const txIdentifier = new PisaTransactionIdentifier(tx.chainId, tx.data, tx.to, tx.value, tx.gasLimit);
                for (const callbackKey of this.txCallbacks.keys()) {
                    if (callbackKey.equals(txIdentifier)) {
                        const callback = this.txCallbacks.get(callbackKey);
                        this.txCallbacks.delete(callbackKey);
                        callback!(txIdentifier, tx.nonce);
                    }
                }
            }

            // move on to the next block
            blockStub = this.blockProcessor.blockCache.getBlockStub(blockStub.parentHash);
        }

        this.lastBlockNumber = blockNumber;
    }
}
