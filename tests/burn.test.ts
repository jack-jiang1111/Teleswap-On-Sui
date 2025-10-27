import { SuiClient } from '@mysten/sui.js/client';
import { getFullnodeUrl } from '@mysten/sui.js/client';
import { beforeAll, describe, expect, test,it ,beforeEach} from "vitest";
import { CCBurnFactory } from "./test_factory/cc_burn_factory";
import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { getActiveKeypair } from "../scripts/helper/sui.utils";
import { TransactionBlock } from '@mysten/sui.js/transactions';
const CC_BURN_REQUESTS = require('./test_fixtures/ccBurnRequests.json');
import BigNumber from 'bignumber.js';
import { callMoveFunction, pure, object, objectRef, sharedObjectRef, getLatestObjectRef, getCoinBalance, splitGasTokens } from './utils/move-helper';
import {printEvents,hexToBytes,eventNotContain} from './utils/utils';

import * as fs from 'fs';
import * as path from 'path';


// Shared variables and setup

let burnRouterPackageId: string;
let burnRouterAdminId: string;
let telebtcCapId: string;
let telebtcTreasuryCapId: string;
let telebtcAdminId: string;
let btcrelayCapId: string;
let btcrelayAdminId: string;
let deployer: Ed25519Keypair;
let deployerAddress: string;
let burnRouterId: string;
let LockerCapId: string;

// Constants
// 100200000*(1-0.05%-0.1%)-49700 = 100000000
let userRequestedAmount = new BigNumber(100200000);
let TRANSFER_DEADLINE = 20
let PROTOCOL_PERCENTAGE_FEE = 5 // means 0.05%
let LOCKER_PERCENTAGE_FEE = 10 // means 0.1%
let REWARDER_PERCENTAGE_FEE = 3 // means 0.03%
let SLASHER_PERCENTAGE_REWARD = 5 // means 0.05%
let BITCOIN_FEE = 49700 // estimation of Bitcoin transaction fee in Satoshi
let TREASURY = "0x0000000000000000000000000000000000000000000000000000000000000002";
let REWARDER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000005";

// P2PK: u8 = 1, 32bytes
// P2WSH: u8 = 2, 32bytes
// P2TR: u8 = 3, 32bytes
// P2PKH: u8 = 4, 20bytes
// P2SH: u8 = 5, 20bytes
// P2WPKH: u8 = 6, 20bytes

let locker: Ed25519Keypair;
// a place holder for now
let LOCKER_TARGET_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000011";
let LOCKER1_LOCKING_SCRIPT = '0x76a914748284390f9e263a4b766a75d0633c50426eb87587ac';

let USER_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
let USER_SCRIPT_P2PKH_TYPE = 4; // P2PKH

let USER_SCRIPT_P2WPKH = "0x751e76e8199196d454941c45d1b3a323f1433bd6";
let USER_SCRIPT_P2WPKH_TYPE = 6; // P2WPKH

// Helper functions for mocking locker and relay behaviors (Sui/Move version)
// These require the DummyLockerCap object ID and package ID to be available in the test context.
/**
 * Sets the mock return value for locker slashing idle locker
 * @param value - The boolean value to set for idle locker slashing
 * @returns Promise that resolves when the operation is complete
 */
async function setLockersSlashIdleLockerReturn(value: boolean): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    

    
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::lockerstorage::set_slash_idle_locker_return`,
        arguments: [tx.object(LockerCapId), tx.pure(value)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success");
}

/**
 * Sets the mock return value for locker slashing thief locker
 * @param value - The boolean value to set for thief locker slashing
 * @returns Promise that resolves when the operation is complete
 */
async function setLockersSlashThiefLockerReturn(value: boolean): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::lockerstorage::set_slash_thief_locker_return`,
        arguments: [tx.object(LockerCapId), tx.pure(value)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success");
}

/**
 * Sets whether the locker is considered valid
 * @param isLocker - Boolean indicating if the locker is valid
 * @returns Promise that resolves when the operation is complete
 */
async function setLockersIsLocker(isLocker: boolean): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    // Get latest object reference to avoid version mismatch
    const dummyLockerCapRef = await getLatestObjectRef(client, LockerCapId);
    
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::lockerstorage::set_is_locker`,
        arguments: [tx.object(dummyLockerCapRef.objectId), tx.pure(isLocker)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success");
}

/**
 * Sets the locker target address for mock operations
 * @param address - The address to set as the locker target address
 * @returns Promise that resolves when the operation is complete
 */
async function setLockersGetLockerTargetAddress(address: string): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    // Get latest object reference to avoid version mismatch
    const dummyLockerCapRef = await getLatestObjectRef(client, LockerCapId);
    
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::lockerstorage::set_locker_target_address`,
        arguments: [tx.object(dummyLockerCapRef.objectId), tx.pure(address)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success");
}

/**
 * Sets the mock burn return amount for locker operations
 * @param burntAmount - The amount to set as the burn return value
 * @returns Promise that resolves when the operation is complete
 */
