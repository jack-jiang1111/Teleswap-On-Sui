import { getFullnodeUrl, SuiClient } from "@mysten/sui.js/client";
import { beforeAll, describe, expect, test } from "vitest";
import { CCTransferFactory } from "./test_factory/cc_transfer_factory";
import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { BigNumber } from "bignumber.js";
import { getActiveKeypair } from "../scripts/sui.utils";
import { TransactionBlock } from "@mysten/sui.js/transactions";
const CC_REQUESTS = require('./test_fixtures/ccTransferRequests.json');

// call CCTransferFactory
describe('CCTransfer Tests', () => {
    // Declare variables to store the factory results
    let ccTransferRouterPackageId: string;
    let ccTransferRouterAdminId: string;
    let telebtcCapId: string;
    let telebtcTreasuryCapId: string;
    let telebtcPackageId: string;
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
    const APP_ID = 0;
    const PROTOCOL_PERCENTAGE_FEE = 10; // Means %0.1
    const LOCKER_PERCENTAGE_FEE = 20; // Means %0.2
    const PRICE_WITH_DISCOUNT_RATIO = 9500; // Means %95
    
    const STARTING_BLOCK_NUMBER = 1;
    const TREASURY =       "0x0000000000000000000000000000000000000000000000000000000000000002"; // Valid Sui address
    const LOCKER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000003"; // example locker address
    let LOCKER1_LOCKING_SCRIPT = '0xa9144062c8aeed4f81c2d73ff854a2957021191e20b687';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 1; // P2PKH

    let collateralRatio = 20000;
    let liquidationRatio = 15000;


    // Helper function to check fees and balances
    async function checkFees(
        recipientAddress: string,
        receivedAmount: number,
        teleporterFee: number,
        protocolFee: number,
        lockerFee: number,
    ): Promise<void> {
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });

        // Get current balances
        const recipientBalance = await client.getBalance({
            owner: recipientAddress,
            coinType: `${telebtcPackageId}::telebtc::TELEBTC`
        });

        const teleporterBalance = await client.getBalance({
            owner: deployerAddress,
            coinType: `${telebtcPackageId}::telebtc::TELEBTC`
        });

        const treasuryBalance = await client.getBalance({
            owner: TREASURY,
            coinType: `${telebtcPackageId}::telebtc::TELEBTC`
        });

        const lockerBalance = await client.getBalance({
            owner: LOCKER_ADDRESS,
            coinType: `${telebtcPackageId}::telebtc::TELEBTC`
        });


        // Get total supply (this would need to be implemented in your telebtc module)
        // For now, we'll skip this check

        // Check recipient balance
        expect(Number(recipientBalance.totalBalance)).toBe(receivedAmount);

        // Check teleporter balance
        expect(Number(teleporterBalance.totalBalance)).toBe(teleporterFee);

        // Check treasury balance
        expect(Number(treasuryBalance.totalBalance)).toBe(protocolFee);

        // Check locker balance
        expect(Number(lockerBalance.totalBalance)).toBe(lockerFee);

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
            telebtcPackageId,
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

        
        const tx = new TransactionBlock();
        tx.setGasBudget(500000000);
        tx.moveCall({
            target: `${ccTransferRouterPackageId}::cc_transfer_router_test::initialize`,
            arguments: [
                tx.pure(STARTING_BLOCK_NUMBER),
                tx.pure(APP_ID),
                tx.pure(PROTOCOL_PERCENTAGE_FEE),
                tx.pure(TELEPORTER_ADDRESS),
                tx.pure(TREASURY),
                tx.pure(LOCKER_PERCENTAGE_FEE),
                tx.object(ccTransferRouterAdminId),
            ],
            typeArguments: [],
        });
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });
        expect(result.effects?.status?.status).toBe("success");
        console.log("CC Transfer Router Initialized");
        console.log(result);

        // next step add the locker contract to the miners on telebtc contract
        const tx2 = new TransactionBlock();
        tx2.setGasBudget(500000000);
        tx2.moveCall({
            target: `${telebtcPackageId}::telebtc::add_miner`,
            arguments: [
                tx2.object(telebtcCapId),
                tx2.object(telebtcAdminId),
                tx2.pure(ccTransferRouterPackageId),
            ],
            typeArguments: [],
        });
        const result2 = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx2,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });
        expect(result2.effects?.status?.status).toBe("success");
        console.log("Locker contract added to miners");
        console.log(result2);
    }, 300000); // Set timeout to 5 minutes (300000 ms)

    // Add a proper test case
    test('should have valid package IDs', () => {
        expect(ccTransferRouterPackageId).toBeTruthy();
        expect(telebtcPackageId).toBeTruthy();
        expect(btcrelayPackageId).toBeTruthy();
        expect(ccTransferRouterAdminId).toBeTruthy();
        expect(telebtcCapId).toBeTruthy();
        expect(btcrelayCapId).toBeTruthy();
        expect(ccTransferRouterPackageId).toBeTruthy();
        expect(ccTransferRouterAdminId).toBeTruthy();
        expect(lockerCapabilityId).toBeTruthy();
    });

    test('Mints teleBTC for normal cc transfer request (relay fee is zero)', async () => {
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });
        await setRelayReturn(true);


        // Calculate fees
        const lockerFee = Math.floor(
            CC_REQUESTS.normalCCTransfer.bitcoinAmount * PROTOCOL_PERCENTAGE_FEE *2 / 10000
        );
        const teleporterFee = Math.floor(
            CC_REQUESTS.normalCCTransfer.bitcoinAmount * CC_REQUESTS.normalCCTransfer.teleporterFee / 10000
        );
        const protocolFee = Math.floor(
            CC_REQUESTS.normalCCTransfer.bitcoinAmount * PROTOCOL_PERCENTAGE_FEE / 10000
        );

        // Calculate amount that user should have received
        const receivedAmount = CC_REQUESTS.normalCCTransfer.bitcoinAmount - lockerFee - teleporterFee - protocolFee;

        // Create transaction to call the wrap function
        const tx = new TransactionBlock();
        tx.setGasBudget(500000000);

        // Call the wrap function (equivalent to ccTransfer in Solidity)
        tx.moveCall({
            target: `${ccTransferRouterPackageId}::cc_transfer_router_test::wrap`,
            arguments: [
                // Create TxAndProof object
                tx.moveCall({
                    target: `${ccTransferRouterPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
                    arguments: [
                        tx.pure(CC_REQUESTS.normalCCTransfer.version),
                        tx.pure(CC_REQUESTS.normalCCTransfer.vin),
                        tx.pure(CC_REQUESTS.normalCCTransfer.vout),
                        tx.pure(CC_REQUESTS.normalCCTransfer.locktime),
                        tx.pure(CC_REQUESTS.normalCCTransfer.blockNumber),
                        tx.pure(CC_REQUESTS.normalCCTransfer.intermediateNodes),
                        tx.pure(CC_REQUESTS.normalCCTransfer.index),
                    ],
                    typeArguments: [],
                }),
                tx.pure(LOCKER1_LOCKING_SCRIPT),
                tx.object(lockerCapabilityId), // locker_cap - using the actual LockerCapability object
                tx.object(btcrelayCapId), // relay
                tx.object(telebtcCapId), // telebtc_cap
                tx.object(telebtcTreasuryCapId), // treasury_cap
            ],
            typeArguments: [],
        });

        // Execute the transaction
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });

        expect(result.effects?.status?.status).toBe("success");
        console.log("CC Transfer executed successfully");

        // Check fees and balances
        await checkFees(
            CC_REQUESTS.normalCCTransfer.recipientAddress,
            receivedAmount,
            teleporterFee,
            protocolFee,
            lockerFee,
        );
    }, 60000); // 60 second timeout for this test

}, 10000000);