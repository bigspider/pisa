import "mocha";
import { Watcher } from "../../src/watcher/watcher";
import { KitsuneInspector, KitsuneAppointment, KitsuneTools } from "../../src/integrations/kitsune";
import { ethers, Signer } from "ethers";
import Ganache from "ganache-core";
import { ChannelType } from "../../src/dataEntities";

import { EthereumResponderManager } from "../../src/responder";
import { MemoryAppointmentStore } from "../../src/watcher/store";
import { EventObserver } from "../../src/watcher/eventObserver";
import { AppointmentSubscriber } from "../../src/watcher/appointmentSubscriber";
import { CommandStore, ExecutionEngine, ActionManager } from "../../src/undo";
import { BlockCacher } from "../../src/utils/ethers";
const ganache = Ganache.provider({
    mnemonic: "myth like bonus scare over problem client lizard pioneer submit female collect"
});

describe("End to end", () => {
    let player0: string,
        player1: string,
        pisaAccount: string,
        hashState: string,
        sig0: string,
        sig1: string,
        channelContract: ethers.Contract,
        round: number,
        provider: ethers.providers.Web3Provider = new ethers.providers.Web3Provider(ganache);

    before(async () => {
        provider.pollingInterval = 100;
        // set the 2 accounts
        const accounts = await provider.listAccounts();
        player0 = accounts[0];
        player1 = accounts[1];
        pisaAccount = accounts[2];

        // deploy the channel
        const channelContractFactory = new ethers.ContractFactory(
            KitsuneTools.ContractAbi,
            KitsuneTools.ContractBytecode,
            provider.getSigner(accounts[3])
        );
        channelContract = await channelContractFactory.deploy([player0, player1], 11);
        // set the round
        round = 1;
        // set the hash state
        hashState = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("hello"));
        // set the sigs
        const setStateHash = KitsuneTools.hashForSetState(hashState, round, channelContract.address);
        sig0 = await provider.getSigner(player0).signMessage(ethers.utils.arrayify(setStateHash));
        sig1 = await provider.getSigner(player1).signMessage(ethers.utils.arrayify(setStateHash));
    });

    it("inspect and watch a contract", async () => {
        const inspector = new KitsuneInspector(10, provider);
        // 1. Verify appointment
        const appointment = new KitsuneAppointment({
            stateUpdate: {
                contractAddress: channelContract.address,
                hashState: hashState,
                round: 1,
                signatures: [sig0, sig1]
            },

            expiryPeriod: 12,
            type: ChannelType.Kitsune
        });
        await inspector.inspectAndPass(appointment);

        // TODO:113: remove this or mock
        const blockCacher = new BlockCacher(provider);
        blockCacher.start();

        // 2. pass this appointment to the watcher

        const store = new MemoryAppointmentStore();
        const actionManager = new ActionManager(
            new ExecutionEngine(new CommandStore()),
            new AppointmentSubscriber(provider),
            new EthereumResponderManager(provider.getSigner(pisaAccount)),
            store
        );
        const watcher = new Watcher(store, actionManager, blockCacher);
        const player0Contract = channelContract.connect(provider.getSigner(player0));

        await watcher.addAppointment(appointment);

        // 3. Trigger a dispute
        const tx = await player0Contract.triggerDispute();
        await tx.wait();
        blockCacher.stop();
        await wait(2000);
    }).timeout(3000);
});

const wait = async (timeout: number) => {
    const testPromise = new Promise(function(resolve, reject) {
        setTimeout(function() {
            resolve();
        }, timeout);
    });

    return await testPromise;
};
