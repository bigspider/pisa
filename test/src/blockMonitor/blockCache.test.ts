import "mocha";
import { expect } from "chai";
import { BlockCache, IBlockStub } from "../../../src/blockMonitor";
import { ethers } from "ethers";

function generateBlocks(nBlocks: number, initialHeight: number, chain: string): ethers.providers.Block[] {
    const result: ethers.providers.Block[] = [];
    for (let height = initialHeight; height < initialHeight + nBlocks; height++) {
        const transactions: string[] = [];
        for (let i = 0; i < 5; i++) {
            transactions.push(`${chain}-block${height}tx${i + 1}`);
        }

        const block = {
            number: height,
            hash: `hash${height}`,
            parentHash: `hash${height - 1}`,
            transactions
        };

        result.push(block as ethers.providers.Block);
    }
    return result;
}

describe("BlockCache", () => {
    const maxDepth = 10;

    it("records a block that was just added", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(1, 0, "main");

        bc.addBlock(blocks[0]);
        expect(blocks[0]).to.deep.include(bc.getBlockStub(blocks[0].hash)!);
    });

    it("minHeight is equal to the initial block height if less then maxDepth blocks are added", () => {
        const bc = new BlockCache(maxDepth);
        const initialHeight = 3;
        const blocks = generateBlocks(maxDepth - 1, initialHeight, "main");
        for (const block of blocks) {
            bc.addBlock(block);
        }

        expect(bc.minHeight).to.equal(initialHeight);
    });

    it("minHeight is equal to the height of the highest added block minus maxDepth if more than maxDepth blocks are added", () => {
        const bc = new BlockCache(maxDepth);
        const initialHeight = 3;
        const blocksAdded = 2 * maxDepth;
        const lastBlockAdded = initialHeight + blocksAdded - 1;
        const blocks = generateBlocks(blocksAdded, initialHeight, "main");
        for (const block of blocks) {
            bc.addBlock(block);
        }

        expect(bc.minHeight).to.equal(lastBlockAdded - maxDepth);
    });

    it("maxHeight is equal to the height of the highest added block", () => {
        const bc = new BlockCache(maxDepth);
        const initialHeight = 3;
        const blocksAdded = 2 * maxDepth;
        const lastBlockAdded = initialHeight + blocksAdded - 1;

        // Add some blocks
        for (const block of generateBlocks(blocksAdded, initialHeight, "main")) {
            bc.addBlock(block);
        }
        // Add a shorter separate chain
        for (const block of generateBlocks(blocksAdded - 1, initialHeight, "forkedchain")) {
            bc.addBlock(block);
        }

        expect(bc.maxHeight).to.equal(lastBlockAdded);
    });

    it("canAddBlock returns true for blocks whose height is lower or equal than the initial height", () => {
        const bc = new BlockCache(maxDepth);

        const blocks = generateBlocks(10, 5, "main");
        const otherBlocks = generateBlocks(10, 5, "other");

        bc.addBlock(blocks[3]);

        expect(bc.canAddBlock(blocks[2])).to.be.true;
        expect(bc.canAddBlock(blocks[3])).to.be.true;
        expect(bc.canAddBlock(otherBlocks[3])).to.be.true;
    });

    it("canAddBlock returns true for blocks whose height is lower or equal than the maximum depth", () => {
        const bc = new BlockCache(maxDepth);
        const initialHeight = 3;
        const blocksAdded = maxDepth + 1;
        const blocks = generateBlocks(blocksAdded, initialHeight, "main");
        for (const block of blocks) {
            bc.addBlock(block);
        }

        const otherBlocks = generateBlocks(2, initialHeight - 1, "main");

        expect(bc.canAddBlock(otherBlocks[0])).to.be.true;
        expect(bc.canAddBlock(otherBlocks[1])).to.be.true;
    });

    it("canAddBlock returns true for a block whose parent is in the BlockCache", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(10, 7, "main");

        bc.addBlock(blocks[5]);

        expect(bc.canAddBlock(blocks[6])).to.be.true;
    });

    it("canAddBlock returns false for a block above minHeight whose parent is not in the BlockCache", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(10, 7, "main");

        bc.addBlock(blocks[0]);
        bc.addBlock(blocks[1]);
        bc.addBlock(blocks[2]);

        expect(bc.canAddBlock(blocks[4])).to.be.false;
    });

    it("records blocks until maximum depth", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(maxDepth, 0, "main");

        for (const block of blocks) {
            bc.addBlock(block);
        }
        expect(blocks[0]).to.deep.include(bc.getBlockStub(blocks[0].hash)!);
    });

    it("forgets blocks past the maximum depth", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(maxDepth + 2, 0, "main"); // head is depth 0, so first pruned is maxDepth + 2

        for (const block of blocks) {
            bc.addBlock(block);
        }

        expect(bc.getBlockStub(blocks[0].hash)).to.equal(null);
    });

    it("getConfirmations correctly computes the number of confirmations for a transaction", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(7, 0, "main"); // must be less blocks than maxDepth

        for (const block of blocks) {
            bc.addBlock(block);
        }
        const headBlock = blocks[blocks.length - 1];
        expect(bc.getConfirmations(headBlock.hash, blocks[0].transactions[0])).to.equal(blocks.length);
        expect(bc.getConfirmations(headBlock.hash, blocks[1].transactions[0])).to.equal(blocks.length - 1);
    });

    it("getConfirmations correctly returns 0 confirmations if transaction is not known", () => {
        const bc = new BlockCache(maxDepth);
        const blocks = generateBlocks(128, 0, "main"); // must be less blocks than maxDepth

        for (const block of blocks) {
            bc.addBlock(block);
        }
        const headBlock = blocks[blocks.length - 1];
        expect(bc.getConfirmations(headBlock.hash, "nonExistingTxHash")).to.equal(0);
    });
});