async function setLockersBurnReturn(burntAmount: number): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    // Get latest object reference to avoid version mismatch
    const dummyLockerCapRef = await getLatestObjectRef(client, LockerCapId);
    
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::lockerstorage::set_burn_return`,
        arguments: [tx.object(dummyLockerCapRef.objectId), tx.pure(burntAmount)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success");
}

/**
 * Sets the last submitted height for the Bitcoin relay mock
 * @param blockNumber - The block number to set as the last submitted height
 * @returns Promise that resolves when the operation is complete
 */
async function setRelayLastSubmittedHeight(blockNumber: number): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    // Get latest object reference to avoid version mismatch
    const btcrelayCapRef = await getLatestObjectRef(client, btcrelayCapId);
    
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::btcrelay::set_last_submitted_height`,
        arguments: [tx.object(btcrelayCapRef.objectId), tx.pure(blockNumber)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success");
}

/**
 * Sets the mock return value for Bitcoin relay operations
 * @param isTrue - Boolean value to set for relay mock operations
 * @returns Promise that resolves when the operation is complete
 */
async function setRelayReturn(isTrue: boolean): Promise<void> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    // Get latest object reference to avoid version mismatch
    const btcrelayCapRef = await getLatestObjectRef(client, btcrelayCapId);
    
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::btcrelay::set_mock_return`,
        arguments: [tx.object(btcrelayCapRef.objectId), tx.pure(isTrue)],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    expect(result.effects?.status?.status).toBe("success"); 
}

/**
 * Mints teleBTC tokens for testing purposes
 * @param address - The address to mint tokens for (defaults to deployer address)
 * @param amount - The amount of teleBTC to mint (defaults to 10000)
 * @returns Promise that resolves to the coin object ID
 */
async function mintTeleBTCForTest(address = deployerAddress, amount = 10000): Promise<string> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    
    // Mint the coins
    const mintResult = tx.moveCall({
        target: `${burnRouterPackageId}::telebtc::mint`,
        arguments: [
            tx.object(telebtcCapId),              // &mut TeleBTCCap
            tx.object(telebtcTreasuryCapId),      // &mut TreasuryCap<TELEBTC>
            tx.pure(amount),                                 // amount: u64
        ],
    });
    
    // Transfer the minted coins to the deployer
    tx.transferObjects([mintResult], tx.pure(address));
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    //console.log("result", result);
    expect(result.effects?.status?.status).toBe("success");
    
    // Extract and return the coin object ID
    const coinObjectId = result.effects?.created?.[0]?.reference?.objectId;
    if (!coinObjectId) {
        throw new Error('Failed to get coin object ID from mint transaction');
    }
    return coinObjectId;
}

// Helper to send a burn request in the Sui/Move test context
async function sendBurnRequest(
    userScript: string,
    userScriptType: number,
    coinObjectIds: string[],
    amount: number
): Promise<any> {
    await new Promise(resolve => setTimeout(resolve, 1000)); // wait for all object settle down
    
    // Create coin objects from coin IDs (similar to test_swap.ts approach)
    const coinObjects = coinObjectIds.map(id => ({ type: 'object', value: id }));
    
    // Call the Move unwrap (burn) entry function
    const result = await callMoveFunction({
        packageId: burnRouterPackageId,
        moduleName: 'burn_router_logic',
        functionName: 'unwrap',
        arguments: [
            object(burnRouterId),
            { type: 'moveVec', value: { objects: coinObjects } }, // amount_coins (vector<Coin<TELEBTC>>) - vector of coin objects
            pure(amount),                        // amount (u64) - amount to unwrap
            pure(hexToBytes(userScript)),        // user_script (vector<u8>)
            pure(userScriptType),                // script_type (u8)
            pure(LOCKER1_LOCKING_SCRIPT),        // locker_locking_script (vector<u8>)
            pure(0),                             // third_party (u64, set to 0 if not used)
            object(telebtcCapId),                // &mut TeleBTCCap
            object(telebtcTreasuryCapId),        // &mut TreasuryCap<TELEBTC>
            object(btcrelayCapId),               // &BTCRelay
            object(LockerCapId),            // &mut DummyLockerCap
        ],
        signer: deployer
    });
    return result;
}

/**
 * Provides a burn proof for a specific burn request
 * @param burnReqBlockNumber - The block number for the burn request
 * @param signer - The signer to use for the transaction
 * @param request_index - The index of the burn request to provide proof for
 * @returns Promise that resolves to the transaction result
 */
async function provideProof(burnReqBlockNumber: number,signer: Ed25519Keypair,request_index: number): Promise<any> {
    const result = await callMoveFunction({
        packageId: burnRouterPackageId,
        moduleName: 'burn_router_logic',
        functionName: 'burn_proof',
        arguments: [
            object(burnRouterId),
            object(btcrelayCapId),
            pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
            pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
            pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
            pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
            pure(burnReqBlockNumber),
            pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
            pure(1),
            pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
            pure([request_index]),
            pure([0]),
            object(LockerCapId),
        ],
        signer: signer
    });
    return result;
}



describe('BurnRouter Test Suite', () => {
    // Declare variables to store the factory results
    
    const USE_CACHED_IDS = false;
    beforeAll(async () => {
        
        deployer = await getActiveKeypair();
        deployerAddress = deployer.getPublicKey().toSuiAddress();
        if (USE_CACHED_IDS) {
            // Read from cached JSON file
            const packageIdPath = path.join(__dirname, 'package_id.json');
            const cachedData = JSON.parse(fs.readFileSync(packageIdPath, 'utf8'));
            
            burnRouterPackageId = cachedData.burnRouterPackageId;
            burnRouterAdminId = cachedData.burnRouterAdminId;
            telebtcCapId = cachedData.telebtcCapId;
            telebtcTreasuryCapId = cachedData.telebtcTreasuryCapId;
            telebtcAdminId = cachedData.telebtcAdminId;
            btcrelayCapId = cachedData.btcrelayCapId;
            btcrelayAdminId = cachedData.btcrelayAdminId;
            burnRouterId = cachedData.burnRouterId;
            LockerCapId = cachedData.LockerCapId;
            
            console.log('Using cached IDs from package_id.json');
        } else {
            // Use factory to create fresh deployments
            const factory = await CCBurnFactory();
            ({
                burnRouterPackageId,
                burnRouterAdminId,
                telebtcCapId,
                telebtcTreasuryCapId,
                telebtcAdminId,
                btcrelayCapId,
                btcrelayAdminId,
                LockerCapId
            } = factory);
            //console.log({burnRouterAdminId,TREASURY,TRANSFER_DEADLINE,PROTOCOL_PERCENTAGE_FEE,LOCKER_PERCENTAGE_FEE,SLASHER_PERCENTAGE_REWARD,BITCOIN_FEE,deployerAddress,btcrelayCapId});
            let result = await callMoveFunction({
                packageId: burnRouterPackageId,
                moduleName: 'burn_router_logic',
                functionName: 'initialize',
                arguments: [
                    object(burnRouterAdminId),
                    pure(1),
                    pure(TREASURY),
                    pure(TRANSFER_DEADLINE),
                    pure(PROTOCOL_PERCENTAGE_FEE),
                    pure(LOCKER_PERCENTAGE_FEE),
                    pure(SLASHER_PERCENTAGE_REWARD),
                    pure(BITCOIN_FEE),
                    pure(deployerAddress),
                    pure(btcrelayCapId),
                    pure(REWARDER_ADDRESS),
                    pure(REWARDER_PERCENTAGE_FEE),
                ],
                signer: deployer
            });
            
            expect(result.effects?.status?.status).toBe("success");
            // Extract burnRouterId from the created object
            // The initialize function shares the BurnRouter object, so we need to get its ID
            // This might need to be adjusted based on how the object is created and shared
            burnRouterId = result.effects?.created?.[0]?.reference?.objectId || '';
            console.log("burnRouterId", burnRouterId);
            // Save the new IDs to JSON file
            const packageIdPath = path.join(__dirname, 'package_id.json');
            const idsToSave = {
                burnRouterPackageId,
                burnRouterAdminId,
                telebtcCapId,
                telebtcTreasuryCapId,
                telebtcAdminId,
                btcrelayCapId,
                btcrelayAdminId,
                burnRouterId,
                LockerCapId
            };
            fs.writeFileSync(packageIdPath, JSON.stringify(idsToSave, null, 2));
            console.log('Saved new IDs to package_id.json');
        }
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    locker = new Ed25519Keypair();
    await splitGasTokens(client, deployer, locker.toSuiAddress(), 2000000000); // 1 SUI
    LOCKER_TARGET_ADDRESS = locker.toSuiAddress();
    console.log("lockerAddress", LOCKER_TARGET_ADDRESS);
    // create a new address for the locker
    // transfer some test sui token for gas fee from deployer to lockerAddress
    
    // Set up mocks
    await setRelayLastSubmittedHeight(100);
    await setLockersIsLocker(true);
    const protocolFee = Math.floor(userRequestedAmount.toNumber() * PROTOCOL_PERCENTAGE_FEE / 10000);
    const rewarderFee = Math.floor(userRequestedAmount.toNumber() * REWARDER_PERCENTAGE_FEE / 10000);
    const burntAmount = userRequestedAmount.toNumber() - protocolFee - rewarderFee;
    await setLockersBurnReturn(burntAmount);
    await setLockersGetLockerTargetAddress(LOCKER_TARGET_ADDRESS);
        
    }, 600000); // Set timeout to 60 seconds

    it('Factory should deploy and return all important IDs', async () => {
        expect(burnRouterPackageId).toBeTruthy();
        expect(burnRouterAdminId).toBeTruthy();
        expect(telebtcCapId).toBeTruthy();
        expect(telebtcTreasuryCapId).toBeTruthy();
        expect(telebtcAdminId).toBeTruthy();
        expect(btcrelayCapId).toBeTruthy();
        expect(btcrelayAdminId).toBeTruthy();
        expect(LockerCapId).toBeTruthy();
        expect(burnRouterId).toBeTruthy();
    });

   
}); 

describe('BurnRouter Burn Proof Tests', () => {
    beforeEach(async () => {
         // First, create a burn request
         const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
         await new Promise(resolve => setTimeout(resolve, 1000));
         
         let burnResult = await sendBurnRequest(
             USER_SCRIPT_P2PKH,
             USER_SCRIPT_P2PKH_TYPE,
             [coinObjectId],
             userRequestedAmount.toNumber()
         );
         //console.log("burnResult", burnResult);
         expect(burnResult.effects?.status?.status).toBe("success");
         
         await new Promise(resolve => setTimeout(resolve, 1000));
    });
    it('Submits a valid burn proof (for P2PKH)', async () => {
        // Set up mocks
        await setRelayReturn(true);
        await setLockersIsLocker(true);
        await setLockersGetLockerTargetAddress(LOCKER_TARGET_ADDRESS);
        
       
    
        let result = await provideProof(105, locker,0);
        
        //console.log("result", result.effects);
        expect(result.effects?.status?.status).toBe("success");
        
        let isUsed = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_is_used_as_burn_proof',
            arguments: [object(burnRouterId), pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.txId))],
            signer: deployer,
            returnValue: true
        });
        expect(isUsed?.effects?.status?.status).toBe("success");

        const returnValues = isUsed?.results?.[0]?.returnValues?.[0]?.[0] || []
        const isUsedValue = returnValues[0];
        expect(isUsedValue).toBe(1); // get_is_used_as_burn_proof should return true if we input the txid
        
    }, 60000);
    it('Submits a valid burn proof (for P2WPKH)', async () => {
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
    
        // Sends a burn request
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2WPKH,
            USER_SCRIPT_P2WPKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );

        expect(burnResult.effects?.status?.status).toBe("success");
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Provide proof using P2WPKH burn proof data
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validP2WPKH.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validP2WPKH.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validP2WPKH.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validP2WPKH.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validP2WPKH.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([2]), // Burn req index
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        expect(result.effects?.status?.status).toBe("success");
        
        // Verify that the proof was marked as used
        let isUsed = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_is_used_as_burn_proof',
            arguments: [object(burnRouterId), pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validP2WPKH.txId))],
            signer: deployer,
            returnValue: true
        });
        expect(isUsed?.effects?.status?.status).toBe("success");

        const returnValues = isUsed?.results?.[0]?.returnValues?.[0]?.[0] || []
        const isUsedValue = returnValues[0];
        expect(isUsedValue).toBe(1); // get_is_used_as_burn_proof should return true if we input the txid
        
    }, 60000);

    it('Submits a valid burn proof which doesn\'t have change vout', async () => {
        
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validWithoutChange.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validWithoutChange.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validWithoutChange.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validWithoutChange.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validWithoutChange.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([3]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        expect(result.effects?.status?.status).toBe("success");
        
        // Verify that the proof was marked as used
        let isUsed = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_is_used_as_burn_proof',
            arguments: [object(burnRouterId), pure(hexToBytes(CC_BURN_REQUESTS.burnProof_validWithoutChange.txId))],
            signer: deployer,
            returnValue: true
        });
        expect(isUsed?.effects?.status?.status).toBe("success");

        const returnValues = isUsed?.results?.[0]?.returnValues?.[0]?.[0] || []
        const isUsedValue = returnValues[0];
        expect(isUsedValue).toBe(1); // get_is_used_as_burn_proof should return true if we input the txid
        
    }, 60000);
    it('Reverts since _burnReqIndexes is not sorted', async () => {

        // Try to provide proof with unsorted vout indexes [0, 1] and [1, 0]
        // This should fail because the indexes are not in ascending order
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([0, 1]), // start indexes
                pure([1, 0]),  // end indexes - not sorted!
                object(LockerCapId)
            ],
            signer: locker
        });
        
        // Expect failure due to unsorted indexes
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*223/
        );
        
    }, 60000);
    it('Reverts since locktime is non-zero', async () => {
        
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes('0x00000001')), // non-zero locktime
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER_TARGET_ADDRESS)),
                pure([4]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*220/
        );
    }, 60000);

    it('Reverts if locking script is not valid', async () => {
        // Set mock to indicate invalid locker
        await setLockersIsLocker(false);
        
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER_TARGET_ADDRESS)),
                pure([5]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*213/
        );
         // Set mock contracts outputs
         await setLockersIsLocker(true);
    }, 60000);

    it('Reverts if given indexes doesn\'t match', async () => {
       
        
        // Should revert when start index is bigger than end index
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER_TARGET_ADDRESS)),
                pure([0, 1]), // start indexes
                pure([0]),    // end indexes - mismatch!
                object(LockerCapId)
            ],
            signer: locker
        });
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*221/ // wrong indexes
        );
        
        // Should revert when end index is bigger than total number of burn requests
        result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER_TARGET_ADDRESS)),
                pure([6]),     // start indexes
                pure([0, 1]),  // end indexes - too many!
                object(LockerCapId)
            ],
            signer: locker
        });
        
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*221/ // EWRONG_INDEX
        );
    }, 60000);

    it('Reverts if locker\'s tx has not been finalized on relay', async () => {
        // Set mock to indicate transaction not finalized
        await setRelayReturn(false);
        
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER_TARGET_ADDRESS)),
                pure([7]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*202/ // not finialized
        );
    }, 60000);

    it('Reverts if vout is null', async () => {
        // Set mock contracts outputs
        await setRelayReturn(true);
        
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes('0x0000')), // null vout
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER_TARGET_ADDRESS)),
                pure([8]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*154/
        );
    }, 60000);

    it('Doesn\'t accept burn proof since the paid amount is not exact', async () => {
        let wrongUserRequestAmount = new BigNumber(100080000);
        let burnReqBlockNumber = 100;

        // Send a burn request with wrong amount
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, wrongUserRequestAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            wrongUserRequestAmount.toNumber()
        );
        //expect(burnResult.effects?.status?.status).toBe("success");
        
        await new Promise(resolve => setTimeout(resolve, 1000));


        // Try to provide proof with wrong indexes
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(burnReqBlockNumber + 5),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([10]), // start with 10
                pure([1]),
                object(LockerCapId)
            ],
            signer: locker
        });

        // Should not emit PaidCCBurn event (proof should fail)
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*203/ // invalid burn proof
        );
        // Check that the transfer status is false
        // First get the burn request
        let burnRequest = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_burn_request',
            arguments: [
                object(burnRouterId), 
                pure(LOCKER_TARGET_ADDRESS), 
                pure(10)
            ],
            signer: deployer,
            returnValue: true
        });
        expect(burnRequest?.effects?.status?.status).toBe("success");
        
        // Extract the transfer status from the burn request data
        // The burn request data contains the is_transferred field
        const burnRequestData = burnRequest?.results?.[0]?.returnValues?.[0]?.[0] || []
        // The is_transferred field is at a specific position in the struct
        // Based on the BurnRequest struct: amount, burnt_amount, sender, user_script, script_type, deadline, is_transferred, request_id_of_locker
        // is_transferred is the 6th field (0-indexed)
        const isTransferredValue = burnRequestData[6]; // is_transferred field
        expect(isTransferredValue).toBe(0); // Should be false
    }, 60000);

    it('Doesn\'t accept burn proof since the proof has been submitted before', async () => {
        
        // First, submit a valid burn proof
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([11]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*203/ // invalid burn proof
        );
    }, 60000);

    it('Doesn\'t accept burn proof since deadline is passed', async () => {

        // Try to provide proof with deadline passed
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.locktime)),
                pure(100 + TRANSFER_DEADLINE + 1), // burnReqBlockNumber + TRANSFER_DEADLINE + 1
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([12]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });

        // Should not emit PaidCCBurn event (proof should fail)
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*203/ // invalid burn proof
        );
        // Check that the transfer status is false
        // First get the burn request
        let burnRequest = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_burn_request',
            arguments: [
                object(burnRouterId), 
                pure(LOCKER_TARGET_ADDRESS), 
                pure(12)
            ],
            signer: deployer,
            returnValue: true
        });
        expect(burnRequest?.effects?.status?.status).toBe("success");
        
        // Extract the transfer status from the burn request data
        // The burn request data contains the is_transferred field
        const burnRequestData = burnRequest?.results?.[0]?.returnValues?.[0]?.[0] || []
        // The is_transferred field is at a specific position in the struct
        // Based on the BurnRequest struct: amount, burnt_amount, sender, user_script, script_type, deadline, is_transferred, request_id_of_locker
        // is_transferred is the 6th field (0-indexed)
        const isTransferredValue = burnRequestData[6]; // is_transferred field
        expect(isTransferredValue).toBe(0); // Should be false
    }, 60000);

    it('Doesn\'t accept burn proof since change address is invalid', async () => {

        // Submit proof with invalid change address
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_invalidChange.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_invalidChange.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_invalidChange.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_invalidChange.locktime)),
                pure(105), // burnReqBlockNumber + 5
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_invalidChange.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([13]),
                pure([0]),
                object(LockerCapId)
            ],
            signer: locker
        });
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*203/ // invalid burn proof
        );

        // Check that the transfer status is false
        // First get the burn request
        let burnRequest = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_burn_request',
            arguments: [
                object(burnRouterId), 
                pure(LOCKER_TARGET_ADDRESS), 
                pure(13)
            ],
            signer: deployer,
            returnValue: true
        });
        expect(burnRequest?.effects?.status?.status).toBe("success");
        
        // Extract the transfer status from the burn request data
        // The burn request data contains the is_transferred field
        const burnRequestData = burnRequest?.results?.[0]?.returnValues?.[0]?.[0] || []
        // The is_transferred field is at a specific position in the struct
        // Based on the BurnRequest struct: amount, burnt_amount, sender, user_script, script_type, deadline, is_transferred, request_id_of_locker
        // is_transferred is the 6th field (0-indexed)
        const isTransferredValue = burnRequestData[6]; // is_transferred field
        expect(isTransferredValue).toBe(0); // Should be false
    }, 60000);
}); 

describe('BurnRouter Unwrap Tests', () => {
    it('Reverts since user script length is incorrect', async () => {
        //await new Promise(resolve => setTimeout(resolve, 5000));
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        // Invalid script length (replace 20 with your actual error code for invalid script)
        let result = await sendBurnRequest(
            USER_SCRIPT_P2PKH + '00', // invalid length
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*222/ // invalid script
        );
        //await new Promise(resolve => setTimeout(resolve, 1000));
        // Invalid script type (replace 20 with your actual error code for invalid script)
        result = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            1, // invalid type
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*222/ // INVALID SCRIPT
        );
    }, 60000);
    it('Burns teleBTC for user', async () => {
        const lastSubmittedHeight = 100;
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());

        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for all object settle down
        const prevBalance = await getCoinBalance(client, burnRouterPackageId, deployerAddress, "telebtc::TELEBTC");
        const prevProtocolBalance = await getCoinBalance(client, burnRouterPackageId, TREASURY, "telebtc::TELEBTC");
        const prevLockerBalance = await getCoinBalance(client, burnRouterPackageId, LOCKER_TARGET_ADDRESS, "telebtc::TELEBTC");
        const prevRewarderBalance = await getCoinBalance(client, burnRouterPackageId, REWARDER_ADDRESS, "telebtc::TELEBTC");
        //console.log("prevBalance before burn", prevBalance,prevProtocolBalance,prevLockerBalance,prevRewarderBalance);

        let protocolFee = Math.floor(userRequestedAmount.toNumber()*PROTOCOL_PERCENTAGE_FEE/10000);
        let rewarderFee = Math.floor(userRequestedAmount.toNumber()*REWARDER_PERCENTAGE_FEE/10000);
        let lockerFee = Math.floor(userRequestedAmount.toNumber()*LOCKER_PERCENTAGE_FEE/10000)+BITCOIN_FEE; // Combined locker fee
        let result = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        //console.log("result", result.effects);
        expect(result.effects?.status?.status).toBe("success");
        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for all object settle down
        const newUserBalance = await getCoinBalance(client, burnRouterPackageId, deployerAddress, "telebtc::TELEBTC");
        const newProtocolBalance = await getCoinBalance(client, burnRouterPackageId, TREASURY, "telebtc::TELEBTC");
        const newLockerBalance = await getCoinBalance(client, burnRouterPackageId, LOCKER_TARGET_ADDRESS, "telebtc::TELEBTC");
        const newRewarderBalance = await getCoinBalance(client, burnRouterPackageId, REWARDER_ADDRESS, "telebtc::TELEBTC");
        //console.log("newUserBalance after burn", newUserBalance,newProtocolBalance,newLockerBalance,newRewarderBalance);
        //printEvents(result);
        expect(prevBalance-newUserBalance).toBe(userRequestedAmount.toNumber());
        expect(newProtocolBalance-prevProtocolBalance).toBe(protocolFee);
        expect(newLockerBalance-prevLockerBalance).toBe(lockerFee);
        expect(newRewarderBalance-prevRewarderBalance).toBe(rewarderFee);

    }, 60000);

    it('Reverts since requested amount does not cover Bitcoin fee', async () => {
        const client = new SuiClient({ url: getFullnodeUrl('localnet') });
        
        // Mint BITCOIN_FEE - 1 tokens (insufficient amount)
        const insufficientAmount = BITCOIN_FEE - 1;
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, insufficientAmount);

        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for all object settle down
        let userBalanceBeforeBurn = await getCoinBalance(client, burnRouterPackageId, deployerAddress, "telebtc::TELEBTC");
        // Try to burn with insufficient amount
        let result = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        
        // Expect failure with error code 205 (ELOW_AMOUNT)
        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(
            /MoveAbort.*235/ // low fee
        );
        
        // Verify the coin object still exists (burn didn't happen)
        const userBalance = await getCoinBalance(client, burnRouterPackageId, deployerAddress, "telebtc::TELEBTC");
        expect(userBalance).toBe(userBalanceBeforeBurn);

    }, 60000);
});

describe('BurnRouter Dispute Burn Tests', () => {
    let burnReqBlockNumber = 100;
    // call get_burn_request_count to get the number of burn requests
    let disputeRequestStartIndex = 0;
    beforeAll(async () => {
        let burnRequestCountResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_burn_request_count',
            arguments: [object(burnRouterId), pure(LOCKER_TARGET_ADDRESS)],
            signer: deployer,
            returnValue: true
        }) as any; // Type assertion for DevInspectResults
        // Parse the u64 return value correctly
        let burnRequestCountBytes = burnRequestCountResult?.results?.[0]?.returnValues?.[0]?.[0];
         // Convert byte array to u64 number (little-endian)
         let burnRequestCount = 0;
         if (burnRequestCountBytes && Array.isArray(burnRequestCountBytes)) {
             for (let i = 0; i < burnRequestCountBytes.length; i++) {
                 burnRequestCount += burnRequestCountBytes[i] * Math.pow(256, i);
             }
         }
        console.log("burnRequestCount", burnRequestCount);
        disputeRequestStartIndex = burnRequestCount || 0;
        
        
    });
    it("Disputes locker successfully", async function () {
        // Create a burn request first
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(burnResult.effects?.status?.status).toBe("success");
        
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Sets mock contracts
        await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
        await setLockersSlashIdleLockerReturn(true);
        await setLockersIsLocker(true);

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Call dispute_burn function
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_burn',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([disputeRequestStartIndex]), // burn_req_indexes
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("success");
    }, 60000);

    it("Reverts since locker has been slashed before", async function () {
        // Second dispute should fail
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_burn',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([disputeRequestStartIndex]), // burn_req_indexes
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*210/); // EALREADY_PAID
    }, 60000);

    it("Reverts since locking script is invalid", async function () {
        // Create a burn request first
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(burnResult.effects?.status?.status).toBe("success");

        // Sets mock contracts - locker is not valid
        await setLockersIsLocker(false);
        
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Call dispute_burn function
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_burn',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([disputeRequestStartIndex+1]), // burn_req_indexes
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*204/); // ENOT_LOCKER
    }, 60000);

    it("Reverts since locker has paid before hand", async function () {
        // Sets mock contracts
        await setRelayLastSubmittedHeight(burnReqBlockNumber);
        await setLockersSlashIdleLockerReturn(true);
        await setLockersIsLocker(true);

        // Create a burn request first
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(burnResult.effects?.status?.status).toBe("success");
        
        await new Promise(resolve => setTimeout(resolve, 1000));

        // provide another proof to prevent tx id conflict ( a little modfiy the vin so tx id will be different)
        // Pays the burnt amount and provides proof
        const burnProofResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic', // adjust if needed
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid2.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid2.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid2.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid2.locktime)),
                pure(burnReqBlockNumber + 5),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid2.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([disputeRequestStartIndex+2]),
                pure([0]),
                object(LockerCapId),
            ],
            signer: locker
        });
        //console.log("burnProofResult", burnProofResult);
        expect(burnProofResult.effects?.status?.status).toBe("success");
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Try to dispute after payment
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_burn',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([disputeRequestStartIndex+2]), // burn_req_indexes
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*210/); // EALREADY_PAID
    }, 60000);

    it("Reverts since deadline hasn't reached", async function () {
        // Create a burn request first
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(burnResult.effects?.status?.status).toBe("success");
        
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Try to dispute before deadline
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_burn',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([disputeRequestStartIndex+3]), // burn_req_indexes
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*211/); // EDEADLINE_NOT_PASSED
    }, 60000);
}); 

describe('BurnRouter Dispute Locker Tests', () => {
    let burnReqBlockNumber = 100;
    beforeAll(async () => {
        await setRelayReturn(true); // setRelayCheckTxProofReturn
        await setLockersIsLocker(true);
        await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
        await setLockersGetLockerTargetAddress(LOCKER_TARGET_ADDRESS);
        await setLockersSlashThiefLockerReturn(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
    });
    it("Dispute the locker who has sent its BTC to external account", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("success");
    }, 60000);

    it("Reverts since inputs are not valid", async function () {
        // Test 1: Wrong versions array length
        let result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version)]), // Only one version
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*214/); // EWRONG_INPUTS

        // Test 2: Wrong locktimes array length
        result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime)]), // Only one locktime
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*214/); // EWRONG_INPUTS

        // Test 3: Wrong indexes_and_block_numbers array length
        result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1]), // Only two values instead of three
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*214/); // EWRONG_INPUTS
    }, 60000);

    it("Reverts since locking script is not valid", async function () {
        // Sets mock contracts outputs
        await setLockersIsLocker(false);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*213/); // ENOT_LOCKER
    }, 60000);

    it("Reverts since input tx has not finalized", async function () {
        // Sets mock contracts outputs
        await setRelayReturn(false); // setRelayCheckTxProofReturn
        await setLockersIsLocker(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*215/); // ENOT_FINALIZED
        await setRelayReturn(true); // setRelayCheckTxProofReturn
        await new Promise(resolve => setTimeout(resolve, 1000));
    }, 60000);

    it("Reverts since input tx has been used as burn proof", async function () {

        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*216/); // EALDREADY_USED
    }, 60000);

    it("Reverts since outpoint doesn't match with output tx", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_invalidOutput.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input2.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input2.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_invalidOutput.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_invalidOutput.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_invalidOutput.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*218/); // EWRONG_OUTPUT_TX
    }, 60000);

    it("Reverts since tx doesn't belong to locker", async function () {

        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes("0x76a914748284390f9e263a4b766a75d0633c50426eb87587ab")), // Different locking script
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input2.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input2.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*219/); // ENOT_FOR_LOCKER
    }, 60000);

    it("Reverts since locker may submit input tx as burn proof", async function () {

        let burnRequestCountResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_burn_request_count',
            arguments: [object(burnRouterId), pure(LOCKER_TARGET_ADDRESS)],
            signer: deployer,
            returnValue: true
        }) as any; // Type assertion for DevInspectResults
        // Parse the u64 return value correctly
        let burnRequestCountBytes = burnRequestCountResult?.results?.[0]?.returnValues?.[0]?.[0];
        // Convert byte array to u64 number (little-endian)
        let burnRequestCount = 0;
        if (burnRequestCountBytes && Array.isArray(burnRequestCountBytes)) {
            for (let i = 0; i < burnRequestCountBytes.length; i++) {
                burnRequestCount += burnRequestCountBytes[i] * Math.pow(256, i);
            }
        }
        console.log("burnRequestCount", burnRequestCount);
        
        // User sends a burn request and locker provides burn proof for it
        const coinObjectId = await mintTeleBTCForTest(deployerAddress, userRequestedAmount.toNumber());
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let burnResult = await sendBurnRequest(
            USER_SCRIPT_P2PKH,
            USER_SCRIPT_P2PKH_TYPE,
            [coinObjectId],
            userRequestedAmount.toNumber()
        );
        expect(burnResult.effects?.status?.status).toBe("success");
        
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Provide burn proof using burnProof_valid3
        const burnProofResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'burn_proof',
            arguments: [
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.version)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.locktime)),
                pure(burnReqBlockNumber + 5),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.intermediateNodes)),
                pure(1),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([burnRequestCount]),
                pure([0]),
                object(LockerCapId),
            ],
            signer: locker
        });
        expect(burnProofResult.effects?.status?.status).toBe("success");
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Try to dispute the same transaction
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_logic',
            functionName: 'dispute_locker',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                object(btcrelayCapId),
                pure(hexToBytes(LOCKER1_LOCKING_SCRIPT)),
                pure([hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.version), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.version)]),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.vout)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vin)),
                pure(hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.vout)),
                pure([hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.locktime), hexToBytes(CC_BURN_REQUESTS.disputeLocker_output.locktime)]),
                pure(hexToBytes(CC_BURN_REQUESTS.burnProof_valid4.intermediateNodes)),
                pure([0, 1, burnReqBlockNumber]),
                object(LockerCapId),
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*216/); // EALREADY_USED
    }, 60000);
}); 

describe('BurnRouter Setter Tests', () => {
    beforeAll(async () => {
        // Ensure we have the admin capability
        await setRelayReturn(true);
        await setLockersIsLocker(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    it("Sets protocol percentage fee", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'set_protocol_percentage_fee',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                pure(100)
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("success");

        // Verify the fee was set correctly
        const feeResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_protocol_percentage_fee',
            arguments: [
                object(burnRouterId)
            ],
            signer: deployer,
            returnValue: true
        });
        
        const feeBytes = (feeResult as any).results?.[0]?.returnValues?.[0][0];
        let fee = 0;
        if (feeBytes && Array.isArray(feeBytes)) {
            // Convert little-endian byte array to u64
            for (let i = 0; i < feeBytes.length; i++) {
                fee += feeBytes[i] * Math.pow(256, i);
            }
        }
        expect(fee).toBe(100);
    }, 60000);

    it("Reverts since protocol percentage fee is greater than 10000", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'set_protocol_percentage_fee',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                pure(10001)
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*228/); // EINVALID_FEE
    }, 60000);

    it("Sets transfer deadline", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'set_transfer_deadline',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                pure(100)
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("success");

        // Verify the deadline was set correctly
        const deadlineResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_transfer_deadline',
            arguments: [
                object(burnRouterId)
            ],
            signer: deployer,
            returnValue: true
        });

        const deadlineBytes = (deadlineResult as any).results?.[0]?.returnValues?.[0][0];
        let deadline = 0;
        if (deadlineBytes && Array.isArray(deadlineBytes)) {
            for (let i = 0; i < deadlineBytes.length; i++) {
                deadline += deadlineBytes[i] * Math.pow(256, i);
            }
        }
        expect(deadline).toBe(100);
    }, 60000);

    it("Sets slasher reward", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'set_slasher_percentage_reward',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                pure(100)
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("success");

        // Verify the reward was set correctly
        const rewardResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_slasher_percentage_reward',
            arguments: [
                object(burnRouterId)
            ],
            signer: deployer,
            returnValue: true
        });

        const rewardBytes = (rewardResult as any).results?.[0]?.returnValues?.[0][0];
        let reward = 0;
        if (rewardBytes && Array.isArray(rewardBytes)) {
            for (let i = 0; i < rewardBytes.length; i++) {
                reward += rewardBytes[i] * Math.pow(256, i);
            }
        }
        expect(reward).toBe(100);
    }, 60000);

    it("Reverts since slasher reward is greater than 100", async function () {
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'set_slasher_percentage_reward',
            arguments: [
                object(burnRouterAdminId),
                object(burnRouterId),
                pure(10001)
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("failure");
        expect(result.effects?.status?.error).toMatch(/MoveAbort.*228/); // EINVALID_FEE
    }, 60000);

    it("Sets bitcoin fee", async function () {
        // Set bitcoin fee - this should work if the sender is the oracle
        const result = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'set_bitcoin_fee',
            arguments: [
                object(burnRouterId),
                pure(500)
            ],
            signer: deployer
        });

        expect(result.effects?.status?.status).toBe("success");

        // Verify the fee was set correctly
        const feeResult = await callMoveFunction({
            packageId: burnRouterPackageId,
            moduleName: 'burn_router_storage',
            functionName: 'get_bitcoin_fee',
            arguments: [
                object(burnRouterId)
            ],
            signer: deployer,
            returnValue: true
        });

        const feeBytes = (feeResult as any).results?.[0]?.returnValues?.[0][0];
        let fee = 0;
        if (feeBytes && Array.isArray(feeBytes)) {
            // Convert little-endian byte array to u64
            for (let i = 0; i < feeBytes.length; i++) {
                fee += feeBytes[i] * Math.pow(256, i);
            }
        }
        expect(fee).toBe(500);
    }, 60000);

});