# PISA Client

A thin client for the PISA API running at https://alpha.pisa.watch. 

The PISA contract is currently deployed on Ropsten at 0xA02C7260c0020343040A504Ef24252c120be60b9

The client library supports **relay** and **event triggered** appointments. If no event information is provided when generating an appointment request then a relay appointment will be created. See https://alpha.pisa.watch/docs.html for more information on individual parameters

# PisaClient

The API exports a single class called `PisaClient`, whose constructor takes two parameters: the url of the PISA API server, and the address of the PISA contract.

```
const PISA_API_URL = "https://alpha.pisa.watch";
const PISA_CONTRACT_ADDRESS = "0xA02C7260c0020343040A504Ef24252c120be60b9";

const pisa = new PisaClient(PISA_API_URL, PISA_CONTRACT_ADDRESS);
```

## generateAndExecuteRequest

Simple example with ethersjs
--
Appointments requests must be signed by the PISA customer. A callback that signs a digest with the customer's private key must be provided when generating an appointment request, in this example we use an ethersjs wallet to sign the digest
```
const PISA_API_URL = "https://alpha.pisa.watch";
const PISA_CONTRACT_ADDRESS = "0xA02C7260c0020343040A504Ef24252c120be60b9";

// metadata info
const userWallet; // an ethersjs wallet
const appointmentId = "0x61f307f9dc16833ff12d511e22a20ac2a4d0adaa2f48292ebad9e0c80a2bb75d";
const nonce = 0;
const startBlock; // current block height just retrieved from a provider
const endBlock = startBlock + 200;

// response info
const responseAddress = "0x81b7e08f65bdf5648606c89998a9cc8164397647";
const responseData = "0x28fbdf0d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000";
const gasLimit = 100000;
const challengePeriod = 200;

// event info
const eventAddress = "0x9e64b53b935602cd0657343C69Fe200fb3cD05c8";
const topics = ["0x73ea0ff8e52eea08c37acf9b1de68b2f0039fd344d83d2563e2b266b073a93d4", null, "0x0000000000000000000000000000000000000000000000000000000000000001"];

const pisaClient = new PisaClient(PISA_API_URL, PISA_CONTRACT_ADDRESS);
const receipt = await pisaClient.generateAndExecuteRequest(
    digest => userWallet.signMessage(arrayify(digest)),
    userWallet.address,
    appointmentId,
    nonce,
    startBlock,
    endBlock,
    responseAddress,
    responseData,
    gasLimit,
    challengePeriod,
    eventAddress,
    topics
);
```
