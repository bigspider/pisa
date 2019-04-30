import { EventEmitter } from "events";
import { ethers } from "ethers";
import { wait, promiseTimeout, plural } from "./utils";
import { waitForConfirmations, rejectAfterBlocks, BlockThresholdReachedError, rejectIfAnyBlockTimesOut } from "./utils/ethers";
import { IEthereumAppointment, IEthereumResponseData } from "./dataEntities/appointment";
import logger from "./logger";
import { ApplicationError } from "./dataEntities";

/**
 * Responsible for storing the state and managing the flow of a single response.
 */
// TODO: This class and ResponseState are not currently used in any meaningful way.
//       The plan is to use them for accounting, make sure this is the case.
export abstract class ResponseFlow {
    private static nextId: number = 0;

    readonly id: number;
    readonly creationTimestamp: number;

    public state = ResponseState.Started;

    constructor(readonly appointmentId: string) {
        this.id = ResponseFlow.nextId++;
        this.creationTimestamp = Date.now();
    }
}

/**
 * This class stores the state of a response on the Ethereum blockchain.
 */
export class EthereumResponseFlow extends ResponseFlow {
    public txHash: string = null; // if a transaction has been sent, this is its hash
    constructor(public appointmentId: string, public readonly ethereumResponseData: IEthereumResponseData) {
        super(appointmentId);
    }
}

/**
 * Represents the current state of a Response
 */
export enum ResponseState {
    Ready,        // initial status
    Started,      // flow started
    ResponseSent, // responded, but waiting for enough confirmations
    Success,      // responded with enough confirmations
    Failed        // response flow failed
}

/**
 * Represents the possible events emitted by a Responder.
 */
export enum ResponderEvent {
    ResponseSent = "responseSent",
    ResponseConfirmed = "responseConfirmed",
    AttemptFailed = "attemptFailed",
    ResponseFailed = "responseFailed"
}

/**
 * Responsible for responding to observed events.
 * The responder is solely responsible for ensuring that a transaction gets to the blockchain.
 */
export abstract class Responder extends EventEmitter {
    /**
     * Creates a new Response object, initiating the flow of submitting state to the blockchain.
     */
    constructor() {
        super();
    }

    // Commodity function to emit events asynchronously
    protected asyncEmit(...args: any[]): Promise<boolean> {
        return new Promise(resolve => resolve(this.emit.apply(this, args)))
    }
}

/**
 * A generic abstract responder for the Ethereum blockchain.
 * It has exclusive control of a wallet, that is, no two instances should share the same wallet.
 * It implements the submitStateFunction, but no strategy.
 */
export abstract class EthereumResponder extends Responder {
    // TODO-93: the correct gas limit should be provided based on the appointment/integration.
    //          200000 is enough for Kitsune and Raiden (see https://github.com/raiden-network/raiden-contracts/blob/master/raiden_contracts/data/gas.json).
    private static GAS_LIMIT = 200000;

    // implementations should query the provider (or a service) to figure out the appropriate gas price
    protected gasPrice = new ethers.utils.BigNumber(21000000000);

    constructor(public readonly signer: ethers.Signer) {
        super();
    }

    /**
     * Creates the transaction request to be sent to handle the response in `resposeData`.
     *
     * @param responseData the response data used to create the transaction
     * @param nonce The nonce to be used. If `null`, the provider will set the nonce. It is recommended to explicitly provide a nonce,
     *              especially if the same wallet might send multiple transactions concurrently or in a short span.
     */
    protected prepareTransactionRequest(responseData: IEthereumResponseData, nonce: number = null): ethers.providers.TransactionRequest {
        // form the interface so that we can serialise the args and the function name
        const abiInterface = new ethers.utils.Interface(responseData.contractAbi);
        const data = abiInterface.functions[responseData.functionName].encode(responseData.functionArgs);
        // now create a transaction, specifying possible oher variables
        return {
            to: responseData.contractAddress,
            gasLimit: EthereumResponder.GAS_LIMIT,
            nonce: nonce,
            gasPrice: this.gasPrice,
            data: data
        };
    }

    /**
    * @param appointmentId The id of the Appointment this object is responding to.
    * @param response The IEthereumResponse containing what needs to be submitted.
    */
    public abstract startResponse(appointmentId: string, responseData: IEthereumResponseData): void;
}


/* CONCRETE RESPONDER IMPLEMENTATIONS */

