import "mocha";
import request from "request-promise";
import * as SosContract from "./SOSContract";
import { Wallet, ethers } from "ethers";
import { JsonRpcProvider } from "ethers/providers";
import { wait } from "../../src/utils";


const encode = (request: any) => {
    const basicBytes = ethers.utils.defaultAbiCoder.encode(
        ["uint", "uint", "uint", "uint", "uint", "uint", "bytes32"],
        [
            request.id,
            request.jobId,
            request.startBlock,
            request.endBlock,
            request.challengePeriod,
            request.refund,
            request.paymentHash
        ]
    );

    const callBytes = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint", "bytes"],
        [request.contractAddress, request.customerAddress, request.gasLimit, request.data]
    );

    const conditionBytes = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "bytes", "bytes", "bytes", "uint"],
        [
            ethers.utils.toUtf8Bytes(request.eventABI),
            request.eventArgs,
            request.preCondition,
            request.postCondition,
            request.mode
        ]
    );

    const appointmentBytes = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "bytes", "bytes"],
        [basicBytes, callBytes, conditionBytes]
    );

    return ethers.utils.keccak256(appointmentBytes);
};

describe("alpha", () => {
    const PISA_URL = "http://18.219.31.158:5487/appointment";
    const ROPSTEN_URL = "https://ropsten.infura.io/v3/e587e78efcdd4c1eb5b068ee99a6ec0b";

    const createAppointmentRequest = (
        contractAddress: string,
        customerAddress: string,
        data: string,
        eventAbi: string,
        eventArgs: string,
        id: number,
        jobId: number,
        startBlock: number
    ) => {
        return {
            challengePeriod: 100,
            contractAddress,
            customerAddress: customerAddress,
            data,
            endBlock: startBlock + 30,
            eventABI: eventAbi,
            eventArgs: eventArgs,
            gasLimit: "100000",
            id,
            jobId,
            mode: 1,
            preCondition: "0x",
            postCondition: "0x",
            refund: "0",
            startBlock,
            paymentHash: "0xfc1624bdc50da30f2ea37b7debabeac1f6166db013c5880dcf63907b04199138"
        };
    };

    it("pisa", async () => {
        // connect to ropsten
        const provider = new JsonRpcProvider(ROPSTEN_URL);

        // 0xC73e1ebaFE312F149272ccA46A4acA3F8e8C62A6
        const customer = new Wallet("0xD3E0200D9A8E615ED48E8317730EDD239BCDE54FB6EB2EBDC2FD6E6EA57AD6B3", provider);

        // deploy the contract
        const channelContractFactory = new ethers.ContractFactory(SosContract.ABI,SosContract.ByteCode, customer);
        const rescueContract = channelContractFactory.attach("0x717Bd700367AEBf70a6e37ca731937c8079D0047");
        // const rescueContract = await channelContractFactory.deploy();

        // setup
        const startBlock = await provider.getBlockNumber();
        const helpMessage = "sos";
        const id = 8;
        const jobId = 1;

        // create an appointment
        const appointmentRequest = createAppointmentRequest(
            rescueContract.address,
            customer.address,
            SosContract.encodeData("remote"),
            SosContract.DISTRESS_EVENT_ABI,
            SosContract.encodeArgs(helpMessage),
            id,
            jobId,
            startBlock
        );

        // encode the request and sign it
        const encoded = encode(appointmentRequest);
        const customerSig = await customer.signMessage(ethers.utils.arrayify(encoded));

        const response = await request.post(PISA_URL, {
            json: { ...appointmentRequest, customerSig }
        });
        console.log(response)

        let success = false;
        rescueContract.once(SosContract.RESCUE_EVENT_METHOD_SIGNATURE, () => (success = true));
        await wait(50);
        
        const tx = await rescueContract.help(helpMessage, { gasLimit: 1000000 });
        console.log("help broadcast")
        await tx.wait();
        console.log("help mined")

        await waitForPredicate(() => success, 50, 20, helpMessage + ":Failed");
    }).timeout(100000);
});


const waitForPredicate = (
    predicate: () => Promise<boolean> | boolean,
    interval: number,
    repetitions: number,
    message: string | (() => Promise<string>)
) => {
    return new Promise((resolve, reject) => {
        const intervalHandle = setInterval(async () => {
            const predResult = await predicate();
            if (predResult) {
                resolve();
                clearInterval(intervalHandle);
            } else if (--repetitions <= 0) {
                if (message.length) reject(new Error(message as string));
                else reject(new Error(await (message as () => Promise<string>)()));
            }
        }, interval);
    });
};
