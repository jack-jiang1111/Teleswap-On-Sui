import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { LockerFactory } from './test_factory/locker_factory';
import { getActiveKeypair } from '../scripts/helper/sui.utils';
import { beforeAll, describe, expect, test, it } from "vitest";
import BigNumber from 'bignumber.js';
import { callMoveFunction, pure, object, splitGasTokens } from "./utils/move-helper";
import {printEvents,hexToBytes,eventNotContain, parseReturnValue} from './utils/utils';
import * as fs from 'fs';
import * as path from 'path';
import { captureRejectionSymbol } from 'events';
describe("Locker", () => {
    let client: SuiClient;
    let deployer: Ed25519Keypair;
    let signer1: Ed25519Keypair;
    let signer2: Ed25519Keypair;
    
    // Factory deployment results
    let lockerPackageId: string;
    let lockerAdminCapId: string;
    let wbtcTreasuryCapId: string;
    let lockerCapId: string;
    let telebtcCapId: string;
    let telebtcTreasuryCapId: string;
    let btcrelayCapId: string;
    let burnRouterCapId: string;
    const USE_CACHED_IDS = false;
    
    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    let btcAmountToSlash = new BigNumber(10).pow(8);
    let collateralRatio = 20000;
    let liquidationRatio = 15000;
    const LOCKER_PERCENTAGE_FEE = 20; // Means %0.2
    const PRICE_WITH_DISCOUNT_RATIO = 9500; // Means %95

    // Bitcoin public key (32 bytes)
    let LOCKER1 = '0x03789ed0bb717d88f7d321a368d905e7430207ebbd82bd342cf11ae157a7ace5fd';
    let LOCKER1_PUBKEY__HASH = '0x4062c8aeed4f81c2d73ff854a2957021191e20b6';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 4; // P2PKH

    beforeAll(async () => {
        client = new SuiClient({ url: getFullnodeUrl('localnet') });
        // Flag to use cached IDs or fresh deployment
        
        if (USE_CACHED_IDS) {
            // Read from cached JSON file
            const packageIdPath = path.join(__dirname, 'package_id.json');
            const cachedData = JSON.parse(fs.readFileSync(packageIdPath, 'utf8'));
            
            lockerPackageId = cachedData.lockerPackageId;
            lockerAdminCapId = cachedData.lockerAdminCapId;
            wbtcTreasuryCapId = cachedData.wbtcTreasuryCapId;
            lockerCapId = cachedData.lockerCapId;
            telebtcCapId = cachedData.telebtcCapId;
            telebtcTreasuryCapId = cachedData.telebtcTreasuryCapId;
            btcrelayCapId = cachedData.btcrelayCapId;
            burnRouterCapId = cachedData.burnRouterCapId;
            // Get deployer from active keypair
            deployer = await getActiveKeypair();
            
            console.log('Using cached IDs from package_id.json');
        } else {
            // Use factory to create fresh deployments
            console.log('Setting up locker factory...');
            const factoryResult = await LockerFactory();
            
            deployer = factoryResult.deployer;
            lockerPackageId = factoryResult.lockerPackageId;
            lockerAdminCapId = factoryResult.lockerAdminCapId;
            wbtcTreasuryCapId = factoryResult.wbtcTreasuryCapId;
            telebtcCapId = factoryResult.telebtcCapId;
            telebtcTreasuryCapId = factoryResult.telebtcTreasuryCapId;
            btcrelayCapId = factoryResult.btcrelayCapId;
            burnRouterCapId = factoryResult.burnRouterCapId;
            console.log('Locker factory setup completed');
            console.log('WBTC Treasury Cap ID:', wbtcTreasuryCapId);
            console.log('Locker Package ID:', lockerPackageId);
            console.log('Locker Admin Cap ID:', lockerAdminCapId);
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            let initResult = await initializeLocker();
            try {
                lockerCapId = initResult.effects?.created?.[0]?.reference?.objectId as string;
                console.log("lockerCapId", lockerCapId);
            } catch (error) {
                console.log("lockerCap not found");
            }
            expect(initResult.effects?.status?.status).toBe('success');

            // Save the new IDs to JSON file
            const packageIdPath = path.join(__dirname, 'package_id.json');
            const idsToSave = {
                lockerPackageId,
                lockerAdminCapId,
                wbtcTreasuryCapId,
                lockerCapId,
                telebtcCapId,
                telebtcTreasuryCapId,
                btcrelayCapId,
                burnRouterCapId
            };
            fs.writeFileSync(packageIdPath, JSON.stringify(idsToSave, null, 2));
            console.log('Saved new IDs to package_id.json');
        }
        
        // Create additional signers for testing
        signer1 = new Ed25519Keypair();
        signer2 = new Ed25519Keypair();
        
        // Transfer some test SUI to the signers
        await new Promise(resolve => setTimeout(resolve, 1500));
        let result = await splitGasTokens(client, deployer, signer1.toSuiAddress(), 2000000000); // 2 SUI
        expect(result.effects?.status?.status).toBe('success');
        await new Promise(resolve => setTimeout(resolve, 1500));
        result = await splitGasTokens(client, deployer, signer2.toSuiAddress(), 2000000000); // 2 SUI
        expect(result.effects?.status?.status).toBe('success');
        
        console.log('Test signers created and funded');
    }, 600000); // Set timeout to 60 seconds

    

    // Helper function to mint WBTC
    async function mintWBTC(to: Ed25519Keypair, amount: number): Promise<{result: any, coinId: string}> {
        
        const tx = new TransactionBlock();
        tx.setGasBudget(500000000);

        const mintResult = tx.moveCall({
            target: `${lockerPackageId}::wbtc::mint`,
            arguments: [
                tx.object(wbtcTreasuryCapId),              // &mut TeleBTCCap
                tx.pure(amount),                                 // amount: u64
            ],
        });
        
        // Transfer the minted coins to the deployer
        tx.transferObjects([mintResult], tx.pure(to.toSuiAddress()));
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });
        //console.log("result",result);
        expect(result.effects?.status?.status).toBe("success");
        
        // Extract and return the coin object ID
        const coinObjectId = result.effects?.created?.[0]?.reference?.objectId;
        if (!coinObjectId) {
            throw new Error('Failed to get coin object ID from mint transaction');
        }
        
        
        return { result, coinId: coinObjectId };
    }

     // Helper function to mint TeleBTC
     async function mintTeleBTC(to: Ed25519Keypair, amount: number): Promise<{result: any, coinId: string}> {
        
        const tx = new TransactionBlock();
        tx.setGasBudget(500000000);

        const mintResult = tx.moveCall({
            target: `${lockerPackageId}::telebtc::mint`,
            arguments: [
                tx.object(telebtcCapId),              // &mut TeleBTCCap
                tx.object(telebtcTreasuryCapId),              // &mut TeleBTCCap
                tx.pure(amount),                                 // amount: u64
            ],
        });
        
        // Transfer the minted coins to the deployer
        tx.transferObjects([mintResult], tx.pure(to.toSuiAddress()));
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: deployer,
            options: { showEffects: true, showEvents: true }
        });
        //console.log("result",result);
        expect(result.effects?.status?.status).toBe("success");
        
        // Extract and return the coin object ID
        const coinObjectId = result.effects?.created?.[0]?.reference?.objectId;
        if (!coinObjectId) {
            throw new Error('Failed to get coin object ID from mint transaction');
        }
        
        
        return { result, coinId: coinObjectId };
    }


    // Helper function to initialize locker contract
    async function initializeLocker() {
        const result = await callMoveFunction({
            packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "initialize",
            arguments: [
                object(lockerAdminCapId), 
                pure(LOCKER_PERCENTAGE_FEE), 
                pure(collateralRatio), 
                pure(liquidationRatio), 
                pure(PRICE_WITH_DISCOUNT_RATIO)
            ],
            typeArguments: []
        });
        //console.log(result);
        console.log('Locker system initialized successfully!');
        return result;
    }
    function convertReturnValueToNumber(result: any): number {
        const returnValue = result?.results?.[0]?.returnValues?.[0]?.[0];
        if (returnValue && Array.isArray(returnValue)) {
            let value = 0;
            for (let i = 0; i < returnValue.length; i++) {
                value += returnValue[i] * Math.pow(256, i);
            }
            return value;
        }
        return 0;
    }

    describe("Setup and Initialization", () => {

        it("should deploy All the contracts successfully", () => {
            expect(lockerPackageId).toBeTruthy();
            expect(lockerPackageId).not.toBe("0x0");
            expect(lockerAdminCapId).toBeTruthy();
            expect(lockerAdminCapId).not.toBe("0x0");
            expect(wbtcTreasuryCapId).toBeTruthy();
            expect(wbtcTreasuryCapId).not.toBe("0x0");
        });

        it("should create and fund test signers", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Check if signers have SUI balance
            const signer1Balance = await client.getBalance({
                owner: signer1.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            });
            
            const signer2Balance = await client.getBalance({
                owner: signer2.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            });
            
            expect(parseInt(signer1Balance.totalBalance)).toBeGreaterThan(0);
            expect(parseInt(signer2Balance.totalBalance)).toBeGreaterThan(0);
        });
    });

    describe("#initialize", () => {
        it("should not allow re-initialization", async () => {
            // Try to call initialize again - this should fail
            let result = await initializeLocker();
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(
                /MoveAbort.*lockerstorage.*501/
            ) 
        });
    },60000);

    describe("#pauseLocker", () => {
        it("only admin can pause locker", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                const result = await callMoveFunction({
                    packageId: lockerPackageId,
                    moduleName: "lockerstorage",
                    functionName: "pause_locker",
                    arguments: [object(lockerAdminCapId), object(lockerCapId)],
                    signer: signer1
                });
                
                // If we reach here, the function didn't throw an error
                // This should fail the test
                expect(true).toBe(false); // Force test failure
            } catch (error) {
                // Function threw an error as expected
                expect(error).toBeDefined();
            }
        });

        it("contract paused successfully", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Pause the contract as admin
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "pause_locker",
                arguments: [object(lockerAdminCapId),object(lockerCapId)],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Check if the system is paused using the getter function
            result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "is_paused",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            
            // Should succeed and return the paused state
            expect(result.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(result)).toBe(1);
        });

        it("can't pause when already paused", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Try to pause again when already paused
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "pause_locker",
                arguments: [object(lockerAdminCapId),object(lockerCapId)],
                signer: deployer
            });
            
            // Should fail - already paused
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*lockerstorage.*507/); // ERROR_IS_PAUSED
        });
    },60000);

    describe("#unPauseLocker", () => {
        it("only admin can un-pause locker", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Try to unpause with non-admin signer (signer1)
            try {
                let result = await callMoveFunction({
                    packageId: lockerPackageId,
                    moduleName: "lockerstorage",
                    functionName: "unpause_locker",
                    arguments: [object(lockerAdminCapId),object(lockerCapId)],
                    signer: signer1
                });
                expect(true).toBe(false); // Force test failure
            } catch (error) {
                // Should fail with admin error
                expect(error).toBeDefined();
            }
        });

        it("contract un-paused successfully", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            // First pause the contract
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "unpause_locker",
                arguments: [object(lockerAdminCapId),object(lockerCapId)],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('success');

            // Check if the system is paused using the getter function
            result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "is_paused",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            // Should succeed and return the paused state
            expect(result.effects?.status?.status).toBe('success');
            expect(result?.results?.[0]?.returnValues?.[0]?.[0][0]).toBe(0);
        });

        it("can't un-pause when already un-paused", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Try to unpause when not paused
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "unpause_locker",
                arguments: [object(lockerAdminCapId),object(lockerCapId)],
                signer: deployer
            });
            
            // Should fail - not paused
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*lockerstorage.*508/); // ERROR_IS_UNPAUSED
        });
    },60000);




    describe("#requestToBecomeLocker", () => {

        it("successful request to become locker", async () => {
            // Mint WBTC coins for signer1 using the helper function
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
            // Request to become locker using the WBTC coin
            await new Promise(resolve => setTimeout(resolve, 1500));
            const requestResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_to_become_locker",
                arguments: [
                    object(lockerCapId),
                    pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    object(wbtcCoinId), // wbtc_coins (actual coin object)
                    pure(LOCKER_RESCUE_SCRIPT_P2PKH_TYPE), // locker_script_type
                    pure(hexToBytes(LOCKER_RESCUE_SCRIPT_P2PKH)) // locker_rescue_script
                ],
                signer: signer1
            });
            //console.log(requestResult);
            // Should succeed
            expect(requestResult.effects?.status?.status).toBe('success');

            // Verify total number of candidates increased
            await new Promise(resolve => setTimeout(resolve, 1500));
            const candidateResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "total_number_of_candidates",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            //console.log("candidateResult",candidateResult);
            // Should succeed and return 1 candidate
            expect(candidateResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(candidateResult)).toBe(1);
        },20000);

        it("a locker can't requestToBecomeLocker twice", async () => {
            // Mint WBTC coins for signer1 using the helper function
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
            // Try to request again - should fail
            await new Promise(resolve => setTimeout(resolve, 1500));
            const secondRequestResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_to_become_locker",
                arguments: [
                    object(lockerCapId),
                    pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // Same script hash as signer1
                    object(wbtcCoinId), // wbtc_coins (actual coin object)
                    pure(LOCKER_RESCUE_SCRIPT_P2PKH_TYPE), // locker_script_type
                    pure(hexToBytes(LOCKER_RESCUE_SCRIPT_P2PKH)) // locker_rescue_script
                ],
                signer: signer1
            });
            
            // Should fail - already a candidate
            expect(secondRequestResult.effects?.status?.status).toBe('failure');
            expect(secondRequestResult.effects?.status?.error).toMatch(/MoveAbort.*lockerhelper.*524/); // ERROR_ALREADY_CANDIDATE
        });
    },60000);
    describe("#revokeRequest", () => {
        
        it("successful revoke", async function () {

            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "revoke_request",
                arguments: [object(lockerCapId)],
                signer: signer1
            });

            expect(result.effects?.status?.status).toBe('success');
            // Verify total number of candidates decreased
            const candidateResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "total_number_of_candidates",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            //console.log("candidateResult",candidateResult);
            // Should succeed and return 0 candidate
            expect(candidateResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(candidateResult)).toBe(0);
        })

        it("trying to revoke a non existing request", async function () {
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "revoke_request",
                arguments: [object(lockerCapId)],
                signer: signer1
            });

            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOt_locker
        })

    },60000);
    describe("#addLocker", async () => {

        it("trying to add a non existing request as a locker", async function () {
            try{
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_locker",
                arguments: [
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()),
                    pure(1)],
                signer: signer1
            });
            expect(true).toBe(false);
        }catch(error){
            // this is expected since locker admin is not owned by signer1
        }
        })

        it("adding a locker", async function () {
            // Mint WBTC coins for signer1 using the helper function
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
            // Request to become locker using the WBTC coin            
            await new Promise(resolve => setTimeout(resolve, 1500));
            const requestResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_to_become_locker",
                arguments: [
                    object(lockerCapId),
                    pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    object(wbtcCoinId), // wbtc_coins (actual coin object)
                    pure(LOCKER_RESCUE_SCRIPT_P2PKH_TYPE), // locker_script_type
                    pure(hexToBytes(LOCKER_RESCUE_SCRIPT_P2PKH)) // locker_rescue_script
                ],
                signer: signer1
            });
            expect(requestResult.effects?.status?.status).toBe('success');

            // Add locker using the WBTC coin
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_locker",
                arguments: [
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()),
                    pure(10000)],
                signer: deployer
            });

            expect(result.effects?.status?.status).toBe('success');

            // Verify total number of candidates decreased
            await new Promise(resolve => setTimeout(resolve, 1500));
            const candidateResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "total_number_of_candidates",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });

            expect(candidateResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(candidateResult)).toBe(0);

            // Verify total number of lockers increased
            await new Promise(resolve => setTimeout(resolve, 1500));
            const lockerResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "total_number_of_lockers",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });

            expect(lockerResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(lockerResult)).toBe(1);

           // call locker_exists function to verify the locker exists
           await new Promise(resolve => setTimeout(resolve, 1500));
           const lockerExistsResult = await callMoveFunction({
            packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "locker_exists",
            arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
            signer: deployer,
            returnValue: true
           });

           expect(lockerExistsResult.effects?.status?.status).toBe('success');
           expect(convertReturnValueToNumber(lockerExistsResult)).toBe(1);
        },30000)

        //Additional verification tests for the added locker
        it("should verify locker target address mapping", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Check if get_locker_target_address returns the correct address for the locking script
            const targetAddressResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "get_locker_target_address",
            arguments: [pure(hexToBytes(LOCKER1_PUBKEY__HASH)), object(lockerCapId)],
            signer: deployer,
            returnValue: true
        });
            
            expect(targetAddressResult.effects?.status?.status).toBe('success');
            expect("0x"+parseReturnValue(targetAddressResult?.results?.[0]?.returnValues?.[0]?.[0])).toBe(signer1.toSuiAddress());
            
        },60000);

        it("should verify locker status checks", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Check if is_locker returns true for the locking script
            const isLockerResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "is_locker",
            arguments: [object(lockerCapId), pure(hexToBytes(LOCKER1_PUBKEY__HASH))],
            signer: deployer,
            returnValue: true
        });
            
            expect(isLockerResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(isLockerResult)).toBe(1); // Should return true (1)
        });

        it("should verify locker status by address", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Check if is_locker_by_address returns true for signer1's address
            const isLockerByAddressResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "is_locker_by_address",
            arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
            signer: deployer,
            returnValue: true
        });
            
            expect(isLockerByAddressResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(isLockerByAddressResult)).toBe(1); // Should return true (1)
        });

        it("should verify locker is active", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Check if is_locker_active returns true for signer1's address
            const isLockerActiveResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "is_locker_active",
            arguments: [object(lockerCapId), pure(signer1.toSuiAddress()),object('0x6')],
            signer: deployer,
            returnValue: true
            });
            
            expect(isLockerActiveResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(isLockerActiveResult)).toBe(1); // Should return true (1)
        });

        it("should verify locker collateral amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Get the locker collateral amount by address
            const collateralAmountResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "get_locker_collateral_token_balance",
            arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
            signer: deployer,
            returnValue: true
            });
            
            expect(collateralAmountResult.effects?.status?.status).toBe('success');
            // Should return the amount we minted (100000000 = 1 WBTC)
            expect(convertReturnValueToNumber(collateralAmountResult)).toBe(100000000);
        });

        it("should verify WBTC collateral balance", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Check the total WBTC collateral balance in the contract
            const wbtcBalanceResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "get_wbtc_collateral_balance",
            arguments: [object(lockerCapId)],
            signer: deployer,
            returnValue: true
            });
            
            expect(wbtcBalanceResult.effects?.status?.status).toBe('success');
            // Should return the same amount we minted (100000000 = 1 WBTC)
            expect(convertReturnValueToNumber(wbtcBalanceResult)).toBe(100000000);
        });
    },60000);

    describe("#slashIdleLocker", async () => {

        it("slash locker reverts when the target address is not locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "slash_idle_locker",
                arguments: [
                    pure(signer2.toSuiAddress()), // target address (not a locker)
                    pure(10000), // reward amount
                    pure(deployer.toSuiAddress()), // slasher
                    pure(10000), // amount to slash (small amount)
                    pure(deployer.toSuiAddress()), // recipient
                    object(lockerCapId),
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
                
        });

        it("slash the locker small amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));

            // get the locker collateral amount before slashing
            const beforeResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                signer: deployer,
                returnValue: true
            });
            expect(beforeResult.effects?.status?.status).toBe('success');
            const beforeAmount = convertReturnValueToNumber(beforeResult);


            const recipientBalanceBefore = await client.getBalance({
                owner: signer2.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            const rewarderBalanceBefore = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });


            // Now try to slash the locker
            let slashResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "slash_idle_locker",
                arguments: [
                    pure(signer1.toSuiAddress()),
                    pure(100), // reward amount
                    pure(deployer.toSuiAddress()), // slasher
                    pure(10000), // amount to slash 
                    pure(signer2.toSuiAddress()), // recipient
                    object(lockerCapId),
                ],
                signer: deployer
            });
            //await printEvents(slashResult);
            expect(slashResult.effects?.status?.status).toBe('success');

            // Now verify the locker is slashed
            await new Promise(resolve => setTimeout(resolve, 1500));
            // get the locker collateral amount after slashing
            const afterResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                signer: deployer,
                returnValue: true
            });
            expect(afterResult.effects?.status?.status).toBe('success');
            const afterAmount = convertReturnValueToNumber(afterResult);


            // verify the locker is slashed
            expect(beforeAmount - afterAmount).toBe(10100);

            // recipient should have received the slashed amount
            const recipientBalance = await client.getBalance({
                owner: signer2.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            expect(Number(recipientBalance.totalBalance)-Number(recipientBalanceBefore.totalBalance)).toBe(10000);

            // verify the rewarder has received the reward
            const rewarderBalanceAfter = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            expect(Number(rewarderBalanceAfter.totalBalance)-Number(rewarderBalanceBefore.totalBalance)).toBe(100);
        });

        it("slash the locker max amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));

            // get the locker collateral amount before slashing
            const beforeResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                signer: deployer,
                returnValue: true
            });
            expect(beforeResult.effects?.status?.status).toBe('success');
            const beforeAmount = convertReturnValueToNumber(beforeResult);


            const recipientBalanceBefore = await client.getBalance({
                owner: signer2.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            const rewarderBalanceBefore = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });


            // Now try to slash the locker
            let slashResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "slash_idle_locker",
                arguments: [
                    pure(signer1.toSuiAddress()),
                    pure(3000), // reward amount
                    pure(deployer.toSuiAddress()), // slasher
                    pure(1000000000), // amount to slash 
                    pure(signer2.toSuiAddress()), // recipient
                    object(lockerCapId),
                ],
                signer: deployer
            });
            await printEvents(slashResult);
            //console.log("slashResult",slashResult);
            expect(slashResult.effects?.status?.status).toBe('success');

            // Now verify the locker is slashed
            await new Promise(resolve => setTimeout(resolve, 1500));
            // get the locker collateral amount after slashing
            const afterResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                signer: deployer,
                returnValue: true
            });
            expect(afterResult.effects?.status?.status).toBe('success');
            const afterAmount = convertReturnValueToNumber(afterResult);

            //console.log("beforeAmount",beforeAmount);
            //console.log("afterAmount",afterAmount);
            // verify the locker is slashed
            expect(afterAmount).toBe(0);
            // Calculate reward amount using the same logic as Move: final_equivalent_collateral_token - ((final_equivalent_collateral_token * _amount) / (_amount + _reward_amount))
            // In this test: _amount = 1000000000, _reward_amount = 3000
            let actual_reward_amount = beforeAmount - Math.floor((beforeAmount * 1000000000) / (1000000000 + 3000));
            //console.log("actual_reward_amount",actual_reward_amount);
            // recipient should have received the slashed amount
            const recipientBalance = await client.getBalance({
                owner: signer2.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            expect(Number(recipientBalance.totalBalance)-Number(recipientBalanceBefore.totalBalance)).toBe(beforeAmount-actual_reward_amount);

            // verify the rewarder has received the reward
            const rewarderBalanceAfter = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            expect(Number(rewarderBalanceAfter.totalBalance)-Number(rewarderBalanceBefore.totalBalance)).toBe(actual_reward_amount);
        });

    },60000);

    describe("#addCollateral", () => {
        it("can't add collateral for a non locker account", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Mint some WBTC for signer2 to use
            const { coinId: wbtcCoinId } = await mintWBTC(signer2, 10000);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()), // signer1's address (not a locker)
                    object(wbtcCoinId) // WBTC coins
                ],
                signer: signer2
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
        });

        it("adding collateral to the locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));``
            // Get locker collateral amount before adding
            const beforeResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress())
                ],
                signer: deployer,
                returnValue: true
            });
            expect(beforeResult.effects?.status?.status).toBe('success');
            const beforeAmount = convertReturnValueToNumber(beforeResult);

            // Add collateral
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const addCollateralResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()),
                    object(wbtcCoinId)
                ],
                signer: signer1
            });
            expect(addCollateralResult.effects?.status?.status).toBe('success');

            // Get locker collateral amount after adding
            const afterResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress())
                ],
                signer: deployer,
                returnValue: true
            });
            expect(afterResult.effects?.status?.status).toBe('success');
            const afterAmount = convertReturnValueToNumber(afterResult);

            // Verify the collateral amount increased by 100000000 (1btc)
            expect(afterAmount - beforeAmount).toBe(100000000);
        });
    },60000);

    describe("#removeCollateral", () => {
        it("can't remove collateral for a non locker account", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "remove_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(1000), // amount to remove
                    object('0x6') // clock
                ],
                signer: signer2
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
        });

        it("reverts because locker is still active", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500)); 
            
            // Try to remove collateral while locker is still active

            const result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "remove_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(50000000), // half of min required amount
                    object('0x6') // clock
                ],
                signer: signer1
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*513/); // ERROR_LOCKER_ACTIVE
        
        });

        it("reverts because it's more than capacity", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            //call set_inactivation_delay function to set the inactivation delay to 0
            const setInactivationDelayResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_inactivation_delay",
                arguments: [object(lockerCapId), object(lockerAdminCapId), pure(3)],
                signer: deployer
            });
            // the inactivation_delay will be 3s
            expect(setInactivationDelayResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Request inactivation
            const inactivationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(inactivationResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 3000));
            // wait for 3s, this should pass the inactivation delay

            // Try to remove more than capacity
            const result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "remove_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(100000000), // amount to remove
                    object('0x6') // clock
                ],
                signer: signer1
            });
            //await printEvents(result);
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*519/); // ERROR_MORE_THAN_MAX_REMOVABLE_COLLATERAL
            
        });

        it("remove collateral successfully", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Get locker collateral amount before removing
            const beforeResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress())
                ],
                signer: deployer,
                returnValue: true
            });
            expect(beforeResult.effects?.status?.status).toBe('success');
            const beforeAmount = convertReturnValueToNumber(beforeResult);

            const wbtcBalanceBefore = await client.getBalance({
                owner: signer1.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
           
            // check locker capacity
            const capacityResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_capacity",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                returnValue: true
            });
            expect(capacityResult.effects?.status?.status).toBe('success');
            const capacity = convertReturnValueToNumber(capacityResult);
            console.log("capacity",capacity);
            

            // Remove collateral successfully
            const removeCollateralResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "remove_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(10000), // only remove 10000
                    object('0x6') // clock
                ],
                signer: signer1
            });
            //console.log("removeCollateralResult",removeCollateralResult);
            await printEvents(removeCollateralResult);
            expect(removeCollateralResult.effects?.status?.status).toBe('success');

            // Get locker collateral amount after removing
            const afterResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress())
                ],
                signer: deployer,
                returnValue: true
            });
            expect(afterResult.effects?.status?.status).toBe('success');
            const afterAmount = convertReturnValueToNumber(afterResult);

            // Verify the collateral amount decreased by the expected amount
            expect(beforeAmount - afterAmount).toBe(10000);

            // also need to verify the token back to signer1 wallet
            const wbtcBalanceAfter = await client.getBalance({
                owner: signer1.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            const delta = Number(wbtcBalanceAfter.totalBalance) - Number(wbtcBalanceBefore.totalBalance);
            expect(delta).toBe(10000);

            // active the locker back
            const activationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_activation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(activationResult.effects?.status?.status).toBe('success');
            
        });
    },60000);

    describe("#slashTheifLocker", () => {
        
        it("slash locker reverts when the target address is not locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
    
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "slash_thief_locker",
                arguments: [
                    pure(signer2.toSuiAddress()), // target address (not a locker)
                    pure(0), // reward amount
                    pure(deployer.toSuiAddress()), // slasher
                    pure(btcAmountToSlash.toNumber()), // amount to slash
                    object(lockerCapId)
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*237/); // ERROR_NOT_LOCKER
               
        });

        it("cc burn can slash a locker", async function () {
            // Now slash the thief locker
            await new Promise(resolve => setTimeout(resolve, 1500));

            // get the locker collateral amount before slashing
            const beforeResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                signer: deployer,
                returnValue: true
            });
            expect(beforeResult.effects?.status?.status).toBe('success');
            const beforeAmount = convertReturnValueToNumber(beforeResult);


            const slasherBalanceBefore = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });

            let slashResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "slash_thief_locker",
                arguments: [
                    pure(signer1.toSuiAddress()),
                    pure(300), // reward amount
                    pure(deployer.toSuiAddress()), // slasher
                    pure(10000), // amount to slash (TeleBTC amount)
                    object(lockerCapId)
                ],
                signer: deployer
            });
            await printEvents(slashResult);
            expect(slashResult.effects?.status?.status).toBe('success');

            await new Promise(resolve => setTimeout(resolve, 1500));

            // get the locker collateral amount after slashing

            const afterResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_locker_collateral_token_balance",
                arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
                signer: deployer,
                returnValue: true
            });
            expect(afterResult.effects?.status?.status).toBe('success');
            const afterAmount = convertReturnValueToNumber(afterResult);

            let totalSlashed = 10000*1.5+300;
            // verify the locker is slashed
            expect(beforeAmount - afterAmount).toBe(totalSlashed);

            // verify the slasher has received the reward
            const slasherBalanceAfter = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            expect(Number(slasherBalanceAfter.totalBalance)-Number(slasherBalanceBefore.totalBalance)).toBe(300);

        });

    },60000);

   
    describe("#buySlashedCollateralOfLocker", () => {
        
        it("reverts when the target address is not locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 100); // 100 satoshi TeleBTC
            await new Promise(resolve => setTimeout(resolve, 1500));
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "buy_slashed_collateral_of_locker",
                arguments: [
                    pure(signer2.toSuiAddress()), // target address (not a locker)
                    pure(10), // collateral amount to buy
                    object(telebtcCoinId), // telebtc coins
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId)
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
              
        });

        it("not enough slashed amount to buy", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 100); // 100 satoshi TeleBTC

            // ccBurn calls to slash the locker
            await new Promise(resolve => setTimeout(resolve, 1500));
            let slashResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "buy_slashed_collateral_of_locker",
                arguments: [
                    pure(signer1.toSuiAddress()),
                    pure(1000000000), // reward amount
                    object(telebtcCoinId),
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                ],
                signer: deployer
            });
            expect(slashResult.effects?.status?.status).toBe('failure');
            expect(slashResult.effects?.status?.error).toMatch(/MoveAbort.*528/); // ERROR_INSUFFICIENT_COLLATERAL_FOR_SLASH
        });

        it("can't slash because needed Telebtc is not enough ", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 100); // 100 satoshi TeleBTC

            // ccBurn calls to slash the locker
            await new Promise(resolve => setTimeout(resolve, 1500));
            let slashResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "buy_slashed_collateral_of_locker",
                arguments: [
                    pure(signer1.toSuiAddress()),
                    pure(1000), // reward amount
                    object(telebtcCoinId),
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                ],
                signer: deployer
            });
            expect(slashResult.effects?.status?.status).toBe('failure');
            expect(slashResult.effects?.status?.error).toMatch(/MoveAbort.*533/); // ERROR_INSUFFICIENT_COLLATERAL_FOR_SLASH
        });

        it("can buy slashing amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 1000); // 1000 satoshi TeleBTC
            
            // ccBurn 
            await new Promise(resolve => setTimeout(resolve, 1500));
            let slashResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "buy_slashed_collateral_of_locker",
                arguments: [
                    pure(signer1.toSuiAddress()),
                    pure(1000), // reward amount
                    object(telebtcCoinId),
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                ],
                signer: deployer
            });
            expect(slashResult.effects?.status?.status).toBe('success');

        });

    },60000);

    describe("#mint", () => {

        it("successfully mints TeleBTC", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Get TeleBTC balance before minting
            const telebtcBalanceBefore = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::telebtc::TELEBTC`
            });

            // Mint TeleBTC by directly constructing the transaction
            const mintAmount = 10000;
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Call the mint function - it will mint TeleBTC to the receiver address
            // The mint function returns (Coin<TELEBTC>, address) but we don't need to handle the return value
            // since the TeleBTC is already minted to the receiver address specified in the arguments
            const [coin, address] = tx.moveCall({
                target: `${lockerPackageId}::lockercore::mint`,
                arguments: [
                    tx.pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    tx.pure(mintAmount), // amount
                    tx.object(lockerCapId),
                    tx.object(telebtcCapId),
                    tx.object(telebtcTreasuryCapId),
                    tx.pure(deployer.toSuiAddress()), // receiver
                    tx.object('0x6') // clock
                ],
            });

            // Transfer the minted TeleBTC coin to the deployer
            tx.transferObjects([coin], tx.pure(deployer.toSuiAddress()));

            // Execute the transaction
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            //console.log("result", result);
            expect(result.effects?.status?.status).toBe('success');

            // Verify TeleBTC was minted to receiver
            await new Promise(resolve => setTimeout(resolve, 1500));
            const telebtcBalanceAfter = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::telebtc::TELEBTC`
            });
            expect(Number(telebtcBalanceAfter.totalBalance) - Number(telebtcBalanceBefore.totalBalance)).toBe(mintAmount);
        });

        it("can't mint with more than capacity amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "mint",
                arguments: [
                    pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    pure(1000000000), // zero amount
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                    pure(deployer.toSuiAddress()), // receiver
                    object('0x6') // clock
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*529/); // ERROR_INSUFFICIENT_CAPACITY
        });

        it("can't mint with receiver when locker is not active", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // set inactive delay to 3s
            let setInactivationDelayResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_inactivation_delay",
                arguments: [object(lockerCapId), object(lockerAdminCapId), pure(3)],
                signer: deployer
            });
            expect(setInactivationDelayResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1500));

            // set locker to inactive
            let inactivationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(inactivationResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 3000));

            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            // Call the mint function - it will mint TeleBTC to the receiver address
            // The mint function returns (Coin<TELEBTC>, address) but we don't need to handle the return value
            // since the TeleBTC is already minted to the receiver address specified in the arguments
            const [coin, address] = tx.moveCall({
                target: `${lockerPackageId}::lockercore::mint`,
                arguments: [
                    tx.pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    tx.pure(1000), // amount
                    tx.object(lockerCapId),
                    tx.object(telebtcCapId),
                    tx.object(telebtcTreasuryCapId),
                    tx.pure(signer1.toSuiAddress()), // receiver
                    tx.object('0x6') // clock
                ],
            });

            // Transfer the minted TeleBTC coin to the deployer
            tx.transferObjects([coin], tx.pure(deployer.toSuiAddress()));
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Execute the transaction
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*531/); // ERROR_NOT_ACTIVE

            // request activation
            let activationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_activation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(activationResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1500));
            // set back delay to 86400s
            let setInactivationDelayResult2 = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_inactivation_delay",
                arguments: [object(lockerCapId), object(lockerAdminCapId), pure(86400)],
                signer: deployer
            });
            expect(setInactivationDelayResult2.effects?.status?.status).toBe('success');
        });


    },60000);

    describe("#burn", () => {
        it("can't burn with more than net minted amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // mint some telebtc for testing
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 1000000000); // 100 satoshi TeleBTC

            await new Promise(resolve => setTimeout(resolve, 1500));
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "burn",
                arguments: [
                    pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    object(telebtcCoinId), // amount
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                    object(lockerCapId), // locker_cap
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*235/); // ERROR_INSUFFICIENT_FUNDS
        });

        it("successfully burns TeleBTC", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // mint some telebtc for testing
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 1000); // 100 satoshi TeleBTC

            await new Promise(resolve => setTimeout(resolve, 1500));
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "burn_router_locker_connector",
                functionName: "burn",
                arguments: [
                    pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
                    object(telebtcCoinId), // amount
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                    object(lockerCapId), // locker_cap
                ],
                signer: deployer
            });
            //console.log("result", result);
            expect(result.effects?.status?.status).toBe('success');

        });
    },60000);

    describe("#liquidateLocker", () => {
        
        it("liquidate locker reverts when the target address is not locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // mint some telebtc for testing
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 1000); // 100 satoshi TeleBTC
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Try to liquidate a non-locker address (signer2)
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "liquidate_locker",
                arguments: [
                    pure(signer2.toSuiAddress()), // target address (not a locker)
                    pure(1000), // collateral amount to liquidate
                    object(telebtcCoinId), // telebtc coins (we'll need to create this)
                    object(lockerAdminCapId), // locker_admin_cap
                    object(lockerCapId), // locker_cap
                    object(telebtcCapId), // telebtc_cap
                    object(telebtcTreasuryCapId), // telebtc_treasury_cap
                    object(btcrelayCapId), // btcrelay_cap
                    object(burnRouterCapId), // burn_router_cap
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*535/); // ERROR_NOT_LOCKER
        });

        it("can't liquidate because it's above liquidation ratio", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // First mint some TeleBTC to make the locker healthy
            let { coinId: telebtcCoinId } = await mintTeleBTC(deployer, 1000);

            // Now try to liquidate - should fail because locker is healthy
            await new Promise(resolve => setTimeout(resolve, 1500));
            

            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "liquidate_locker",
                arguments: [
                    pure(signer1.toSuiAddress()), // target address (not a locker)
                    pure(1000), // collateral amount to liquidate
                    object(telebtcCoinId), // telebtc coins (we'll need to create this)
                    object(lockerAdminCapId), // locker_admin_cap
                    object(lockerCapId), // locker_cap
                    object(telebtcCapId), // telebtc_cap
                    object(telebtcTreasuryCapId), // telebtc_treasury_cap
                    object(btcrelayCapId), // btcrelay_cap
                    object(burnRouterCapId), // burn_router_cap
                ],
                signer: deployer
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*526/); // ERROR_HEALTH_LOCKER
        });


        it("successfully liquidate the locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // First get the locker capacity and health factor
            let getLockerCapacity = new TransactionBlock();
            getLockerCapacity.setGasBudget(500000000);

            getLockerCapacity.moveCall({
                target: `${lockerPackageId}::lockerstorage::get_locker_capacity`,
                arguments: [
                    getLockerCapacity.object(lockerCapId),
                    getLockerCapacity.pure(signer1.toSuiAddress()),
                ],
            });

            let lockerCapacityResult = await client.devInspectTransactionBlock({
                transactionBlock: getLockerCapacity,
                sender: deployer.toSuiAddress(),
            });
            expect(lockerCapacityResult.effects?.status?.status).toBe('success');
            let lockerCapacity = convertReturnValueToNumber(lockerCapacityResult);
            console.log("lockerCapacity", lockerCapacity);

            let healthFactorResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "calculate_health_factor",
                arguments: [pure(signer1.toSuiAddress()),object(lockerCapId),pure(10000)],
                signer: deployer,
                returnValue: true
            });
            expect(healthFactorResult.effects?.status?.status).toBe('success');
            console.log("healthFactorResult", convertReturnValueToNumber(healthFactorResult));

            await new Promise(resolve => setTimeout(resolve, 1500));


            // Next, mint a large amount to make the locker unhealthy
            const mintAmount = Math.floor(lockerCapacity*0.75); // 75% of the locker capacity
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);

            let [telebtcCoin, lockerAddress] = tx.moveCall({
                target: `${lockerPackageId}::lockercore::mint`,
                arguments: [
                    tx.pure(hexToBytes(LOCKER1_PUBKEY__HASH)),
                    tx.pure(mintAmount),
                    tx.object(lockerCapId),
                    tx.object(telebtcCapId),
                    tx.object(telebtcTreasuryCapId),
                    tx.pure(signer2.toSuiAddress()),
                    tx.object('0x6')
                ],
            });
            tx.transferObjects([telebtcCoin], tx.pure(deployer.toSuiAddress()));

            const mintResult = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });
            //console.log("mintResult", mintResult);
            printEvents(mintResult);
            expect(mintResult.effects?.status?.status).toBe('success');

            await new Promise(resolve => setTimeout(resolve, 1500));
            // Then adjust the price modifier to 50% to mock the collateral token price drop
            let setPriceModifier = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_price_modifier",
                arguments: [object(lockerCapId), pure(5000)],
            });
            expect(setPriceModifier.effects?.status?.status).toBe('success');

            // check the health factor again, it should be less than 100%, qualified for liquidation
            await new Promise(resolve => setTimeout(resolve, 1500));
            let healthFactorResult2 = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "calculate_health_factor",
                arguments: [pure(signer1.toSuiAddress()),object(lockerCapId),pure(10000)],
                signer: deployer,
                returnValue: true
            });
            expect(healthFactorResult2.effects?.status?.status).toBe('success');
            console.log("healthFactorResult2", convertReturnValueToNumber(healthFactorResult2));


             // Get deployer's WBTC balance before liquidation
             const deployerWbtcBalanceBefore = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });

            await new Promise(resolve => setTimeout(resolve, 1500));

            // Now liquidate the locker
            // Mint some TeleBTC for the liquidation
            const { coinId: telebtcCoinId } = await mintTeleBTC(deployer, lockerCapacity);
            await new Promise(resolve => setTimeout(resolve, 1500));
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "liquidate_locker",
                arguments: [
                    pure(signer1.toSuiAddress()), // target address (signer1 is a locker)
                    pure(lockerCapacity), // collateral amount to liquidate
                    object(telebtcCoinId), // telebtc coins
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(telebtcTreasuryCapId),
                    object(btcrelayCapId), // btcrelay (placeholder)
                    object(burnRouterCapId), // burn_router (placeholder)
                ],
                signer: deployer
            });
            //console.log("result", result);
            printEvents(result);
            expect(result.effects?.status?.status).toBe('success');

            // Verify deployer received WBTC from liquidation
            await new Promise(resolve => setTimeout(resolve, 1500));
            const deployerWbtcBalanceAfter = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            
            // Deployer should have received approximately the locker capacity
            const receivedAmount = Number(deployerWbtcBalanceAfter.totalBalance) - Number(deployerWbtcBalanceBefore.totalBalance);
            expect(receivedAmount).toBeCloseTo(lockerCapacity, 8); 
        });

    },60000);
     describe("#requestActivation", () => {

        it("trying to request to a non existing locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            
            const result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_activation",
                arguments: [object(lockerCapId)],
                signer: signer2
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
        });

        it("successfully request to be activated", async function () {
            // Now test request inactivation
            await new Promise(resolve => setTimeout(resolve, 1500));
            const activationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_activation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            //console.log("activationResult",activationResult);
            expect(activationResult.effects?.status?.status).toBe('success');
        });
    },60000);

    describe("#requestInactivation", () => {
        it("trying to request to remove a non existing locker", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            
            const result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer2
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
        });

        it("successfully request to be removed", async function () {
            // Now test request inactivation
            await new Promise(resolve => setTimeout(resolve, 1500));
            const inactivationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            //console.log("inactivationResult",inactivationResult);
            expect(inactivationResult.effects?.status?.status).toBe('success');

            // Try to request inactivation again - should fail
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const secondInactivationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(secondInactivationResult.effects?.status?.status).toBe('failure');
            expect(secondInactivationResult.effects?.status?.error).toMatch(/MoveAbort.*518/); // ERORR_ALREADY_REQUESTED

            // Now test request inactivation
            await new Promise(resolve => setTimeout(resolve, 1500));
            const activationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_activation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            //console.log("activationResult",activationResult);
            expect(activationResult.effects?.status?.status).toBe('success');
        });
    },60000);

    describe("#setter functions", () => {

        // setLockerPercentageFee tests
        it("non owners can't call setLockerPercentageFee", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                let result = await callMoveFunction({
                    packageId: lockerPackageId,
                    moduleName: "lockerstorage",
                    functionName: "set_locker_percentage_fee",
                    arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
                    signer: signer1
                });
                expect(true).toBe(false);
            } catch (error) {
                expect(error).toBeDefined();
            }
        });

        it("only owner can call setLockerPercentageFee", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Set locker percentage fee as admin
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_locker_percentage_fee",
                arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
                signer: deployer
            });
            
            // Should succeed
            expect(result.effects?.status?.status).toBe('success');

            // Verify the fee was set correctly using the getter function
            await new Promise(resolve => setTimeout(resolve, 1500));
            result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "locker_percentage_fee",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            
            // Should succeed and return the new fee value
            expect(result.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(result)).toBe(2100);
        });

        // setPriceWithDiscountRatio tests
        it("non owners can't call setPriceWithDiscountRatio", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                let result = await callMoveFunction({
                    packageId: lockerPackageId,
                    moduleName: "lockerstorage",
                    functionName: "set_price_with_discount_ratio",
                    arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
                    signer: signer1
                });
                expect(true).toBe(false);
            } catch (error) {
                expect(error).toBeDefined();
            }
        });

        it("only owner can call setPriceWithDiscountRatio", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Set price with discount ratio as admin
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_price_with_discount_ratio",
                arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
                signer: deployer
            });
            
            // Should succeed
            expect(result.effects?.status?.status).toBe('success');

            // Verify the ratio was set correctly using the getter function
            await new Promise(resolve => setTimeout(resolve, 1500));
            result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "price_with_discount_ratio",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            
            // Should succeed and return the new ratio value
            expect(result.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(result)).toBe(2100);
        });

        // setCollateralRatio tests
        it("non owners can't call setCollateralRatio", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                    let result = await callMoveFunction({
                        packageId: lockerPackageId,
                        moduleName: "lockerstorage",
                        functionName: "set_collateral_ratio",
                        arguments: [object(lockerAdminCapId), object(lockerCapId), pure(21000)],
                        signer: signer1
                    });
                    expect(true).toBe(false);
                } catch (error) {
                    expect(error).toBeDefined();
                }
        });

        it("only owner can call setCollateralRatio", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Set collateral ratio as admin
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_collateral_ratio",
                arguments: [object(lockerAdminCapId), object(lockerCapId), pure(21000)],
                signer: deployer
            });
            
            // Should succeed
            expect(result.effects?.status?.status).toBe('success');

            // Verify the ratio was set correctly using the getter function
            await new Promise(resolve => setTimeout(resolve, 1500));
            result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "collateral_ratio",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            
            // Should succeed and return the new ratio value
            expect(result.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(result)).toBe(21000);
        });

        // setLiquidationRatio tests
        it("non owners can't call setLiquidationRatio", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                let result = await callMoveFunction({
                    packageId: lockerPackageId,
                    moduleName: "lockerstorage",
                    functionName: "set_liquidation_ratio",
                    arguments: [object(lockerAdminCapId), object(lockerCapId), pure(19000)],
                    signer: signer1
                });
                expect(true).toBe(false);
            } catch (error) {
                expect(error).toBeDefined();
            }
        });

        it("only owner can call setLiquidationRatio", async () => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Set liquidation ratio as admin
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_liquidation_ratio",
                arguments: [object(lockerAdminCapId), object(lockerCapId), pure(19000)],
                signer: deployer
            });
            
            // Should succeed
            expect(result.effects?.status?.status).toBe('success');

            // Verify the ratio was set correctly using the getter function
            await new Promise(resolve => setTimeout(resolve, 1500));
            result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "liquidation_ratio",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            
            // Should succeed and return the new ratio value
            expect(result.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(result)).toBe(19000);
        });
    },60000);
    

    describe("#selfRemoveLocker", () => {
        it("a non-existing locker can't be removed", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);
            
            // Create a zero coin for the telebtc_coins parameter
            const zeroCoin = tx.moveCall({
                target: `${lockerPackageId}::telebtc::zero_coin`,
                arguments: []
            });

            // Add collateral
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 10000);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const addCollateralResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_collateral",
                arguments: [
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()),
                    object(wbtcCoinId)
                ],
                signer: signer1
            });
            expect(addCollateralResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1500));
            tx.moveCall({
                target: `${lockerPackageId}::lockermanager::self_remove_locker`,
                arguments: [
                    tx.object(lockerCapId),
                    tx.object(telebtcCapId),
                    tx.object(telebtcTreasuryCapId),
                    tx.object(zeroCoin),
                    tx.object('0x6'),
                ]
            });
           
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer2,
                options: { showEffects: true, showEvents: true }
            });
    
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
        });
    
        it("can't remove a locker if it doesn't request to be removed", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);
            
            // Create a zero coin for the telebtc_coins parameter
            const zeroCoin = tx.moveCall({
                target: `${lockerPackageId}::telebtc::zero_coin`,
                arguments: []
            });
            
            tx.moveCall({
                target: `${lockerPackageId}::lockermanager::self_remove_locker`,
                arguments: [
                    tx.object(lockerCapId),
                    tx.object(telebtcCapId),
                    tx.object(telebtcTreasuryCapId),
                    tx.object(zeroCoin),
                    tx.object('0x6')
                ]
            });
           
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer1,
                options: { showEffects: true, showEvents: true }
            });
            //console.log(result)
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*513/); // ERROR_LOCKER_ACTIVE
        });
    
        it("the locker can't be removed because netMinted is not zero", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const setInactivationDelayResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_inactivation_delay",
                arguments: [object(lockerCapId), object(lockerAdminCapId), pure(3)],
                signer: deployer
            });
            // the inactivation_delay will be 3s
            expect(setInactivationDelayResult.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1500));
            // need to first inavtive the locker
            const inactivationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(inactivationResult.effects?.status?.status).toBe('success');

            // Wait for inactivation delay
            await new Promise(resolve => setTimeout(resolve, 3000));

            // set net minted to 1 for testing
            const setmintResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_net_minted_admin",
                arguments: [
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    pure(1),
                    pure(signer1.toSuiAddress())
                ],
                signer: deployer
            });
            expect(setmintResult.effects?.status?.status).toBe('success');
    
            await new Promise(resolve => setTimeout(resolve, 1500));
    
            // Try to remove locker - should fail because netMinted > 0 
            const tx = new TransactionBlock();
            tx.setGasBudget(500000000);
            
            // Create a zero coin for the telebtc_coins parameter
            const zeroCoin = tx.moveCall({
                target: `${lockerPackageId}::telebtc::zero_coin`,
                arguments: []
            });
            
            tx.moveCall({
                target: `${lockerPackageId}::lockermanager::self_remove_locker`,
                arguments: [
                    tx.object(lockerCapId),
                    tx.object(telebtcCapId),
                    tx.object(telebtcTreasuryCapId),
                    tx.object(zeroCoin),
                    tx.object('0x6')
                ]
            });
           
            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer1,
                options: { showEffects: true, showEvents: true }
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*517/); // ERROR_INSUFFICIENT_FUNDS
            const setmintResult2 = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "set_net_minted_admin",
                arguments: [
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    pure(0), // reset to zero
                    pure(signer1.toSuiAddress())
                ],
                signer: deployer
            });
            expect(setmintResult2.effects?.status?.status).toBe('success');
        
        },60000);
    
        // need to set slashing telebtc to 0 before removing the locker
        // leave it here for now
        // it("the locker is removed successfully", async function () {
        //     await new Promise(resolve => setTimeout(resolve, 1500));
    
        //     // Now remove the locker successfully
        //     const tx = new TransactionBlock();
        //     tx.setGasBudget(500000000);
            
        //     // Create a zero coin for the telebtc_coins parameter
        //     const zeroCoin = tx.moveCall({
        //         target: `${lockerPackageId}::telebtc::zero_coin`,
        //         arguments: []
        //     });
            
        //     tx.moveCall({
        //         target: `${lockerPackageId}::lockermanager::self_remove_locker`,
        //         arguments: [
        //             tx.object(lockerCapId),
        //             tx.object(telebtcCapId),
        //             tx.object(telebtcTreasuryCapId),
        //             tx.object(zeroCoin),
        //             tx.object('0x6')
        //         ]
        //     });
           
        //     const removeResult = await client.signAndExecuteTransactionBlock({
        //         transactionBlock: tx,
        //         signer: signer1,
        //         options: { showEffects: true, showEvents: true }
        //     });
        //     console.log("removeResult",removeResult);
        //     expect(removeResult.effects?.status?.status).toBe('success');
    
        //     // Verify total number of lockers decreased
        //     await new Promise(resolve => setTimeout(resolve, 1500));
        //     const lockerResult = await callMoveFunction({
        //         packageId: lockerPackageId,
        //         moduleName: "lockerstorage",
        //         functionName: "total_number_of_lockers",
        //         arguments: [object(lockerCapId)],
        //         signer: deployer,
        //         returnValue: true
        //     });
    
        //     expect(lockerResult.effects?.status?.status).toBe('success');
        //     expect(convertReturnValueToNumber(lockerResult)).toBe(0);
        // });
    
    },60000);
    
    describe("#emergencyWithdraw", () => {
        
        it("non-admin can't call emergency_withdraw", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            try {
                let result = await callMoveFunction({
                    packageId: lockerPackageId,
                    moduleName: "lockercore",
                    functionName: "emergency_withdraw",
                    arguments: [
                        pure(10000), // amount to withdraw
                        object(lockerAdminCapId), // admin cap
                        object(lockerCapId), // locker cap
                    ],
                    signer: signer2 // signer1 is not admin
                });
                expect(true).toBe(false); // Force test failure
            } catch (error) {
                // Function threw an error as expected
                expect(error).toBeDefined();
            }
        });

        it("can't withdraw zero amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "emergency_withdraw",
                arguments: [
                    pure(0), // zero amount
                    object(lockerAdminCapId), // admin cap
                    object(lockerCapId), // locker cap
                ],
                signer: deployer // deployer is admin
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*530/); // ERROR_ZERO_VALUE
        });

        it("can't withdraw more than available balance", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Try to withdraw more than the contract has
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "emergency_withdraw",
                arguments: [
                    pure(1000000000), // 10 BTC (more than available)
                    object(lockerAdminCapId), // admin cap
                    object(lockerCapId), // locker cap
                ],
                signer: deployer // deployer is admin
            });
            expect(result.effects?.status?.status).toBe('failure');
            expect(result.effects?.status?.error).toMatch(/MoveAbort.*533/); // ERROR_INSUFFICIENT_FUNDS
        });

        it("admin can successfully withdraw emergency funds", async function () {
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Get deployer's WBTC balance before withdrawal
            const deployerWbtcBalanceBefore = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });

            // Get contract's WBTC balance before withdrawal
            const contractBalanceBefore = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_wbtc_collateral_balance",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            expect(contractBalanceBefore.effects?.status?.status).toBe('success');
            const contractBalance = convertReturnValueToNumber(contractBalanceBefore);
            
            // Withdraw a small amount (10000 satoshis)
            const withdrawAmount = contractBalance;
            let result = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockercore",
                functionName: "emergency_withdraw",
                arguments: [
                    pure(withdrawAmount), // amount to withdraw
                    object(lockerAdminCapId), // admin cap
                    object(lockerCapId), // locker cap
                ],
                signer: deployer // deployer is admin
            });
            expect(result.effects?.status?.status).toBe('success');

            // Verify deployer received the WBTC
            await new Promise(resolve => setTimeout(resolve, 1500));
            const deployerWbtcBalanceAfter = await client.getBalance({
                owner: deployer.toSuiAddress(),
                coinType: `${lockerPackageId}::wbtc::WBTC`
            });
            
            const receivedAmount = Number(deployerWbtcBalanceAfter.totalBalance) - Number(deployerWbtcBalanceBefore.totalBalance);
            expect(receivedAmount).toBe(withdrawAmount);

            // Verify contract balance decreased
            await new Promise(resolve => setTimeout(resolve, 1500));
            const contractBalanceAfter = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockerstorage",
                functionName: "get_wbtc_collateral_balance",
                arguments: [object(lockerCapId)],
                signer: deployer,
                returnValue: true
            });
            expect(contractBalanceAfter.effects?.status?.status).toBe('success');
            const newContractBalance = convertReturnValueToNumber(contractBalanceAfter);
            expect(contractBalance - newContractBalance).toBe(withdrawAmount);
        });

    }, 60000);
    

}); 



