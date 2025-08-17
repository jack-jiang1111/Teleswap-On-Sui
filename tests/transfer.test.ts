import { SuiClient } from '@mysten/sui.js/client';
import { getFullnodeUrl } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { beforeAll, describe, expect, test, it } from "vitest";
import { CCTransferFactory } from "./test_factory/cc_transfer_factory";
import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { getActiveKeypair } from "../scripts/sui.utils";
import { callMoveFunction, pure, object } from "./utils/move-helper";
import { hexToBytes,printEvents } from './utils/utils';
const CC_REQUESTS = require('./test_fixtures/ccTransferRequests.json');

// Shared variables and setup
describe('CCTransfer Test Suite', () => {
    // Declare variables to store the factory results
    let ccTransferRouterPackageId: string;
    let ccTransferRouterAdminId: string;
    let ccTransferRouterId: string;
    
    let telebtcCapId: string;
    let telebtcTreasuryCapId: string;
    let telebtcAdminId: string;

    let btcrelayPackageId: string;
    let btcrelayCapId: string;
    let btcrelayAdminId: string;
    
    let lockerCapabilityId: string;
    let deployer: Ed25519Keypair;
    let deployerAddress: string;
    let TELEPORTER_ADDRESS: string;

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000001";
    let TWO_ADDRESS = "0x0000000000000000000000000000000000000002";
    const CHAIN_ID = 1;
    const APP_ID = 1;
    const PROTOCOL_PERCENTAGE_FEE = 20; // Means %0.2
    const LOCKER_PERCENTAGE_FEE = 10; // Means %0.1
    const PRICE_WITH_DISCOUNT_RATIO = 9500; // Means %95
    
    const STARTING_BLOCK_NUMBER = 100;
    const TREASURY =       "0x0000000000000000000000000000000000000000000000000000000000000002"; // Valid Sui address
    const LOCKER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000003"; // example locker address
    const RECEIVER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000004"; // example receiver address
    let LOCKER1_LOCKING_SCRIPT = '0xa9144062c8aeed4f81c2d73ff854a2957021191e20b687';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 1; // P2PKH

    let collateralRatio = 20000;
    let liquidationRatio = 15000;

    // Helper function to get initial balances
    async function getInitialBalances(): Promise<{
        recipientBalance: number;
        teleporterBalance: number;
        treasuryBalance: number;
        lockerBalance: number;
    }> {
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });

        const recipientBalance = await client.getBalance({
            owner: CC_REQUESTS.normalCCTransfer.recipientAddress,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        const teleporterBalance = await client.getBalance({
            owner: deployerAddress,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        const treasuryBalance = await client.getBalance({
            owner: TREASURY,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        const lockerBalance = await client.getBalance({
            owner: LOCKER_ADDRESS,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        return {
            recipientBalance: Number(recipientBalance.totalBalance),
            teleporterBalance: Number(teleporterBalance.totalBalance),
            treasuryBalance: Number(treasuryBalance.totalBalance),
            lockerBalance: Number(lockerBalance.totalBalance)
        };
    }

    // Helper function to check fees and balances
    async function checkFees(
        recipientAddress: string,
        receivedAmount: number,
        teleporterFee: number,
        protocolFee: number,
        lockerFee: number,
        initialBalances: {
            recipientBalance: number;
            teleporterBalance: number;
            treasuryBalance: number;
            lockerBalance: number;
        }
    ): Promise<void> {
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });

        // Get current balances
        const recipientBalance = await client.getBalance({
            owner: recipientAddress,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        const teleporterBalance = await client.getBalance({
            owner: deployerAddress,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        const treasuryBalance = await client.getBalance({
            owner: TREASURY,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        const lockerBalance = await client.getBalance({
            owner: LOCKER_ADDRESS,
            coinType: `${ccTransferRouterPackageId}::telebtc::TELEBTC`
        });

        // Check balance changes
        expect(Number(recipientBalance.totalBalance) - initialBalances.recipientBalance).toBe(receivedAmount);
        expect(Number(teleporterBalance.totalBalance) - initialBalances.teleporterBalance).toBe(teleporterFee);
        expect(Number(treasuryBalance.totalBalance) - initialBalances.treasuryBalance).toBe(protocolFee);
        expect(Number(lockerBalance.totalBalance) - initialBalances.lockerBalance).toBe(lockerFee);
    }

    // set mock return for btcrelay (checkTxProof function)
    async function setRelayReturn(isTrue: boolean): Promise<void> {
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });
        const tx = new TransactionBlock();
        tx.setGasBudget(500000000);
        tx.moveCall({
            target: `${btcrelayPackageId}::btcrelay_mock::set_mock_return`,
            arguments: [tx.object(btcrelayCapId), tx.pure(isTrue)],
        });
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });
        expect(result.effects?.status?.status).toBe("success");
    }

    beforeAll(async () => {
        // Receive all the values from CCTransferFactory
        const factory = await CCTransferFactory();
        
        // Destructure and assign all the values
        ({
            ccTransferRouterPackageId,
            ccTransferRouterAdminId,
            telebtcCapId,
            telebtcTreasuryCapId,
            telebtcAdminId,
            btcrelayPackageId,
            btcrelayCapId,
            btcrelayAdminId,
            lockerCapabilityId
        } = factory);

        // Initialize the CC Transfer Router
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });
        deployer = await getActiveKeypair();

        deployerAddress = deployer.getPublicKey().toSuiAddress();
        TELEPORTER_ADDRESS = deployerAddress;

        // Initialize CC Transfer Router using helper function
        const initResult = await callMoveFunction({
            packageId: ccTransferRouterPackageId,
            moduleName: 'cc_transfer_router_test',
            functionName: 'initialize',
            arguments: [
                pure(STARTING_BLOCK_NUMBER),
                pure(APP_ID),
                pure(PROTOCOL_PERCENTAGE_FEE),
                pure(TELEPORTER_ADDRESS),
                pure(TREASURY),
                pure(LOCKER_PERCENTAGE_FEE),
                object(ccTransferRouterAdminId),
            ],
            signer: deployer
        });
        expect(initResult.effects?.status?.status).toBe("success");
        console.log("CC Transfer Router Initialized");

        // Extract the shared router object ID from the initialization result
        for (const obj of initResult.effects?.created || []) {
            const objectId = obj.reference.objectId;
            const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
            const type = objInfo.data?.type || '';
            
            if (type.includes('CCTransferRouterCap')) {
                ccTransferRouterId = objectId;
                console.log("CC Transfer Router ID:", ccTransferRouterId);
                break;
            }
        }
    }, 300000); // Set timeout to 5 minutes (300000 ms)

    // Test for valid package IDs
    test('should have valid package IDs', () => {
        expect(ccTransferRouterPackageId).toBeTruthy();
        expect(btcrelayPackageId).toBeTruthy();
        expect(ccTransferRouterAdminId).toBeTruthy();
        expect(telebtcCapId).toBeTruthy();
        expect(btcrelayCapId).toBeTruthy();
        expect(ccTransferRouterPackageId).toBeTruthy();
        expect(ccTransferRouterAdminId).toBeTruthy();
        expect(lockerCapabilityId).toBeTruthy();
    });

    // Mint Tests
    describe('Mint Tests', () => {
        it('Mints teleBTC for normal cc transfer request (relay fee is zero)', async () => {
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });
            await setRelayReturn(true);

            // Get initial balances
            const initialBalances = await getInitialBalances();

            // Calculate fees
            const lockerFee = Math.floor(
                CC_REQUESTS.normalCCTransfer.bitcoinAmount*1e8 * LOCKER_PERCENTAGE_FEE / 10000
            );
            const teleporterFee =  CC_REQUESTS.normalCCTransfer.teleporterFee;

        const protocolFee = Math.floor(
            CC_REQUESTS.normalCCTransfer.bitcoinAmount*1e8 * PROTOCOL_PERCENTAGE_FEE / 10000
        );

        // Calculate amount that user should have received
        const receivedAmount = CC_REQUESTS.normalCCTransfer.bitcoinAmount*1e8 - lockerFee - teleporterFee - protocolFee;

        // Create transaction to call the wrap function
        const tx = new TransactionBlock();
        tx.setGasBudget(500000000);

        // Call the wrap function (equivalent to ccTransfer in Solidity)
        tx.moveCall({
            target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
            arguments: [
                tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                // Create TxAndProof object
                tx.moveCall({
                    target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                    arguments: [
                        tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.version)),
                        tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.vin)),
                        tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.vout)),
                        tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.locktime)),
                        tx.pure(CC_REQUESTS.normalCCTransfer.blockNumber),
                        tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.intermediateNodes)),
                        tx.pure(CC_REQUESTS.normalCCTransfer.index),
                    ],
                    typeArguments: [],
                }),
                tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                tx.object(btcrelayCapId), // relay
                tx.object(telebtcCapId), // telebtc_cap
                tx.object(telebtcTreasuryCapId), // treasury_cap
            ],
            typeArguments: [],
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Execute the transaction
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });
        // console.log("result", result);
        // printEvents(result);
        expect(result.effects?.status?.status).toBe("success");
        console.log("CC Transfer executed successfully");
        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1 second util status update
        // Check fees and balances
        await checkFees(
            CC_REQUESTS.normalCCTransfer.recipientAddress,
            receivedAmount,
            teleporterFee,
            protocolFee,
            lockerFee,
            initialBalances
        );
        }, 60000);

        it('Mints teleBTC for normal cc transfer request (zero teleporter fee)', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });

            // Get initial balances
            const initialBalances = await getInitialBalances();

            // Calculate fees
            const lockerFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_ZeroFee.bitcoinAmount*1e8 * LOCKER_PERCENTAGE_FEE / 10000
            );
            const teleporterFee = 0;
            
            const protocolFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_ZeroFee.bitcoinAmount*1e8 * PROTOCOL_PERCENTAGE_FEE / 10000
            );

            // Calculate amount that user should have received
            const receivedAmount = CC_REQUESTS.normalCCTransfer_ZeroFee.bitcoinAmount*1e8 - lockerFee - teleporterFee - protocolFee;

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function (equivalent to ccTransfer in Solidity)
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_ZeroFee.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_ZeroFee.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_ZeroFee.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_ZeroFee.locktime)),
                            tx.pure(CC_REQUESTS.normalCCTransfer_ZeroFee.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_ZeroFee.intermediateNodes)),
                            tx.pure(CC_REQUESTS.normalCCTransfer_ZeroFee.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Execute the transaction
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            //console.log("result", result);
            //printEvents(result);
            expect(result.effects?.status?.status).toBe("success");
            console.log("CC Transfer executed successfully");
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Check fees and balances
            await checkFees(
                CC_REQUESTS.normalCCTransfer_ZeroFee.recipientAddress,
                receivedAmount,
                teleporterFee,
                protocolFee,
                lockerFee,
                initialBalances
            );
        }, 60000); // 60 second timeout for this test

        it('Mints teleBTC for normal cc transfer request (zero protocol fee)', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });

            // Set protocol fee to 0 using the Move contract function
            const setProtocolFeeResult = await callMoveFunction({
                packageId: ccTransferRouterPackageId,
                moduleName: 'cc_transfer_router_storage',
                functionName: 'set_protocol_percentage_fee',
                arguments: [
                    object(ccTransferRouterId),
                    object(ccTransferRouterAdminId),
                    pure(0) // Set protocol fee to 0%
                ],
                signer: deployer
            });
            expect(setProtocolFeeResult.effects?.status?.status).toBe("success");
            console.log("Protocol fee set to 0%");

            // Get initial balances after setting protocol fee
            const initialBalances = await getInitialBalances();

            // Protocol fee is now 0
            const protocolFee = 0;

            // Calculate fees
            const lockerFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_zeroProtocolFee.bitcoinAmount * 1e8 * LOCKER_PERCENTAGE_FEE / 10000
            );
            const teleporterFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_zeroProtocolFee.bitcoinAmount * 1e8 * CC_REQUESTS.normalCCTransfer_zeroProtocolFee.teleporterFee / 10000
            );

            // Calculate amount that user should have received
            const receivedAmount = CC_REQUESTS.normalCCTransfer_zeroProtocolFee.bitcoinAmount * 1e8 - lockerFee - teleporterFee - protocolFee;

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function (equivalent to ccTransfer in Solidity)
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.locktime)),
                            tx.pure(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.intermediateNodes)),
                            tx.pure(CC_REQUESTS.normalCCTransfer_zeroProtocolFee.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Execute the transaction
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            console.log("result", result);
            printEvents(result);
            expect(result.effects?.status?.status).toBe("success");
            console.log("CC Transfer executed successfully");
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for 1 second util status update
            // Check fees and balances
            await checkFees(
                CC_REQUESTS.normalCCTransfer_zeroProtocolFee.recipientAddress,
                receivedAmount,
                teleporterFee,
                protocolFee,
                lockerFee,
                initialBalances
            );

            await new Promise(resolve => setTimeout(resolve, 1000));

            // Set protocol fee to 0 using the Move contract function
            const setProtocolFeeResult2 = await callMoveFunction({
                packageId: ccTransferRouterPackageId,
                moduleName: 'cc_transfer_router_storage',
                functionName: 'set_protocol_percentage_fee',
                arguments: [
                    object(ccTransferRouterId),
                    object(ccTransferRouterAdminId),
                    pure(PROTOCOL_PERCENTAGE_FEE) // Set protocol fee to 0%
                ],
                signer: deployer
            });
            expect(setProtocolFeeResult2.effects?.status?.status).toBe("success");
            console.log("Protocol fee set back to 20");
        }, 60000); // 60 second timeout for this test
    });
    describe('Revert Tests', () => {
        it('Reverts since request belongs to an old block header', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });

            // Create transaction to call the wrap function with old block number
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function with block number less than starting block number
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object with old block number
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.OlderBlock.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.OlderBlock.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.OlderBlock.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.OlderBlock.locktime)),
                            tx.pure(STARTING_BLOCK_NUMBER - 1), // Use old block number
                            tx.pure(hexToBytes(CC_REQUESTS.OlderBlock.intermediateNodes)),
                            tx.pure(CC_REQUESTS.OlderBlock.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Execute the transaction and expect it to fail
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*20/
            );
            
        }, 60000);
        
        it('Reverts if the request has been used before', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));

            let client = new SuiClient({ url: getFullnodeUrl('localnet') });
            // since we already add this request in the first test
            const tx1 = new TransactionBlock();
            tx1.setGasBudget(500000000);

            tx1.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx1.object(ccTransferRouterId),
                    tx1.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx1.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.version)),
                            tx1.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.vin)),
                            tx1.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.vout)),
                            tx1.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.locktime)),
                            tx1.pure(CC_REQUESTS.normalCCTransfer.blockNumber),
                            tx1.pure(hexToBytes(CC_REQUESTS.normalCCTransfer.intermediateNodes)),
                            tx1.pure(CC_REQUESTS.normalCCTransfer.index),
                        ],
                        typeArguments: [],
                    }),
                    tx1.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx1.object(lockerCapabilityId),
                    tx1.object(btcrelayCapId),
                    tx1.object(telebtcCapId),
                    tx1.object(telebtcTreasuryCapId),
                ],
                typeArguments: [],
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx1,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*21/
            );
            console.log("Second transaction failed as expected - request already used");
        }, 60000);
        
        it('Reverts if the request has not been finalized on the relay', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });
            
            // Set relay to return false (transaction not finalized)
            await setRelayReturn(false);

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function with UnfinalizedRequest data
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object with UnfinalizedRequest data
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.UnfinalizedRequest.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.UnfinalizedRequest.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.UnfinalizedRequest.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.UnfinalizedRequest.locktime)),
                            tx.pure(CC_REQUESTS.UnfinalizedRequest.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.UnfinalizedRequest.intermediateNodes)),
                            tx.pure(CC_REQUESTS.UnfinalizedRequest.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Execute the transaction and expect it to fail
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*23/
            );
            console.log("Transaction failed as expected - request not finalized on relay");

            await new Promise(resolve => setTimeout(resolve, 1000));
            // set relay to return true
            await setRelayReturn(true);
        }, 60000);
        
        it('Reverts if the percentage fee is out of range [0,10000)', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });
            
            // Set relay to return true (transaction finalized)
            await setRelayReturn(true);

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function with normalCCTransfer_invalidFee data
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object with normalCCTransfer_invalidFee data
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_invalidFee.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_invalidFee.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_invalidFee.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_invalidFee.locktime)),
                            tx.pure(CC_REQUESTS.normalCCTransfer_invalidFee.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.normalCCTransfer_invalidFee.intermediateNodes)),
                            tx.pure(CC_REQUESTS.normalCCTransfer_invalidFee.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Execute the transaction and expect it to fail
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*15/
            );
            console.log("Transaction failed as expected - percentage fee out of range");
        }, 60000);
        
        it('Reverts if app id is invalid', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function with InvalidAppId data
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object with InvalidAppId data
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidAppId.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidAppId.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidAppId.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidAppId.locktime)),
                            tx.pure(CC_REQUESTS.InvalidAppId.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidAppId.intermediateNodes)),
                            tx.pure(CC_REQUESTS.InvalidAppId.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Execute the transaction and expect it to fail
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*14/
            );
            console.log("Transaction failed as expected - app id is invalid");
        }, 60000);
        
        it('Reverts if speed is wrong', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') })

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function with InvalidSpeed data
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object with InvalidSpeed data
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidSpeed.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidSpeed.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidSpeed.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidSpeed.locktime)),
                            tx.pure(CC_REQUESTS.InvalidSpeed.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.InvalidSpeed.intermediateNodes)),
                            tx.pure(CC_REQUESTS.InvalidSpeed.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Execute the transaction and expect it to fail
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*16/
            );
            console.log("Transaction failed as expected - speed is out of range");
        }, 60000);

        it('Reverts if no bitcoin sent', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') })

            // Create transaction to call the wrap function
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the wrap function with InvalidSpeed data
            tx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
                arguments: [
                    tx.object(ccTransferRouterId), // router - the shared CCTransferRouterCap object
                    // Create TxAndProof object with InvalidSpeed data
                    tx.moveCall({
                        target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                        arguments: [
                            tx.pure(hexToBytes(CC_REQUESTS.NoBitcoinSent.version)),
                            tx.pure(hexToBytes(CC_REQUESTS.NoBitcoinSent.vin)),
                            tx.pure(hexToBytes(CC_REQUESTS.NoBitcoinSent.vout)),
                            tx.pure(hexToBytes(CC_REQUESTS.NoBitcoinSent.locktime)),
                            tx.pure(CC_REQUESTS.NoBitcoinSent.blockNumber),
                            tx.pure(hexToBytes(CC_REQUESTS.NoBitcoinSent.intermediateNodes)),
                            tx.pure(CC_REQUESTS.NoBitcoinSent.index),
                        ],
                        typeArguments: [],
                    }),
                    tx.pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                    tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                    tx.object(btcrelayCapId), // relay
                    tx.object(telebtcCapId), // telebtc_cap
                    tx.object(telebtcTreasuryCapId), // treasury_cap
                ],
                typeArguments: [],
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Execute the transaction and expect it to fail
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe("failure");
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_test.*13/
            );
            console.log("Transaction failed as expected - speed is out of range");
        }, 60000);
    });

    // Admin Tests
    describe('Admin Tests', () => {
        it('Sets protocol percentage fee', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });

            // Set protocol fee to 100 (1%)
            const setProtocolFeeResult = await callMoveFunction({
                packageId: ccTransferRouterPackageId,
                moduleName: 'cc_transfer_router_storage',
                functionName: 'set_protocol_percentage_fee',
                arguments: [
                    object(ccTransferRouterId),
                    object(ccTransferRouterAdminId),
                    pure(100) // Set protocol fee to 1%
                ],
                signer: deployer
            });
            expect(setProtocolFeeResult.effects?.status?.status).toBe("success");
            console.log("Protocol fee set to 1%");

            // Verify the fee was set correctly by calling the getter
            const getProtocolFeeTx = new TransactionBlock();
            getProtocolFeeTx.moveCall({
                target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::get_protocol_percentage_fee`,
                arguments: [
                    getProtocolFeeTx.object(ccTransferRouterId)
                ]
            });

            const getProtocolFeeResult = await client.devInspectTransactionBlock({
                transactionBlock: getProtocolFeeTx,
                sender: deployerAddress
            });
            expect(getProtocolFeeResult.effects?.status?.status).toBe("success");
            
            // Extract the return value from the transaction result
            const returnValues = getProtocolFeeResult.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues.length).toBeGreaterThan(0);
            const feeValue = Number(returnValues[0]);
            expect(feeValue).toBe(100);
            console.log(`Verified protocol fee is now: ${feeValue}`);

            // Set protocol fee back to original value
            const resetProtocolFeeResult = await callMoveFunction({
                packageId: ccTransferRouterPackageId,
                moduleName: 'cc_transfer_router_storage',
                functionName: 'set_protocol_percentage_fee',
                arguments: [
                    object(ccTransferRouterId),
                    object(ccTransferRouterAdminId),
                    pure(PROTOCOL_PERCENTAGE_FEE) // Set back to original
                ],
                signer: deployer
            });
            expect(resetProtocolFeeResult.effects?.status?.status).toBe("success");
            console.log("Protocol fee reset to original value");
        }, 60000);

        it('Reverts if protocol percentage fee is out of range', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const client = new SuiClient({ url: getFullnodeUrl('localnet') });

            // Try to set protocol fee to 20000 (200%) - should fail
            const setProtocolFeeResult = await callMoveFunction({
                packageId: ccTransferRouterPackageId,
                moduleName: 'cc_transfer_router_storage',
                functionName: 'set_protocol_percentage_fee',
                arguments: [
                    object(ccTransferRouterId),
                    object(ccTransferRouterAdminId),
                    pure(20000) // Set protocol fee to 200% (invalid)
                ],
                signer: deployer
            });
            expect(setProtocolFeeResult.effects?.status?.status).toBe("failure");
            expect(setProtocolFeeResult.effects?.status?.error).toMatch(
                /MoveAbort.*cc_transfer_router_storage.*0/
            );
            console.log("Protocol fee out of range test passed");
        }, 60000);
    });

}, 10000000);