/**
 * A gas policy implements the strategy for the choice of the gas price for subsequent attempts at submitting a transaction.
 */
export interface GasPolicy {
    getInitialPrice(): Promise<ethers.utils.BigNumber>
    getIncreasedGasPrice(previousPrice: ethers.utils.BigNumber): ethers.utils.BigNumber
}


/**
 * A simple gas choice strategy that queries the provider for an initial estimate of the gas price, and then it doubles it
 * at each subsequent attempt.
 */
export class DoublingGasPolicy implements GasPolicy {
    constructor(private readonly provider: ethers.providers.Provider) { }

    getInitialPrice(): Promise<ethers.utils.BigNumber> {
        return this.provider.getGasPrice();
    }

    getIncreasedGasPrice(previousPrice: ethers.utils.BigNumber): ethers.utils.BigNumber {
        return previousPrice.mul(2);
    }
}

/**
 * A simple custom Error class to signal that the speified number of blocks has been mined.
 */
export class StuckTransactionError extends Error {
   constructor(message: string) {
       super(message);
       this.name = "StuckTransactionError";
   }
}


/**
 * This class encapsulates the logic of trying to send a transaction and make sure it is mined with enough confirmations.
 */
export class EthereumTransactionMiner extends EventEmitter {
    private timeLastBlockReceived: number;

    /**
     * @param signer The Signer to use to send the transaction.
     * @param transactionRequest The TransactionRequest to be sent.
     * @param confirmationsRequired The number of confirmations required.
     * @param blocksThresholdForStuckTransaction The number of new blocks without the transaction is mined before considering
     *                                           the transaction "stuck".
     * @param newBlockTimeout The number of milliseconds since `timeLastBlockReceived` (or since the creation of this instance)
     *                        after which the provider is considered non-responsive.
     * @param timeLastBlockReceived Optional; if known, the time when the last block was received by the provider.
     *                              If not given, the current time returned by `Date.now()` will be used.
     */
    constructor(
        public readonly signer: ethers.Signer,
        public readonly transactionRequest: ethers.providers.TransactionRequest,
        public readonly confirmationsRequired: number,
        public readonly blocksThresholdForStuckTransaction: number,
        public readonly newBlockTimeout: number,
        timeLastBlockReceived?: number
    ) {
        super();

        this.timeLastBlockReceived = timeLastBlockReceived || Date.now()

        this.newBlockReceived = this.newBlockReceived.bind(this);
        signer.provider.on("block", this.newBlockReceived);
    }

    private newBlockReceived() {
        this.timeLastBlockReceived = Date.now();
    }

    /**
     * Starts the transaction flow. The returned promise will resolve once the transaction is mined and confirmed with enough confirmations.
     *
     * It will generate the "sent" event with the `ethers.provider.TransactionResponse` when returned by the provider.
     * Usually, this will happen before the transaction is mined (except on a provider on top of Ganache, which might mine a block
     * upon receiving a transaction).
     * If at any point the provider does not receive a new block for `newBlockTimeout` milliseconds, the promis will reject
     * with a `NoNewBlockError`.
     * Then, it will wait for the transaction to get the first confirmation; if that does not happen within
     * `blocksThresholdForStuckTransaction` blocks, the promise will reject with `BlockThresholdReachedError`.
     * After the first confirmation, it will still wait until the transaction has `confirmationsRequired` confirmations.
     * If the transaction is not found on the blockchain anymore because of a re-org, it will reject with `ReorgError`.
     * Once the the transaction has `confirmationsRequired` confirmations, the promise will resolve.
     */
    public async sendTransaction(): Promise<void> {
        const txResponse = await this.signer.sendTransaction(this.transactionRequest);

        // Signal event that transaction is sent
        this.emit("sent", txResponse);

        const lastBlockNumberSeen = await this.signer.provider.getBlockNumber();

        // Promise that waits for the first confirmation
        const firstConfirmationPromise = waitForConfirmations(this.signer.provider, txResponse.hash, 1);

        // Promise that rejects after WAIT_BLOCKS_BEFORE_RETRYING blocks are mined
        const firstConfirmationTimeoutPromise = rejectAfterBlocks(
            this.signer.provider, lastBlockNumberSeen, this.blocksThresholdForStuckTransaction
        );

        // Promise that waits for enough confirmations before declaring success
        const enoughConfirmationsPromise = waitForConfirmations(this.signer.provider, txResponse.hash, this.confirmationsRequired);

        // ...but stop with error if no new blocks come for too long
        const noNewBlockPromise = rejectIfAnyBlockTimesOut(
            this.signer.provider,
            this.timeLastBlockReceived || Date.now(),
            this.newBlockTimeout,
            1000
        );

        const cancellablePromises = [enoughConfirmationsPromise, noNewBlockPromise]
        try {
            // First, wait to get at least 1 confirmation, but throw an error if the transaction is stuck
            // (that is, new blocks are coming, but the transaction is not included)
            await Promise.race([
                firstConfirmationPromise,
                firstConfirmationTimeoutPromise,
                noNewBlockPromise
            ]);

            // Then, wait to get at enough confirmations; now only throw an error if there is a reorg
            await Promise.race([
                enoughConfirmationsPromise,
                noNewBlockPromise
            ]);
        } finally {
            // Make sure any pending CancellablePromise is released
            for (let p of cancellablePromises) {
                p.cancel();
            }
            this.signer.provider.removeListener("block", this.newBlockReceived);
        }
    }
}

