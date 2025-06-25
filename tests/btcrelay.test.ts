import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../scripts/sui.utils';
import { BitcoinInterface } from '@teleportdao/bitcoin';
import * as fs from 'fs';
import * as path from 'path';
import { revertBytes32, bytesToHex, parseReturnValue, hexToBytes, printEvents, hash256,verifyUpgradeCap,remove0xPrefix } from './utils';
import { BtcRelayFactory } from './test_factory/btcrelay_factory';
import { Keypair } from '@mysten/sui.js/dist/cjs/cryptography';
import { sign } from 'crypto';

const TXCHECK = require('./test_fixtures/blockWithTx.json');
const FORKEDCHAIN = require('./test_fixtures/forkedChain.json');
const REGULAR_CHAIN = require('./test_fixtures/headers.json');
const RETARGET_CHAIN = require('./test_fixtures/headersWithRetarget.json');
const REORG_AND_RETARGET_CHAIN = require('./test_fixtures/headersReorgAndRetarget.json');

describe('BTCRelay Tests for sui', () => {
    console.log('BTCRelay Tests on sui');
    // Initialize SUI client with localnet
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    // Test account setup
    let deployer: Ed25519Keypair;
    const signer1 = Ed25519Keypair.generate();
    const signer2 = Ed25519Keypair.generate();
    
    let packageId: string;
    let relayAdminId: string;
    let upgradeCapId: string;
    let MODULE_NAME = 'btcrelay';
    let zeroAddress = '0x0000000000000000000000000000000000000000000000000000000000000000';
    let bitcoinInterface: any;
    let genesisHeader: string;
    let periodStart: string;
    let btcRelayId: string;

    // Load test block headers
    const jsonPath = path.join(__dirname, './test_fixtures', 'testBlockHeaders.json');
    const blockHeaders = fs.readFileSync(jsonPath, 'utf-8').split('\n');
    const _bitcoinNetwork = {
        name: 'bitcoin',
        connection: {
            api: {
                enabled: true,
                provider: 'BlockStream' as const,
                token: null,
            },
        },
    };
    bitcoinInterface = new BitcoinInterface(
            _bitcoinNetwork.name,
            _bitcoinNetwork.connection
        );
    
    // Genesis configuration
    let genesisHeight = 99 * 2016 + 0 * 63; // 201537
    

    // testing different scenarios
    describe('Initialization', () => {
        // Deploy the package before running tests
        beforeAll(async () => {
            // Initialize package constants after deployment
            genesisHeader = await bitcoinInterface.getBlockHeaderHex(genesisHeight); // block header of 201537
            periodStart = revertBytes32(await bitcoinInterface.getBlockHash(genesisHeight - (genesisHeight % 2016))); // 199584

            const result = await BtcRelayFactory(genesisHeader, -1, periodStart, 3); // we pass -1 as height to indicate that we want to initialize later
            deployer = result.deployer;
            packageId = result.packageId;
            upgradeCapId = result.upgradeCapId;
            relayAdminId = result.relayAdminId;
        }, 60000);

        it('should not allow non-admin to initialize', async () => {
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::initialize`,
                arguments: [
                    tx.pure(genesisHeader),
                    tx.pure(genesisHeight),
                    tx.pure(periodStart),
                    tx.pure(3),
                    tx.object(relayAdminId)
                ]
            });
            
            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer1,
            })).rejects.toThrow();
        });

        it('should initialize BTCRelay with deployer as admin', async () => {
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::initialize`,
                arguments: [
                    tx.pure(genesisHeader),
                    tx.pure(genesisHeight),
                    tx.pure(periodStart),
                    tx.pure(3),
                    tx.object(relayAdminId)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            printEvents(result);
            expect(result.effects?.status?.status).toBe('success');

            // Get the new BTCRelay object ID from the effects
            const createdObjects = result.effects?.created || [];
            const newBtcRelay = createdObjects.find(obj => 
                (obj.owner as any)?.Shared?.initial_shared_version !== undefined
            );

            if (!newBtcRelay) {
                throw new Error('No new BTCRelay object found in transaction effects');
            }

            // Store the BTCRelay object ID for future tests
            btcRelayId = newBtcRelay.reference.objectId;
        });

        it('should have correct parameters after initialization', async () => {
            // Get the BTCRelay object
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            const btcRelay = await client.getObject({
                id: btcRelayId,
                options: { showContent: true }
            });

            if (!btcRelay.data?.content || btcRelay.data.content.dataType !== 'moveObject') {
                throw new Error('No content in BTCRelay object or wrong data type');
            }

            const fields = (btcRelay.data.content as any).fields;

            // Test initial parameters
            expect(fields.initialHeight).toBe(genesisHeight.toString());
            expect(fields.lastSubmittedHeight).toBe(genesisHeight.toString());
            expect(fields.finalizationParameter).toBe('3');
            expect(fields.relayerPercentageFee).toBe('500'); // Default value
            expect(fields.submissionGasUsed).toBe('300000'); // Default value
            expect(fields.epochLength).toBe('2016'); // Bitcoin retarget period
            expect(fields.baseQueries).toBe('2016'); // Default value
            expect(fields.currentEpochQueries).toBe('0');
            expect(fields.lastEpochQueries).toBe('2016'); // Default value
            expect(fields.paused).toBe(false);

            // Test that the genesis hash is set correctly
            const genesisHash = await bitcoinInterface.getBlockHash(genesisHeight);
            expect(bytesToHex(fields.relayGenesisHash)).toBe(revertBytes32(genesisHash));

            // Test that the chain table has the initial block
            expect(fields.chain).toBeDefined();
            expect(fields.previousBlock).toBeDefined();
            expect(fields.blockHeight).toBeDefined();
        });
        
        it('should not allow double initialization', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::initialize`,
                arguments: [
                    tx.pure(genesisHeader),
                    tx.pure(genesisHeight),
                    tx.pure(periodStart),
                    tx.pure(5),
                    tx.object(relayAdminId)
                ]
            });
            
            await expect(async () => {
                await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true }
                });
            }).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*14\)/) // 14 is the error code for EALREADY_INITIALIZED
            });
        });
    }, 60000);

    describe('Submitting block headers', () => {
        it('should submit old block headers', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            
            let startFrom = 0; // upon change, please also change genesisHeight
            // submit block headers up to 100*2016
            for (let i = startFrom; i < 32; i++) {
                let blockHeadersNew = '';
                let blockHeaderOld = '';

                if (i == startFrom) {
                    blockHeaderOld = blockHeaders[startFrom * 63]; // 201537 block header
                    for (let j = 1; j < 63; j++) {
                        // 201537-201599 block headers
                        blockHeadersNew = blockHeadersNew + blockHeaders[j + i*63];
                    }
                } else {
                    blockHeaderOld = blockHeaders[i*63 - 1];
                    for (let j = 0; j < 63; j++) {
                        blockHeadersNew = blockHeadersNew + blockHeaders[j + i*63];
                    }
                }
                blockHeaderOld = blockHeaderOld.replace(/[\r\n]/g, ''); // need to clean up the string 
                blockHeadersNew = blockHeadersNew.replace(/[\r\n]/g, '');

                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId),
                        tx.pure(blockHeaderOld),
                        tx.pure(blockHeadersNew)
                    ]
                });

                let result;
                try {
                    result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                        options: { showEffects: true, showEvents: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                } catch (error) {
                    console.log('\nTransaction Failed:');
                    console.log('Error:', error);

                    throw error; // Re-throw the error to fail the test
                }

                await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            }
        }, 60000); // it takes about 30s to submit 32 block headers
        
        it('should revert a block header with wrong PoW', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            let blockHeaderOld = blockHeaders[2013];
            // below = blockheader[2014] with a different nonce
            let blockHeaderNew = '02000000b9985b54b29f5244d2884e497a68523a6f8a3874dadc1db26804000000000000f3689bc987a63f3d9db84913a4521691b6292d46be11166412a1bb561159098f238e6b508bdb051a6ffb0278';
            blockHeaderOld = blockHeaderOld.replace(/[\r\n]/g, ''); // need to clean up the string 
            blockHeaderNew = blockHeaderNew.replace(/[\r\n]/g, '');
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    tx.object(btcRelayId),
                    tx.pure(blockHeaderOld),
                    tx.pure(blockHeaderNew)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*2\)/) // 2 is the error code for EINVALID_POW
            });
        });

        it('should revert a block header with wrong previous hash', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            let blockHeaderOld = blockHeaders[2013];
            // below = blockheader[2014] with a different previous hash (equal to its own hash)
            let blockHeaderNew = '0200000090750e6782a6a91bf18823869519802e76ee462f462e8fb2cc00000000000000f3689bc987a63f3d9db84913a4521691b6292d46be11166412a1bb561159098f238e6b508bdb051a6ffb0277';
            blockHeaderOld = blockHeaderOld.replace(/[\r\n]/g, ''); // need to clean up the string 
            blockHeaderNew = blockHeaderNew.replace(/[\r\n]/g, '');
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    tx.object(btcRelayId),
                    tx.pure(blockHeaderOld),
                    tx.pure(blockHeaderNew)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*1\)/) // 1 is the error code for EINVALID_CHAIN
            });
        });

        it('should revert when submitting a block header for a new epoch with same target using addHeaders', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            let blockHeaderOld = blockHeaders[2015];
            // block header new has the same target as block header old
            let blockHeaderNew = "010000009d6f4e09d579c93015a83e9081fee83a5c8b1ba3c86516b61f0400000000000025399317bb5c7c4daefe8fe2c4dfac0cea7e4e85913cd667030377240cadfe93a4906b508bdb051a84297df7";
            blockHeaderOld = blockHeaderOld.replace(/[\r\n]/g, ''); // need to clean up the string 
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    tx.object(btcRelayId),
                    tx.pure(blockHeaderOld),
                    tx.pure(blockHeaderNew)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*13\)/) // 13 is the error code for ERETARGET_REQUIRED ( %2016 == 0, need retarget instead)
            });
        });

        it('should submit a block header with new target', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            let newHeight = 100 * 2016;
            let blockHeaderNew = await bitcoinInterface.getBlockHeaderHex(newHeight); // this is the new block header
            let oldPeriodStartHeader = blockHeaders[0];
            let oldPeriodEndHeader = blockHeaders[2015];
            oldPeriodStartHeader = oldPeriodStartHeader.replace(/[\r\n]/g, ''); // need to clean up the string 
            oldPeriodEndHeader = oldPeriodEndHeader.replace(/[\r\n]/g, '');
            blockHeaderNew = blockHeaderNew.replace(/[\r\n]/g, '');
            //console.log(hash256(oldPeriodStartHeader));
            //console.log(hash256(oldPeriodEndHeader));
            //console.log(hash256(blockHeaderNew));
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    tx.object(btcRelayId),
                    tx.pure(oldPeriodStartHeader),
                    tx.pure(oldPeriodEndHeader),
                    tx.pure(blockHeaderNew)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true,showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            // printEvents(result);
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify the block header hash is stored
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId}::${MODULE_NAME}::getBlockHeaderHash`,
                arguments: [
                    verifyTx.object(btcRelayId),
                    verifyTx.pure(newHeight),
                    verifyTx.pure(0)
                ]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer.toSuiAddress()
            });

            const blockHeaderNext = await bitcoinInterface.getBlockHeaderHex(newHeight + 1);
            const currentHash = blockHeaderNext.slice(8, 72);
            const returnedHash = bytesToHex(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || []);
            //console.log(verifyResult.results?.[0]?.returnValues?.[0]?.[0] );
            //console.log(returnedHash);
            expect(returnedHash).toBe(revertBytes32(currentHash));

            // Verify the height is stored correctly
            const heightVerifyTx = new TransactionBlock();
            heightVerifyTx.moveCall({
                target: `${packageId}::${MODULE_NAME}::find_height`,
                arguments: [
                    heightVerifyTx.object(btcRelayId),
                    heightVerifyTx.pure(hexToBytes(currentHash)) // we need to convert uint256 to bytes then pass into the function
                ]
            });

            const heightVerifyResult = await client.devInspectTransactionBlock({
                transactionBlock: heightVerifyTx,
                sender: deployer.toSuiAddress()
            });
            expect(heightVerifyResult.effects?.status?.status).toBe('success');
            expect(parseReturnValue(heightVerifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe(newHeight.toString());
        });
        
    });
    
    describe('Submitting block headers with forks', () => {
        const { bitcoinPeriodStart, bitcoinCash, bitcoin } = FORKEDCHAIN;
        let packageId_ : string;
        let upgradeCapId_ : string;
        let relayAdminId_ : string;
        let btcRelayId_ : string;
        let deployer : Ed25519Keypair;
        beforeEach(async () => {
            // Initialize package constants after deployment
            const forkGenesisHeader = bitcoinCash[0].blockHeader;
            const forkGenesisHeight = bitcoinCash[0].blockNumber;
            const forkPeriodStart = bitcoinPeriodStart.blockHash;

            // Assign returned values to the describe-level variables
            const result = await BtcRelayFactory(forkGenesisHeader, forkGenesisHeight, forkPeriodStart, 3);
            deployer = result.deployer;
            packageId_ = result.packageId;
            upgradeCapId_ = result.upgradeCapId;
            relayAdminId_ = result.relayAdminId;
            btcRelayId_ = result.btcRelayId;
        }, 60000);

        it('should successfully create a fork', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Submit the main fork (first 6 blocks)
            for (let i = 1; i < 7; i++) {
                const tx = new TransactionBlock();
                let prevHeader = bitcoinCash[i - 1].blockHeader
                let currentHeader = bitcoinCash[i].blockHeader
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(prevHeader),
                        tx.pure(currentHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });
                //printEvents(result);
                expect(result.effects?.status?.status).toBe('success');
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            // Submit the second fork (blocks 4-6)
            for (let i = 4; i < 7; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoin[i - 1].blockHeader),
                        tx.pure(bitcoin[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });
                //printEvents(result);
                expect(result.effects?.status?.status).toBe('success');
                expect(result.events?.some(e => e.type.includes('BlockAdded'))).toBe(true);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        },30000);
        
        it('should not be able to submit too old block headers to form a fork', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Submit the main fork (first 8 blocks)
            for (let i = 1; i < 8; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoinCash[i - 1].blockHeader),
                        tx.pure(bitcoinCash[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Try to submit an old block header for a fork
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(bitcoinCash[3].blockHeader),
                    tx.pure(bitcoinCash[4].blockHeader)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*6\)/) // 6 is the error code for EOUTDATE_HEADER
            });
        },30000);
        
        it('should successfully prune the chain', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Submit the main fork
            for (let i = 1; i < 7; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoinCash[i - 1].blockHeader),
                        tx.pure(bitcoinCash[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Submit the second fork
            for (let i = 4; i < 7; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoin[i - 1].blockHeader),
                        tx.pure(bitcoin[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Verify fork exists by checking number of headers at each height
            for (let i = 4; i < 7; i++) {
                const verifyTx = new TransactionBlock();
                verifyTx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::getNumberOfSubmittedHeaders`,
                    arguments: [
                        verifyTx.object(btcRelayId_),
                        verifyTx.pure(bitcoin[i].blockNumber)
                    ]
                });

                const verifyResult = await client.devInspectTransactionBlock({
                    transactionBlock: verifyTx,
                    sender: deployer.toSuiAddress()
                });

                expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('2');
            }

            // Add a block that finalizes the chain
            const finalizeTx = new TransactionBlock();
            finalizeTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    finalizeTx.object(btcRelayId_),
                    finalizeTx.pure(bitcoin[6].blockHeader),
                    finalizeTx.pure(bitcoin[7].blockHeader)
                ]
            });

            const finalizeResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: finalizeTx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            //printEvents(finalizeResult);
            expect(finalizeResult.effects?.status?.status).toBe('success');
            expect(finalizeResult.events?.some(e => e.type.includes('BlockFinalized'))).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 1000));
            // verify no other block header has remained in the same height as the finalized block
            let pruneVerifyTx = new TransactionBlock();
            pruneVerifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::getNumberOfSubmittedHeaders`,
                arguments: [
                    pruneVerifyTx.object(btcRelayId_),
                    pruneVerifyTx.pure(bitcoin[4].blockNumber)
                ]
            });

            let pruneVerifyResult = await client.devInspectTransactionBlock({
                transactionBlock: pruneVerifyTx,
                sender: deployer.toSuiAddress()
            });

            expect(parseReturnValue(pruneVerifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('1');

            // verify one block header belongs to the finalized chain (bitcoin)
            pruneVerifyTx = new TransactionBlock();
            pruneVerifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::getBlockHeaderHash`,
                arguments: [
                    pruneVerifyTx.object(btcRelayId_),
                    pruneVerifyTx.pure(bitcoin[4].blockNumber),
                    pruneVerifyTx.pure(0)
                ]
            });

            pruneVerifyResult = await client.devInspectTransactionBlock({
                transactionBlock: pruneVerifyTx,
                sender: deployer.toSuiAddress()
            });

            const returnedHash = bytesToHex(pruneVerifyResult.results?.[0]?.returnValues?.[0]?.[0] || []);
            expect(returnedHash).toBe(bitcoin[4].blockHash); // bitcoin[4].blockHash is in little endian format
        },30000);

        it('should successfully emit BlockFinalized events', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Submit the main fork (first 2 blocks)
            for (let i = 1; i < 3; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoinCash[i - 1].blockHeader),
                        tx.pure(bitcoinCash[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Submit blocks that should trigger finalization
            for (let i = 3; i < 7; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoinCash[i - 1].blockHeader),
                        tx.pure(bitcoinCash[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                expect(result.events?.some(e => e.type.includes('BlockFinalized'))).toBe(true);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Submit the second fork (should not trigger finalization)
            for (let i = 4; i < 7; i++) {
                const tx = new TransactionBlock();
                tx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                    arguments: [
                        tx.object(btcRelayId_),
                        tx.pure(bitcoin[i - 1].blockHeader),
                        tx.pure(bitcoin[i].blockHeader)
                    ]
                });

                const result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });

                expect(result.effects?.status?.status).toBe('success');
                expect(result.events?.some(e => e.type.includes('BlockFinalized'))).toBe(false);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Submit a new block that should trigger finalization
            const finalizeTx = new TransactionBlock();
            finalizeTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    finalizeTx.object(btcRelayId_),
                    finalizeTx.pure(bitcoin[6].blockHeader),
                    finalizeTx.pure(bitcoin[7].blockHeader)
                ]
            });

            const finalizeResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: finalizeTx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(finalizeResult.effects?.status?.status).toBe('success');
            expect(finalizeResult.events?.some(e => e.type.includes('BlockFinalized'))).toBe(true);
        },30000);
    });

    describe('Unfinalizing a finalized block header', () => {
        // default finalization parameter is 3
        // oldChain = [478558, 478559, 478560, 478561, 478562, 478563]
        // newChain = [478558, 478559", 478560", 478561", 478562", 478563"]
        const periodStart = FORKEDCHAIN.bitcoinPeriodStart;
        const oldChain = FORKEDCHAIN.bitcoinCash;
        const newChain = FORKEDCHAIN.bitcoin;
    
        let btcRelayId_: string;
        let adminId_: string;
        let packageId_: string;
        let upgradeCapId_: string;

        beforeEach(async () => {
            // Initialize package constants after deployment
            const GenesisHeader = oldChain[3].blockHeader;
            const GenesisHeight = oldChain[3].blockNumber;
            const PeriodStart = periodStart.blockHash;

            // Assign returned values to the describe-level variables
            const returnValues = await BtcRelayFactory(GenesisHeader, GenesisHeight, PeriodStart, 3);
            deployer = returnValues.deployer;
            packageId_ = returnValues.packageId;
            upgradeCapId_ = returnValues.upgradeCapId;
            adminId_ = returnValues.relayAdminId;
            btcRelayId_ = returnValues.btcRelayId;

            await new Promise(resolve => setTimeout(resolve, 1000));
            // finalize blocks 478558 and 478559
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(oldChain[3].blockHeader),
                    tx.pure(oldChain[4].blockHeader + oldChain[5].blockHeader + 
                        oldChain[6].blockHeader + oldChain[7].blockHeader)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            expect(result.events?.some(e => e.type.includes('BlockFinalized'))).toBe(true);

            const finalizeEvents = result.events?.filter(
                e => e.type.includes('BlockFinalized')
            ) ?? [];
            
            expect(finalizeEvents.length).toBe(2); // Verify we got both events
            
            // Since we don't know the order of the events, we need to check the height
            const firstEvent = finalizeEvents[0];
            if(firstEvent.parsedJson?.height === "478559") {
                expect(firstEvent.parsedJson?.height).toBe("478559");
                expect(bytesToHex(firstEvent.parsedJson?.self_hash)).toBe(revertBytes32(oldChain[4].blockHash));
                expect(bytesToHex(firstEvent.parsedJson?.parent_hash)).toBe(revertBytes32(oldChain[3].blockHash));
                expect(firstEvent.parsedJson?.relayer).toBe(deployer.toSuiAddress());

                const secondEvent = finalizeEvents[1];
                expect(secondEvent.parsedJson?.height).toBe("478558");
                expect(bytesToHex(secondEvent.parsedJson?.self_hash)).toBe(revertBytes32(oldChain[3].blockHash));
                expect(bytesToHex(secondEvent.parsedJson?.parent_hash)).toBe(revertBytes32(oldChain[2].blockHash));
                expect(secondEvent.parsedJson?.relayer).toBe(deployer.toSuiAddress());
            } else {
                expect(firstEvent.parsedJson?.height).toBe("478558");
                expect(bytesToHex(firstEvent.parsedJson?.self_hash)).toBe(revertBytes32(oldChain[3].blockHash));
                expect(bytesToHex(firstEvent.parsedJson?.parent_hash)).toBe(revertBytes32(oldChain[2].blockHash));
                expect(firstEvent.parsedJson?.relayer).toBe(deployer.toSuiAddress());

                const secondEvent = finalizeEvents[1];
                expect(secondEvent.parsedJson?.height).toBe("478559");
                expect(bytesToHex(secondEvent.parsedJson?.self_hash)).toBe(revertBytes32(oldChain[4].blockHash));
                expect(bytesToHex(secondEvent.parsedJson?.parent_hash)).toBe(revertBytes32(oldChain[3].blockHash));
                expect(secondEvent.parsedJson?.relayer).toBe(deployer.toSuiAddress());
            }

        });
    
        it('unfinalize block 478559 and finalize block 478559"', async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            // pause relay
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(adminId_)
                ]
            });
    
            await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            // increase finalization parameter from 3 to 4
            const setParamTx = new TransactionBlock();
            setParamTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::setFinalizationParameter`,
                arguments: [
                    setParamTx.object(btcRelayId_),
                    setParamTx.pure(4),
                    setParamTx.object(adminId_)
                ]
            });
    
            await client.signAndExecuteTransactionBlock({
                transactionBlock: setParamTx,
                signer: deployer,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // submit new blocks [478559", 478560", 478561", 478562", 478563"] and finalize 478559"
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(oldChain[3].blockHeader),
                    addHeadersTx.pure(newChain[4].blockHeader + newChain[5].blockHeader + 
                        newChain[6].blockHeader + newChain[7].blockHeader + newChain[8].blockHeader),
                    addHeadersTx.object(adminId_)
                ]
            });
    
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            //printEvents(result);
            expect(result.effects?.status?.status).toBe('success');
            expect(result.events?.some(e => e.type.includes('BlockFinalized'))).toBe(true);
            const finalizeEvents = result.events?.filter(
                e => e.type.includes('BlockFinalized')
            ) ?? [];
            // travser the finalizeEvents and check the height
            for(const event of finalizeEvents) {
                if(event.parsedJson?.height === "478559") {
                    expect(event.parsedJson?.height).toBe("478559");
                    expect(bytesToHex(event.parsedJson?.self_hash)).toBe(revertBytes32(newChain[4].blockHash));
                    expect(bytesToHex(event.parsedJson?.parent_hash)).toBe(revertBytes32(newChain[3].blockHash));
                    expect(event.parsedJson?.relayer).toBe(deployer.toSuiAddress());
                }
            }
        
            
            // check that 478559 is removed and 478559" is added
            const findHeightTx = new TransactionBlock();
            findHeightTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::find_height`,
                arguments: [
                    findHeightTx.object(btcRelayId_),
                    findHeightTx.pure(hexToBytes(revertBytes32(oldChain[4].blockHash)))
                ]
            });

            const findHeightResult = await client.devInspectTransactionBlock({
                transactionBlock: findHeightTx,
                sender: deployer.toSuiAddress()
            })
            // This should fail as the block is removed
            expect(findHeightResult.effects?.status?.status).toBe('failure');
            expect(findHeightResult.effects?.status?.error).toMatch(
                /MoveAbort.*btcrelay.*find_height.*15/
            );
            await new Promise(resolve => setTimeout(resolve, 500));

            // Check new block exists
            const findHeightTx2 = new TransactionBlock();
            findHeightTx2.moveCall({
                target: `${packageId_}::${MODULE_NAME}::find_height`,
                arguments: [
                    findHeightTx2.object(btcRelayId_),
                    findHeightTx2.pure(hexToBytes(revertBytes32(newChain[4].blockHash)))
                ]
            });
    
            const result2 = await client.devInspectTransactionBlock({
                transactionBlock: findHeightTx2,
                sender: deployer.toSuiAddress()
            });
            expect(result2.effects?.status?.status).toBe('success');
            expect(parseReturnValue(result2.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('478559');
            
        });
    });

    describe('Check tx inclusion', () => {
        const { block, transaction } = TXCHECK;
        // the block height is 201597
        let packageId_ : string;
        let upgradeCapId_ : string;
        let relayAdminId_ : string;
        let btcRelayId_ : string;
        let deployer : Ed25519Keypair;
        beforeAll(async () => {
            let genesisHeight_ = 201537;
            let genesisHeader_ = await bitcoinInterface.getBlockHeaderHex(genesisHeight_);
            let periodStart_ = revertBytes32(await bitcoinInterface.getBlockHash(genesisHeight_ - (genesisHeight_ % 2016))); 
           
            // Assign returned values to the describe-level variables
            let result = await BtcRelayFactory(genesisHeader_, genesisHeight_, periodStart_, 3);
            deployer = result.deployer;
            packageId_ = result.packageId;
            upgradeCapId_ = result.upgradeCapId;
            relayAdminId_ = result.relayAdminId;
            btcRelayId_ = result.btcRelayId;
            await new Promise(resolve => setTimeout(resolve, 500));

            let startFrom = 31; 
            // submit block headers up to 100*2016
            let blockHeadersNew = '';
            let blockHeaderOld = '';

            blockHeaderOld = blockHeaders[startFrom * 63]; 
            for (let j = 1; j < 63; j++) {
                blockHeadersNew = blockHeadersNew + blockHeaders[j + startFrom*63];
            }
            
            blockHeaderOld = blockHeaderOld.replace(/[\r\n]/g, ''); // need to clean up the string 
            blockHeadersNew = blockHeadersNew.replace(/[\r\n]/g, '');

            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(blockHeaderOld),
                    tx.pure(blockHeadersNew)
                ]
            });

            let AddblockerResult;
            try {
                AddblockerResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });
                expect(AddblockerResult.effects?.status?.status).toBe('success');
            } catch (error) {
                console.log('\nTransaction Failed:');
                console.log('Error:', error);

                throw error; // Re-throw the error to fail the test
            }

            await new Promise(resolve => setTimeout(resolve, 500));

            // Then add 201600 as the target block header
            let newHeight = 100 * 2016;
            let blockHeaderNew = await bitcoinInterface.getBlockHeaderHex(newHeight); // this is the new block header
            let oldPeriodStartHeader = blockHeaders[0];
            let oldPeriodEndHeader = blockHeaders[2015];

            oldPeriodStartHeader = oldPeriodStartHeader.replace(/[\r\n]/g, ''); // need to clean up the string 
            oldPeriodEndHeader = oldPeriodEndHeader.replace(/[\r\n]/g, '');
            blockHeaderNew = blockHeaderNew.replace(/[\r\n]/g, '');

            let targetTx = new TransactionBlock();
            targetTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    targetTx.object(btcRelayId_),
                    targetTx.pure(oldPeriodStartHeader),
                    targetTx.pure(oldPeriodEndHeader),
                    targetTx.pure(blockHeaderNew)
                ]
            });

            const targetResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: targetTx,
                signer: deployer,
                options: { showEffects: true,showEvents: true }
            });
            //printEvents(targetResult);
            expect(targetResult.effects?.status?.status).toBe('success');
        }, 60000);
        it('errors if the smart contract is paused', async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            const _height = block.height;

            // pause the relay
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(relayAdminId_)
                ]
            });

            let pasueResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer,
                options: { showEffects: true ,showEvents: true}
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            // Try to check tx proof while paused
            const checkTxTx = new TransactionBlock();
            checkTxTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::checkTxProof`,
                arguments: [
                    checkTxTx.object(btcRelayId_),
                    checkTxTx.pure(remove0xPrefix(transaction.tx_id)),
                    checkTxTx.pure(_height),
                    checkTxTx.pure(remove0xPrefix(transaction.intermediate_nodes)),
                    checkTxTx.pure(transaction.index)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: checkTxTx,
                sender: deployer.toSuiAddress()
            });

            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*btcrelay.*7/);// 7 is the error code for paused

            // unpause the relay
            const unpauseTx = new TransactionBlock();
            unpauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::unpause_relay`,
                arguments: [
                    unpauseTx.object(btcRelayId_),
                    unpauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: unpauseTx,
                signer: deployer,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
        });
        
        it('transaction id should be non-zero', async () => {
            const _height = block.height;
            const zeroTxId = "0x0000000000000000000000000000000000000000000000000000000000000000";

            const checkTxTx = new TransactionBlock();
            checkTxTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::checkTxProof`,
                arguments: [
                    checkTxTx.object(btcRelayId_),
                    checkTxTx.pure(remove0xPrefix(zeroTxId)),
                    checkTxTx.pure(_height),
                    checkTxTx.pure(remove0xPrefix(transaction.intermediate_nodes)),
                    checkTxTx.pure(transaction.index)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: checkTxTx,
                sender: deployer.toSuiAddress(),
                options: { showEffects: true,showEvents: true }   
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*btcrelay.*8/); // 8 is the error code for invalid txid
        });
        
        it('errors if the requested block header is not on the relay (it is too old)', async () => {
            const _height = block.height - 100;

            const checkTxTx = new TransactionBlock();
            checkTxTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::checkTxProof`,
                arguments: [
                    checkTxTx.object(btcRelayId_),
                    checkTxTx.pure(remove0xPrefix(transaction.tx_id)),
                    checkTxTx.pure(_height),
                    checkTxTx.pure(remove0xPrefix(transaction.intermediate_nodes)),
                    checkTxTx.pure(transaction.index)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: checkTxTx,
                sender: deployer.toSuiAddress(),
                options: { showEffects: true,showEvents: true }
            });
            printEvents(result);
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*btcrelay.*10/); // 10 is the error code for outdate block
        });

        it('check transaction inclusion -> when included', async () => {
            const _height = block.height;

            const checkTxTx = new TransactionBlock();
            checkTxTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::checkTxProof`,
                arguments: [
                    checkTxTx.object(btcRelayId_),
                    checkTxTx.pure(remove0xPrefix(transaction.tx_id)),
                    checkTxTx.pure(_height),
                    checkTxTx.pure(remove0xPrefix(transaction.intermediate_nodes)),
                    checkTxTx.pure(transaction.index)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: checkTxTx,
                sender: deployer.toSuiAddress(),
                options: { showEffects: true,showEvents: true }
            });
            printEvents(result);
            expect(result.effects?.status?.status).toBe('success');
            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe("1");
        });

        it('check transaction inclusion -> when not included', async () => {
            const _height = block.height - 1;

            const checkTxTx = new TransactionBlock();
            checkTxTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::checkTxProof`,
                arguments: [
                    checkTxTx.object(btcRelayId_),
                    checkTxTx.pure(remove0xPrefix(transaction.tx_id)),
                    checkTxTx.pure(_height),
                    checkTxTx.pure(remove0xPrefix(transaction.intermediate_nodes)),
                    checkTxTx.pure(transaction.index)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: checkTxTx,
                sender: deployer.toSuiAddress()
            });

            expect(result.effects?.status?.status).toBe('success');
            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe("0");
        });

        it("reverts when tx's block is not finalized", async () => {
            const _height = block.height + 1;

            const checkTxTx = new TransactionBlock();
            checkTxTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::checkTxProof`,
                arguments: [
                    checkTxTx.object(btcRelayId_),
                    checkTxTx.pure(remove0xPrefix(transaction.tx_id)),
                    checkTxTx.pure(_height),
                    checkTxTx.pure(remove0xPrefix(transaction.intermediate_nodes)),
                    checkTxTx.pure(transaction.index)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: checkTxTx,
                sender: deployer.toSuiAddress()
            });

            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*btcrelay.*9/);
        });
        
    });

    // =====testing functions ======
    describe('Admin Operations', () => {
        // Deploy the package before running tests
        let btcRelayId_: string;
        let packageId_: string;
        let relayAdminId_: string;
        let deployer_: Ed25519Keypair;
        let upgradeCapId_: string;
        beforeAll(async () => {
            // Initialize package constants after deployment
            let genesisHeight_ = 201537;
            let genesisHeader_ = await bitcoinInterface.getBlockHeaderHex(genesisHeight_); // block header of 201537
            let periodStart_ = revertBytes32(await bitcoinInterface.getBlockHash(genesisHeight_ - (genesisHeight_ % 2016))); // 199584

            const result = await BtcRelayFactory(genesisHeader_, genesisHeight_, periodStart_, 3); // we pass -1 as height to indicate that we want to initialize later
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            relayAdminId_ = result.relayAdminId;
            deployer_ = result.deployer;
            upgradeCapId_ = result.upgradeCapId;
        }, 60000);
        it('should allow admin to set finalization parameter', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::setFinalizationParameter`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(5),
                    tx.object(relayAdminId_)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer_,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            expect(result.effects?.status?.status).toBe('success');

            // Verify using view function
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::finalizationParameter`,
                arguments: [verifyTx.object(btcRelayId_)]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('5');
        });

        it('should allow admin to set relayer percentage fee', async () => {
            
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::set_relayer_percentage_fee`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(600),
                    tx.object(relayAdminId_)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify using view function
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::relayerPercentageFee`,
                arguments: [verifyTx.object(btcRelayId_)]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('600');
        });

        it('should allow admin to set epoch length', async () => {
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::set_epoch_length`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(2017),
                    tx.object(relayAdminId_)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify using view function
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::epochLength`,
                arguments: [verifyTx.object(btcRelayId_)]
            });

            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('2017');
        });

        it('should allow admin to set base queries', async () => {
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::set_base_queries`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(2017),
                    tx.object(relayAdminId_)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(result.effects?.status?.status).toBe('success');

            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify using view function
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::baseQueries`,
                arguments: [verifyTx.object(btcRelayId_)]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('2017');
        });

        it('should allow admin to set submission gas used', async () => {
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::set_submission_gas_used`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(400000),
                    tx.object(relayAdminId_)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify using view function
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::submissionGasUsed`,
                arguments: [verifyTx.object(btcRelayId_)]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('400000');
        });

        it('should allow admin to pause and unpause relay', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            // First pause
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(relayAdminId_)
                ]
            });
            
            const pauseResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(pauseResult.effects?.status?.status).toBe('success');

            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify pause state is true by checking the object
            const btcRelayAfterPause = await client.getObject({
                id: btcRelayId_,
                options: { showContent: true }
            });

            if (!btcRelayAfterPause.data?.content || btcRelayAfterPause.data.content.dataType !== 'moveObject') {
                throw new Error('No content in BTCRelay object or wrong data type');
            }

            const fieldsAfterPause = (btcRelayAfterPause.data.content as any).fields;
            expect(fieldsAfterPause.paused).toBe(true);

            // Then unpause
            const unpauseTx = new TransactionBlock();
            unpauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::unpause_relay`,
                arguments: [
                    unpauseTx.object(btcRelayId_),
                    unpauseTx.object(relayAdminId_)
                ]
            });
            
            const unpauseResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: unpauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(unpauseResult.effects?.status?.status).toBe('success');

            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed

            // Verify pause state is false by checking the object
            const btcRelayAfterUnpause = await client.getObject({
                id: btcRelayId_,
                options: { showContent: true }
            });

            if (!btcRelayAfterUnpause.data?.content || btcRelayAfterUnpause.data.content.dataType !== 'moveObject') {
                throw new Error('No content in BTCRelay object or wrong data type');
            }

            const fieldsAfterUnpause = (btcRelayAfterUnpause.data.content as any).fields;
            expect(fieldsAfterUnpause.paused).toBe(false);
        });

        it('should allow admin to renounce ownership', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            const tx = new TransactionBlock();
            
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::renounce_admin_ownership`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.object(relayAdminId_)
                ]
            });
            
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer_,
                options: { showEffects: true }
            });
            
            expect(result.effects?.status?.status).toBe('success');
        });
    });

    describe('View Functions and Getters', () => {
        // Deploy the package before running tests
        let btcRelayId_: string;
        let packageId_: string;
        let relayAdminId_: string;
        let genesisHeight_ = 201537;
        let deployer_: Ed25519Keypair;
        beforeAll(async () => {
            // Initialize package constants after deployment
            
            let genesisHeader_ = await bitcoinInterface.getBlockHeaderHex(genesisHeight_); // block header of 201537
            let periodStart_ = revertBytes32(await bitcoinInterface.getBlockHash(genesisHeight_ - (genesisHeight_ % 2016))); // 199584

            const result = await BtcRelayFactory(genesisHeader_, genesisHeight_, periodStart_, 3); // we pass -1 as height to indicate that we want to initialize later
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            relayAdminId_ = result.relayAdminId;
            deployer_ = result.deployer;
        }, 60000);
        it('should return correct genesis hash', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::relayGenesisHash`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            const genesisHash = await bitcoinInterface.getBlockHash(genesisHeight_);
            expect(bytesToHex(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe(revertBytes32(genesisHash));
        });

        it('should return correct initial height', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::initialHeight`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe(genesisHeight_.toString());
        });

        it('should return correct last submitted height', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::lastSubmittedHeight`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe(genesisHeight_.toString());
        });

        it('should return correct finalization parameter', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::finalizationParameter`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('3');
        });

        it('should return correct relayer percentage fee', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::relayerPercentageFee`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('500');
        });

        it('should return correct epoch length', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::epochLength`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('2016');
        });

        it('should return correct base queries', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::baseQueries`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('2016');
        });

        it('should return correct current epoch queries', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::currentEpochQueries`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('0');
        });

        it('should return correct last epoch queries', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::lastEpochQueries`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('2016');
        });

        it('should return correct submission gas used', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::submissionGasUsed`,
                arguments: [tx.object(btcRelayId_)]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('300000');
        });

        it('should return correct block header hash', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::getBlockHeaderHash`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(genesisHeight_),
                    tx.pure(0)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            const genesisHash = await bitcoinInterface.getBlockHash(genesisHeight_);
            const returnedHash = bytesToHex(result.results?.[0]?.returnValues?.[0]?.[0] || []);
            expect(returnedHash).toBe(genesisHash);
        });

        it('should return correct number of submitted headers', async () => {
            const tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::getNumberOfSubmittedHeaders`,
                arguments: [
                    tx.object(btcRelayId_),
                    tx.pure(genesisHeight_)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe('1');
        });
    });

    describe('addHeaders', () => {
        
        const { chain_header_hex, chain, genesis, orphan_562630 } = REGULAR_CHAIN;
        let headers = chain_header_hex.slice(0, 6).map(hex => remove0xPrefix(hex)).join('');
        headers = headers.replace(/[\r\n]/g, ''); // need to clean up the string 
        //console.log(headers);
        let btcRelayId_: string;
        let packageId_: string;
        let deployer_: Ed25519Keypair;
        let relayAdminId_: string;

        beforeAll(async () => {
            // Deploy and initialize the relay
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                genesis.height,
                remove0xPrefix(orphan_562630.digest_le),
                200
            );
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            deployer_ = result.deployer;
            relayAdminId_ = result.relayAdminId;
        });

        it('errors if the smart contract is paused', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            // Pause the relay
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed

            // Try to add headers while paused
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure('0x00'),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*7/) // 7 is the error code for paused
            });

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const unpauseTx = new TransactionBlock();
            unpauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::unpause_relay`,
                arguments: [
                    unpauseTx.object(btcRelayId_),
                    unpauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: unpauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });
        });

        it('errors if the anchor is unknown', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const addHeadersTx = new TransactionBlock();
            //console.log(headers.length);
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure('0x00'),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true ,showEvents: true}
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*0/) // 0 is the error code for invalid archor/header
            });

        });

        it('errors if the header array is not a multiple of 80 bytes', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const badHeaders = headers.substring(0, 8 + 5 * 160);
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(badHeaders)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*0/) // 0 is the error code for invalid header
            });
        });

        it('errors if a prevhash link is broken', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const badHeaders = headers + chain[15].hex;
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(remove0xPrefix(badHeaders))
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*1/) // 1 is the error code for invalid chain
            });
        });
        it('errors if a header work is too low', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const badHeaders = headers + '00'.repeat(80);
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(badHeaders)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*2/) // 2 is the error code for invalid PoW
            });
        });

        it('errors if the target changes mid-chain', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const badHeaders = headers + REGULAR_CHAIN.badHeader.hex;
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(remove0xPrefix(badHeaders))
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*4/) // 4 is the error code for invalid target
            });
        });
        it('appends new links to the chain and fires an event', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            printEvents(result)
            expect(result.events?.some(e => e.type.includes('BlockAdded'))).toBe(true);
        });

        

    });


    describe('addHeadersWithRetarget', () => {
        const { chain, chain_header_hex } = RETARGET_CHAIN;
        const headerHex = chain_header_hex;
        const genesis = chain[1];
        const firstHeader = RETARGET_CHAIN.oldPeriodStart;
        const lastHeader = chain[8];
        const preChange = chain_header_hex.slice(2, 9).map(hex => remove0xPrefix(hex)).join('');
        const headers = chain_header_hex.slice(9, 15).map(hex => remove0xPrefix(hex)).join('');

        let btcRelayId_: string;
        let packageId_: string;
        let deployer_: Ed25519Keypair;
        let relayAdminId_: string;

        beforeAll(async () => {
            // Deploy and initialize the relay
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                genesis.height,
                remove0xPrefix(firstHeader.digest_le),
                200
            );
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            deployer_ = result.deployer;
            relayAdminId_ = result.relayAdminId;

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            // Add pre-change headers
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(preChange)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            });
        });
        
        it('errors if the smart contract is paused', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            // Pause the relay
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            // Try to add headers with retarget while paused
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure('0x00'),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*7/) // 7 is the error code for paused
            });

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const unpauseTx = new TransactionBlock();
            unpauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::unpause_relay`,
                arguments: [
                    unpauseTx.object(btcRelayId_),
                    unpauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: unpauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
        });

        it('errors if the old period start header is unknown', async () => {
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure('0x00'),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*0/) // 0 is the error code for invalid header
            });
        });

        it('errors if the old period end header is unknown', async () => {
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(chain[15].hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*1/) // 1 is the error code for invalid chain
            });
        });

        it('errors if the provided last header does not match records', async () => {
            const addHeadersTx = new TransactionBlock();

            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*0/) // 0 is the error code for invalid header
            });
        });

        it('errors if the start and end headers are not exactly 2015 blocks apart', async () => {
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*0/) // 0 is the error code for invalid header, should be %2016==0
            });
        });
        
        it('errors if the retarget is performed incorrectly', async () => {
            // Deploy a new instance with incorrect height
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                lastHeader.height, // This is incorrect
                remove0xPrefix(firstHeader.digest_le),
                3
            );
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${result.packageId}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(result.btcRelayId),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: result.deployer,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*4/) // 4 is the error code for invalid target
            });
        });
        
        it('appends new links to the chain', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true, showEvents: true }
            });
            printEvents(result)
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            // Verify the height
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::find_height`,
                arguments: [
                    verifyTx.object(btcRelayId_),
                    verifyTx.pure(hexToBytes(remove0xPrefix(chain[10].digest_le)))
                ]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe((lastHeader.height + 2).toString());
        });
    });

    describe('getBlockHeaderHash', () => {
        const { chain, genesis, orphan_562630 } = REGULAR_CHAIN;
        let btcRelayId_: string;
        let packageId_: string;
        let deployer_: Ed25519Keypair;
        beforeEach(async () => {
            // Deploy and initialize the relay
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                genesis.height,
                remove0xPrefix(orphan_562630.digest_le),
                200
            );
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            deployer_ = result.deployer;
        });

        it('views the hash correctly', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 0.5s until the previous transaction is processed
            const header = chain[0].hex;
            
            // Add headers
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(remove0xPrefix(header))
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 0.5s until the previous transaction is processed
            // Get block header hash
            const getHashTx = new TransactionBlock();
            getHashTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::getBlockHeaderHash`,
                arguments: [
                    getHashTx.object(btcRelayId_),
                    getHashTx.pure(chain[0].height),
                    getHashTx.pure(0)
                ]
            });

            const result = await client.devInspectTransactionBlock({
                transactionBlock: getHashTx,
                sender: deployer_.toSuiAddress()
            });

            expect(bytesToHex(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe(revertBytes32(remove0xPrefix(chain[0].digest_le)));
        });
    });

    describe('findHeight', () => {
        const { genesis, chain, chain_header_hex, oldPeriodStart } = REGULAR_CHAIN;
        const headers = chain_header_hex.slice(0, 6).map(hex => remove0xPrefix(hex)).join('');

        let btcRelayId_: string;
        let packageId_: string;
        let deployer_: Ed25519Keypair;

        beforeAll(async () => {
            // Deploy and initialize the relay
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                genesis.height,
                remove0xPrefix(oldPeriodStart.digest_le),
                200
            );
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            deployer_ = result.deployer;

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // Add headers
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::addHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(headers)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            });
        });

        it('errors on unknown blocks', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            const findHeightTx = new TransactionBlock();
            findHeightTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::find_height`,
                arguments: [
                    findHeightTx.object(btcRelayId_),
                    findHeightTx.pure(hexToBytes('0'.repeat(64))) // 32 bytes of zeros
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: findHeightTx,
                signer: deployer_,
                options: { showEffects: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*15/) // 15 is the error code for invalid hash
            });
        });

        it('finds height of known blocks', async () => {
            // Since there's only 6 blocks added
            for (let i = 1; i < 6; i++) {
                const { digest_le, height } = chain[i];
                
                await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
                const findHeightTx = new TransactionBlock();
                findHeightTx.moveCall({
                    target: `${packageId_}::${MODULE_NAME}::find_height`,
                    arguments: [
                        findHeightTx.object(btcRelayId_),
                        findHeightTx.pure(hexToBytes(remove0xPrefix(digest_le)))
                    ]
                });

                const result = await client.devInspectTransactionBlock({
                    transactionBlock: findHeightTx,
                    sender: deployer_.toSuiAddress()
                });

                expect(parseReturnValue(result.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe(height.toString());
            }
        });
    });

    describe('ownerAddHeaders', () => {
        const { chain_header_hex, chain, genesis, orphan_562630 } = REGULAR_CHAIN;
        const headers = chain_header_hex.slice(0, 6).map(hex => remove0xPrefix(hex)).join('');

        let btcRelayId_: string;
        let packageId_: string;
        let deployer_: Ed25519Keypair;
        let relayAdminId_: string;

        beforeEach(async () => {
            // Deploy and initialize the relay
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                genesis.height,
                remove0xPrefix(orphan_562630.digest_le),
                200
            );
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            deployer_ = result.deployer;
            relayAdminId_ = result.relayAdminId;
        });

        it('appends new links to the chain and fires an event', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(headers),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            expect(result.events?.some(e => e.type.includes('BlockAdded'))).toBe(true);
        });

        it('only owner can call it', async () => {
            await transferSuiToSigners(1000000000, deployer_);
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            const nonOwner = signer1;
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(headers),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: nonOwner,
                options: { showEffects: true }
            })).rejects.toThrow(); // this will auto fail because relayAdmin object is not owned by the nonOwner
        });

        it('can be called even when the relay is paused', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // First pause the relay
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // Then try to add headers
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(headers),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            expect(result.events?.some(e => e.type.includes('BlockAdded'))).toBe(true);
        });
    });

    describe('ownerAddHeadersWithRetarget', () => {
        const { chain, chain_header_hex } = RETARGET_CHAIN;
        const genesis = chain[1];
        const firstHeader = RETARGET_CHAIN.oldPeriodStart;
        const lastHeader = chain[8];
        const preChange = chain_header_hex.slice(2, 9).map(hex => remove0xPrefix(hex)).join('');
        const headers = chain_header_hex.slice(9, 15).map(hex => remove0xPrefix(hex)).join('');

        let btcRelayId_: string;
        let packageId_: string;
        let deployer_: Ed25519Keypair;
        let relayAdminId_: string;

        beforeEach(async () => {
            // Deploy and initialize the relay
            const result = await BtcRelayFactory(
                remove0xPrefix(genesis.hex),
                genesis.height,
                remove0xPrefix(firstHeader.digest_le),
                200
            );
            btcRelayId_ = result.btcRelayId;
            packageId_ = result.packageId;
            deployer_ = result.deployer;
            relayAdminId_ = result.relayAdminId;

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed

            // Add pre-change headers
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeaders`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(genesis.hex)),
                    addHeadersTx.pure(preChange),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true }
            });
        });

        it('appends new links to the chain and fires an event', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1s until the previous transaction is processed
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            expect(result.events?.some(e => e.type.includes('BlockAdded'))).toBe(true);

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // Verify the height
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::find_height`,
                arguments: [
                    verifyTx.object(btcRelayId_),
                    verifyTx.pure(hexToBytes(remove0xPrefix(chain[10].digest_le)))
                ]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe((lastHeader.height + 2).toString());
        });

        it('only owner can call it', async () => {
            await transferSuiToSigners(1000000000, deployer_);
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            const nonOwner = signer1;
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: nonOwner,
                options: { showEffects: true }
            })).rejects.toThrow(); // this will auto fail because relayAdmin object is not owned by the nonOwner
        });

        it('can be called even when the relay is paused', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // First pause the relay
            const pauseTx = new TransactionBlock();
            pauseTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::pause_relay`,
                arguments: [
                    pauseTx.object(btcRelayId_),
                    pauseTx.object(relayAdminId_)
                ]
            });

            await client.signAndExecuteTransactionBlock({
                transactionBlock: pauseTx,
                signer: deployer_,
                options: { showEffects: true }
            });

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // Then try to add headers with retarget
            const addHeadersTx = new TransactionBlock();
            addHeadersTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::ownerAddHeadersWithRetarget`,
                arguments: [
                    addHeadersTx.object(btcRelayId_),
                    addHeadersTx.pure(remove0xPrefix(firstHeader.hex)),
                    addHeadersTx.pure(remove0xPrefix(lastHeader.hex)),
                    addHeadersTx.pure(headers),
                    addHeadersTx.object(relayAdminId_)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: addHeadersTx,
                signer: deployer_,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            expect(result.events?.some(e => e.type.includes('BlockAdded'))).toBe(true);

            await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed
            // Verify the height
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
                target: `${packageId_}::${MODULE_NAME}::find_height`,
                arguments: [
                    verifyTx.object(btcRelayId_),
                    verifyTx.pure(hexToBytes(remove0xPrefix(chain[10].digest_le)))
                ]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
                sender: deployer_.toSuiAddress()
            });

            expect(parseReturnValue(verifyResult.results?.[0]?.returnValues?.[0]?.[0] || [])).toBe((lastHeader.height + 2).toString());
        });
    });

    // Function to transfer SUI coins to test signers
    async function transferSuiToSigners(amount: number, deployer: Ed25519Keypair) {
        // First, request coins from faucet for the deployer if needed
        const { data: deployerGasObjects } = await client.getOwnedObjects({
            owner: deployer.toSuiAddress(),
            filter: { MatchAll: [{ StructType: '0x2::coin::Coin<0x2::sui::SUI>' }] },
            options: { showContent: true, showType: true }
        });

        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for transaction to be processed

        // Split gas for signer1
        const splitTx1 = new TransactionBlock();
        const [coin1] = splitTx1.splitCoins(splitTx1.gas, [splitTx1.pure(amount)]);
        splitTx1.transferObjects([coin1], splitTx1.pure(signer1.toSuiAddress()));
        splitTx1.setGasBudget(amount);

        await client.signAndExecuteTransactionBlock({
            transactionBlock: splitTx1,
            signer: deployer,
            options: { showEffects: true }
        });

        await new Promise(resolve => setTimeout(resolve, 500)); // wait for 1s until the previous transaction is processed

    }
});