/**
 * This responder can only handle one response. The wallet used by this responder should not be used for any other purpose
 * until the end of the response flow (that is, until the event `responseConfirmed` is emitted).
 */
export class EthereumDedicatedResponder extends EthereumResponder {
    // Waiting time before retrying, in milliseconds
    public static readonly WAIT_TIME_BETWEEN_ATTEMPTS = 1000;

    // Waiting time before considering a request to the provider failed, in milliseconds
    public static readonly WAIT_TIME_FOR_PROVIDER_RESPONSE = 30*1000;

    // Waiting time before throwing an error if no new blocks are received, in milliseconds
    public static readonly WAIT_TIME_FOR_NEW_BLOCK = 120*1000;

    // Number of blocks to wait for the first confirmation
    public static readonly WAIT_BLOCKS_BEFORE_RETRYING = 20;

    private locked = false; // Lock to prevent this responder from accepting multiple requests

    // Timestamp in milliseconds when the last block was received (or since the creation of this object)
    private lastBlockNumberSeen: number;
    private timeLastBlockReceived: number;

    /**
     * @param signer The signer of the wallet associated with this responder. Each responder should have exclusive access to his wallet.
     * @param [confirmationsRequired] The number of confirmations required before a transaction is trusted.
     * @param [maxAttempts] The maximum number of retries before the Responder will give up.
     */
    constructor(
        signer: ethers.Signer,
        private readonly gasPolicy: GasPolicy,
        public readonly confirmationsRequired: number,
        private readonly maxAttempts: number
    ) {
        super(signer);
    }

    // Makes sure that the class is locked while `fn` is running, and that any listener is registered and cleared correctly
    private async withLock(fn: () => Promise<any>) {
        if (this.locked) {
            throw new ApplicationError("This responder can ony handle one response at a time."); // TODO:93: more specific Error type?
        }

        this.locked = true;

        const listener = this.newBlockReceived.bind(this);
        this.signer.provider.on("block", listener);

        this.lastBlockNumberSeen = 0;
        this.timeLastBlockReceived = Date.now();

        try {
            await fn();
        } finally {
            this.signer.provider.removeListener("block", listener);
            this.locked = false;
        }
    }

    private newBlockReceived(blockNumber: number) {
        this.lastBlockNumberSeen = blockNumber;
        this.timeLastBlockReceived = Date.now();
    }

    public async startResponse(appointmentId: string, responseData: IEthereumResponseData) {
        this.withLock(async () => {
            const cancellablePromises = []; // Promises to cancel on cleanup to prevent memory leaks

            const responseFlow = new EthereumResponseFlow(appointmentId, responseData);

            const signerAddress = await promiseTimeout(
                this.signer.getAddress(),
                EthereumDedicatedResponder.WAIT_TIME_FOR_PROVIDER_RESPONSE
            );

            // Get the current nonce to be used
            const nonce = await promiseTimeout(
                this.signer.provider.getTransactionCount(signerAddress),
                EthereumDedicatedResponder.WAIT_TIME_FOR_PROVIDER_RESPONSE
            );

            // Get the initial gas price
            this.gasPrice = await this.gasPolicy.getInitialPrice();

            let attemptsDone = 0;
            while (attemptsDone < this.maxAttempts) {
                attemptsDone++;
                try {
                    // Try to call submitStateFunction, but timeout with an error if
                    // there is no response for WAIT_TIME_FOR_PROVIDER_RESPONSE ms.
                    const txRequest = this.prepareTransactionRequest(responseData, nonce);

                    const txMiner = new EthereumTransactionMiner(
                        this.signer,
                        txRequest,
                        this.confirmationsRequired,
                        EthereumDedicatedResponder.WAIT_BLOCKS_BEFORE_RETRYING,
                        EthereumDedicatedResponder.WAIT_TIME_FOR_NEW_BLOCK
                    );

                    txMiner
                        .on("sent", (txResponse: ethers.providers.TransactionResponse) => {
                            // The response has been sent, but should not be considered confirmed yet.
                            responseFlow.state = ResponseState.ResponseSent;
                            responseFlow.txHash = txResponse.hash;
                            this.asyncEmit(ResponderEvent.ResponseSent, responseFlow, attemptsDone);
                        })

                    await txMiner.sendTransaction();

                    // The response has now enough confirmations to be considered safe.
                    responseFlow.state = ResponseState.Success;
                    this.asyncEmit(ResponderEvent.ResponseConfirmed, responseFlow, attemptsDone);

                    return;
                } catch (doh) {
                    if (doh instanceof BlockThresholdReachedError) {
                        // Bump the gas price before the next attempt
                        this.gasPrice = this.gasPolicy.getIncreasedGasPrice(this.gasPrice);

                        this.asyncEmit(
                            ResponderEvent.AttemptFailed,
                            responseFlow,
                            new StuckTransactionError(
                                `Transaction not mined after ${EthereumDedicatedResponder.WAIT_BLOCKS_BEFORE_RETRYING} blocks.`
                            )
                        );
                    } else {
                        this.asyncEmit(ResponderEvent.AttemptFailed, responseFlow, doh, attemptsDone);
                    }
                } finally {
                    // Make sure any pending CancellablePromise is released
                    for (let p of cancellablePromises) {
                        p.cancel();
                    }
                }

                // TODO: does waiting a longer time before retrying help in any way?
                await wait(EthereumDedicatedResponder.WAIT_TIME_BETWEEN_ATTEMPTS);
            }
            responseFlow.state = ResponseState.Failed;
            this.asyncEmit(ResponderEvent.ResponseFailed, responseFlow, attemptsDone);
        });
    }
}


/**
 * Responsible for handling the business logic of the Responders.
 */
// TODO: This is a mock class and only correctly handles one active response.
//       Should add a pool of wallets to allow concurrent responses.

export class EthereumResponderManager {
    private responders: Set<EthereumResponder> = new Set();
    private gasPolicy: GasPolicy;

    constructor(private readonly signer: ethers.Signer) {
        this.gasPolicy = new DoublingGasPolicy(this.signer.provider);
    }

    public respond(appointment: IEthereumAppointment) {
        const ethereumResponseData = appointment.getResponseData();

        const responder = new EthereumDedicatedResponder(this.signer, this.gasPolicy, 40, 10);
        this.responders.add(responder);
        responder
            .on(ResponderEvent.ResponseSent, (responseFlow: ResponseFlow, attemptNumber) => {
                logger.info(
                    `Successfully responded to appointment ${appointment.id} on attempt #${attemptNumber}. Waiting for enough confirmations.`
                );

                // TODO: Should we store information about past responders anywhere?
                this.responders.delete(responder);
            })
            .on(ResponderEvent.ResponseConfirmed, (responseFlow: ResponseFlow, attemptNumber: number) => {
                logger.info(
                    `Successfully responded to appointment ${appointment.id} after ${attemptNumber} ${plural(attemptNumber, "attempt")}.`
                );

                // Should we keep inactive responders anywhere?
                this.responders.delete(responder);
            })
            .on(ResponderEvent.AttemptFailed, (responseFlow: ResponseFlow, doh, attemptNumber) => {
                logger.error(
                    `Failed to respond to appointment ${appointment.id}; ${attemptNumber} ${plural(attemptNumber, "attempt")}.`
                );
                logger.error(doh);
            })
            .on(ResponderEvent.ResponseFailed, (responseFlow: ResponseFlow, attempts) => {
                logger.error(
                    `Failed to respond to ${appointment.id}, after ${attempts} ${plural(attempts, "attempt")}. Giving up.`
                );

                // TODO: this is serious and should be escalated.
            })
            .startResponse(appointment.id, ethereumResponseData);
    }
}
