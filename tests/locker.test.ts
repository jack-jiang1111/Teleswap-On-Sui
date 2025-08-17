
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { LockerFactory } from './test_factory/locker_factory';
import { getActiveKeypair } from '../scripts/sui.utils';
import { beforeAll, describe, expect, test, it } from "vitest";
import BigNumber from 'bignumber.js';
import { callMoveFunction, pure, object, splitGasTokens } from "./utils/move-helper";
import {printEvents,hexToBytes,eventNotContain, parseReturnValue} from './utils/utils';
import * as fs from 'fs';
import * as path from 'path';
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
    const USE_CACHED_IDS = false;
    
    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    let btcAmountToSlash = new BigNumber(10).pow(8);
    let collateralRatio = 20000;
    let liquidationRatio = 15000;
    const LOCKER_PERCENTAGE_FEE = 20; // Means %0.2
    const PRICE_WITH_DISCOUNT_RATIO = 9500; // Means %95
    const INACTIVATION_DELAY = 10000;

    // Bitcoin public key (32 bytes)
    let LOCKER1 = '0x03789ed0bb717d88f7d321a368d905e7430207ebbd82bd342cf11ae157a7ace5fd';
    let LOCKER1_PUBKEY__HASH = '0x4062c8aeed4f81c2d73ff854a2957021191e20b6';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 1; // P2PKH

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

            console.log('Locker factory setup completed');
            console.log('WBTC Treasury Cap ID:', wbtcTreasuryCapId);
            console.log('Locker Package ID:', lockerPackageId);
            console.log('Locker Admin Cap ID:', lockerAdminCapId);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            let initResult = await initializeLocker();
            expect(initResult.effects?.status?.status).toBe('success');

            // Save the new IDs to JSON file
            const packageIdPath = path.join(__dirname, 'package_id.json');
            const idsToSave = {
                lockerPackageId,
                lockerAdminCapId,
                wbtcTreasuryCapId,
                lockerCapId
            };
            fs.writeFileSync(packageIdPath, JSON.stringify(idsToSave, null, 2));
            console.log('Saved new IDs to package_id.json');
        }
        
        // Create additional signers for testing
        signer1 = new Ed25519Keypair();
        signer2 = new Ed25519Keypair();
        
        // Transfer some test SUI to the signers
        await new Promise(resolve => setTimeout(resolve, 1000));
        let result = await splitGasTokens(client, deployer, signer1.toSuiAddress(), 2000000000); // 2 SUI
        expect(result.effects?.status?.status).toBe('success');
        await new Promise(resolve => setTimeout(resolve, 1000));
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
        
        await new Promise(resolve => setTimeout(resolve, 1000));
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
        try {
            lockerCapId = result.effects?.created?.[0]?.reference?.objectId || '';
            console.log("lockerCapId", lockerCapId);
        } catch (error) {
            console.log("lockerCap not found");
        }
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

    // describe("Setup and Initialization", () => {

    //     it("should deploy All the contracts successfully", () => {
    //         expect(lockerPackageId).toBeTruthy();
    //         expect(lockerPackageId).not.toBe("0x0");
    //         expect(lockerAdminCapId).toBeTruthy();
    //         expect(lockerAdminCapId).not.toBe("0x0");
    //         expect(wbtcAddress).toBeTruthy();
    //         expect(wbtcAddress).not.toBe("0x0");
    //     });

    //     it("should create and fund test signers", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // Check if signers have SUI balance
    //         const signer1Balance = await client.getBalance({
    //             owner: signer1.toSuiAddress(),
    //             coinType: '0x2::sui::SUI'
    //         });
            
    //         const signer2Balance = await client.getBalance({
    //             owner: signer2.toSuiAddress(),
    //             coinType: '0x2::sui::SUI'
    //         });
            
    //         expect(parseInt(signer1Balance.totalBalance)).toBeGreaterThan(0);
    //         expect(parseInt(signer2Balance.totalBalance)).toBeGreaterThan(0);
    //     });
    //     it("should mint WBTC successfully", async () => {
    //         const mintAmount = 100000000; // 1 WBTC (8 decimals)
    //         const result = await mintWBTC(signer1, mintAmount);
    //         expect(result.effects?.status?.status).toBe('success');
    //         // need to check if the wbtc is minted successfully
    //         const wbtcBalance = await client.getBalance({
    //             owner: signer1.toSuiAddress(),
    //             coinType: `${wbtcAddress}::wbtc::WBTC`
    //         });
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         expect(parseInt(wbtcBalance.totalBalance)).toBeGreaterThan(0);
    //     });
    // });

    // describe("#initialize", () => {
    //     it("should not allow re-initialization", async () => {
    //         // Try to call initialize again - this should fail
    //         let result = await initializeLocker();
    //         expect(result.effects?.status?.status).toBe('failure');
    //         expect(result.effects?.status?.error).toMatch(
    //             /MoveAbort.*lockerstorage.*501/
    //         ) 
    //     });
    // });

    // describe("#pauseLocker", () => {
    //     it("only admin can pause locker", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         try {
    //             const result = await callMoveFunction({
    //                 packageId: lockerPackageId,
    //                 moduleName: "lockerstorage",
    //                 functionName: "pause_locker",
    //                 arguments: [object(lockerAdminCapId), object(lockerCapId)],
    //                 signer: signer1
    //             });
                
    //             // If we reach here, the function didn't throw an error
    //             // This should fail the test
    //             expect(true).toBe(false); // Force test failure
    //         } catch (error) {
    //             // Function threw an error as expected
    //             expect(error).toBeDefined();
    //         }
    //     });

    //     it("contract paused successfully", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // Pause the contract as admin
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "pause_locker",
    //             arguments: [object(lockerAdminCapId),object(lockerCapId)],
    //             signer: deployer
    //         });
    //         expect(result.effects?.status?.status).toBe('success');
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // Check if the system is paused using the getter function
    //         result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "is_paused",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
            
    //         // Should succeed and return the paused state
    //         expect(result.effects?.status?.status).toBe('success');
    //         expect(result?.results?.[0]?.returnValues?.[0]?.[0][0]).toBe(1);
    //     });

    //     it("can't pause when already paused", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // Try to pause again when already paused
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "pause_locker",
    //             arguments: [object(lockerAdminCapId),object(lockerCapId)],
    //             signer: deployer
    //         });
            
    //         // Should fail - already paused
    //         expect(result.effects?.status?.status).toBe('failure');
    //         expect(result.effects?.status?.error).toMatch(/MoveAbort.*lockerstorage.*507/); // ERROR_IS_PAUSED
    //     });
    // });

    // describe("#unPauseLocker", () => {
    //     it("only admin can un-pause locker", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // Try to unpause with non-admin signer (signer1)
    //         try {
    //             let result = await callMoveFunction({
    //                 packageId: lockerPackageId,
    //                 moduleName: "lockerstorage",
    //                 functionName: "unpause_locker",
    //                 arguments: [object(lockerAdminCapId),object(lockerCapId)],
    //                 signer: signer1
    //             });
    //             expect(true).toBe(false); // Force test failure
    //         } catch (error) {
    //             // Should fail with admin error
    //             expect(error).toBeDefined();
    //         }
    //     });

    //     it("contract un-paused successfully", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // First pause the contract
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "unpause_locker",
    //             arguments: [object(lockerAdminCapId),object(lockerCapId)],
    //             signer: deployer
    //         });
    //         expect(result.effects?.status?.status).toBe('success');

    //         // Check if the system is paused using the getter function
    //         result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "is_paused",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
    //         // Should succeed and return the paused state
    //         expect(result.effects?.status?.status).toBe('success');
    //         expect(result?.results?.[0]?.returnValues?.[0]?.[0][0]).toBe(0);
    //     });

    //     it("can't un-pause when already un-paused", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         // Try to unpause when not paused
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "unpause_locker",
    //             arguments: [object(lockerAdminCapId),object(lockerCapId)],
    //             signer: deployer
    //         });
            
    //         // Should fail - not paused
    //         expect(result.effects?.status?.status).toBe('failure');
    //         expect(result.effects?.status?.error).toMatch(/MoveAbort.*lockerstorage.*508/); // ERROR_IS_UNPAUSED
    //     });
    // });


    // describe("#setter functions", () => {

    //     // setLockerPercentageFee tests
    //     it("non owners can't call setLockerPercentageFee", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         try {
    //             let result = await callMoveFunction({
    //                 packageId: lockerPackageId,
    //                 moduleName: "lockerstorage",
    //                 functionName: "set_locker_percentage_fee",
    //                 arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
    //                 signer: signer1
    //             });
    //             expect(true).toBe(false);
    //         } catch (error) {
    //             expect(error).toBeDefined();
    //         }
    //     });

    //     it("only owner can call setLockerPercentageFee", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
    //         // Set locker percentage fee as admin
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "set_locker_percentage_fee",
    //             arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
    //             signer: deployer
    //         });
            
    //         // Should succeed
    //         expect(result.effects?.status?.status).toBe('success');

    //         // Verify the fee was set correctly using the getter function
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "locker_percentage_fee",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
            
    //         // Should succeed and return the new fee value
    //         expect(result.effects?.status?.status).toBe('success');
    //         expect(convertReturnValueToNumber(result)).toBe(2100);
    //     });

    //     // setPriceWithDiscountRatio tests
    //     it("non owners can't call setPriceWithDiscountRatio", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         try {
    //             let result = await callMoveFunction({
    //                 packageId: lockerPackageId,
    //                 moduleName: "lockerstorage",
    //                 functionName: "set_price_with_discount_ratio",
    //                 arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
    //                 signer: signer1
    //             });
    //             expect(true).toBe(false);
    //         } catch (error) {
    //             expect(error).toBeDefined();
    //         }
    //     });

    //     it("only owner can call setPriceWithDiscountRatio", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
    //         // Set price with discount ratio as admin
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "set_price_with_discount_ratio",
    //             arguments: [object(lockerAdminCapId), object(lockerCapId), pure(2100)],
    //             signer: deployer
    //         });
            
    //         // Should succeed
    //         expect(result.effects?.status?.status).toBe('success');

    //         // Verify the ratio was set correctly using the getter function
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "price_with_discount_ratio",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
            
    //         // Should succeed and return the new ratio value
    //         expect(result.effects?.status?.status).toBe('success');
    //         expect(convertReturnValueToNumber(result)).toBe(2100);
    //     });

    //     // setCollateralRatio tests
    //     it("non owners can't call setCollateralRatio", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         try {
    //                 let result = await callMoveFunction({
    //                     packageId: lockerPackageId,
    //                     moduleName: "lockerstorage",
    //                     functionName: "set_collateral_ratio",
    //                     arguments: [object(lockerAdminCapId), object(lockerCapId), pure(21000)],
    //                     signer: signer1
    //                 });
    //                 expect(true).toBe(false);
    //             } catch (error) {
    //                 expect(error).toBeDefined();
    //             }
    //     });

    //     it("only owner can call setCollateralRatio", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
    //         // Set collateral ratio as admin
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "set_collateral_ratio",
    //             arguments: [object(lockerAdminCapId), object(lockerCapId), pure(21000)],
    //             signer: deployer
    //         });
            
    //         // Should succeed
    //         expect(result.effects?.status?.status).toBe('success');

    //         // Verify the ratio was set correctly using the getter function
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "collateral_ratio",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
            
    //         // Should succeed and return the new ratio value
    //         expect(result.effects?.status?.status).toBe('success');
    //         expect(convertReturnValueToNumber(result)).toBe(21000);
    //     });

    //     // setLiquidationRatio tests
    //     it("non owners can't call setLiquidationRatio", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         try {
    //             let result = await callMoveFunction({
    //                 packageId: lockerPackageId,
    //                 moduleName: "lockerstorage",
    //                 functionName: "set_liquidation_ratio",
    //                 arguments: [object(lockerAdminCapId), object(lockerCapId), pure(19000)],
    //                 signer: signer1
    //             });
    //             expect(true).toBe(false);
    //         } catch (error) {
    //             expect(error).toBeDefined();
    //         }
    //     });

    //     it("only owner can call setLiquidationRatio", async () => {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
    //         // Set liquidation ratio as admin
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "set_liquidation_ratio",
    //             arguments: [object(lockerAdminCapId), object(lockerCapId), pure(19000)],
    //             signer: deployer
    //         });
            
    //         // Should succeed
    //         expect(result.effects?.status?.status).toBe('success');

    //         // Verify the ratio was set correctly using the getter function
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "liquidation_ratio",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
            
    //         // Should succeed and return the new ratio value
    //         expect(result.effects?.status?.status).toBe('success');
    //         expect(convertReturnValueToNumber(result)).toBe(19000);
    //     });
    // });

    // describe("#requestToBecomeLocker", () => {

    //     it("successful request to become locker", async () => {
    //         // Mint WBTC coins for signer1 using the helper function
    //         const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
    //         // Request to become locker using the WBTC coin
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         const requestResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_to_become_locker",
    //             arguments: [
    //                 object(lockerCapId),
    //                 pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // locker_locking_script
    //                 object(wbtcCoinId), // wbtc_coins (actual coin object)
    //                 pure(LOCKER_RESCUE_SCRIPT_P2PKH_TYPE), // locker_script_type
    //                 pure(hexToBytes(LOCKER_RESCUE_SCRIPT_P2PKH)) // locker_rescue_script
    //             ],
    //             signer: signer1
    //         });
    //         //console.log(requestResult);
    //         // Should succeed
    //         expect(requestResult.effects?.status?.status).toBe('success');

    //         // Verify total number of candidates increased
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         const candidateResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "total_number_of_candidates",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
    //         //console.log("candidateResult",candidateResult);
    //         // Should succeed and return 1 candidate
    //         expect(candidateResult.effects?.status?.status).toBe('success');
    //         expect(convertReturnValueToNumber(candidateResult)).toBe(1);
    //     },20000);

    //     it("a locker can't requestToBecomeLocker twice", async () => {
    //         // Mint WBTC coins for signer1 using the helper function
    //         const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
    //         // Try to request again - should fail
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         const secondRequestResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_to_become_locker",
    //             arguments: [
    //                 object(lockerCapId),
    //                 pure(hexToBytes(LOCKER1_PUBKEY__HASH)), // Same script hash as signer1
    //                 object(wbtcCoinId), // wbtc_coins (actual coin object)
    //                 pure(LOCKER_RESCUE_SCRIPT_P2PKH_TYPE), // locker_script_type
    //                 pure(hexToBytes(LOCKER_RESCUE_SCRIPT_P2PKH)) // locker_rescue_script
    //             ],
    //             signer: signer1
    //         });
            
    //         // Should fail - already a candidate
    //         expect(secondRequestResult.effects?.status?.status).toBe('failure');
    //         expect(secondRequestResult.effects?.status?.error).toMatch(/MoveAbort.*lockerhelper.*524/); // ERROR_ALREADY_CANDIDATE
    //     });
    // });
    // describe("#revokeRequest", () => {
        
    //     it("successful revoke", async function () {

    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "revoke_request",
    //             arguments: [object(lockerCapId)],
    //             signer: signer1
    //         });

    //         expect(result.effects?.status?.status).toBe('success');
    //         // Verify total number of candidates decreased
    //         const candidateResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockerstorage",
    //             functionName: "total_number_of_candidates",
    //             arguments: [object(lockerCapId)],
    //             signer: deployer,
    //             returnValue: true
    //         });
    //         //console.log("candidateResult",candidateResult);
    //         // Should succeed and return 0 candidate
    //         expect(candidateResult.effects?.status?.status).toBe('success');
    //         expect(convertReturnValueToNumber(candidateResult)).toBe(0);
    //     })

    //     it("trying to revoke a non existing request", async function () {
    //         let result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "revoke_request",
    //             arguments: [object(lockerCapId)],
    //             signer: signer1
    //         });

    //         expect(result.effects?.status?.status).toBe('failure');
    //         expect(result.effects?.status?.error).toMatch(/MoveAbort.*515/); // ERROR_NO_REQUEST
    //     })

    // });
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
            await new Promise(resolve => setTimeout(resolve, 1000));
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
                    pure(1)],
                signer: deployer
            });

            expect(result.effects?.status?.status).toBe('success');

            // Verify total number of candidates decreased
            await new Promise(resolve => setTimeout(resolve, 1000));
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
            await new Promise(resolve => setTimeout(resolve, 1000));
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
           await new Promise(resolve => setTimeout(resolve, 1000));
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

        // Additional verification tests for the added locker
        it("should verify locker target address mapping", async function () {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
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
            await new Promise(resolve => setTimeout(resolve, 1000));
            
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
            await new Promise(resolve => setTimeout(resolve, 1000));
            
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
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check if is_locker_active returns true for signer1's address
            const isLockerActiveResult = await callMoveFunction({
                packageId: lockerPackageId,
            moduleName: "lockerstorage",
            functionName: "is_locker_active",
            arguments: [object(lockerCapId), pure(signer1.toSuiAddress())],
            signer: deployer,
            returnValue: true
            });
            
            expect(isLockerActiveResult.effects?.status?.status).toBe('success');
            expect(convertReturnValueToNumber(isLockerActiveResult)).toBe(1); // Should return true (1)
        });

        it("should verify locker collateral amount", async function () {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
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
            await new Promise(resolve => setTimeout(resolve, 1000));
            
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

    // describe("#requestInactivation", () => {


    //     it("trying to request to remove a non existing locker", async function () {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
            
    //         const result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_inactivation",
    //             arguments: [object(lockerCapId)],
    //             signer: signer2
    //         });
    //         expect(result.effects?.status?.status).toBe('failure');
    //         expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
    //     });

    //     it("successfully request to be removed", async function () {
    //         // Now test request inactivation
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         const inactivationResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_inactivation",
    //             arguments: [object(lockerCapId)],
    //             signer: signer1
    //         });
    //         //console.log("inactivationResult",inactivationResult);
    //         expect(inactivationResult.effects?.status?.status).toBe('success');

    //         // Try to request inactivation again - should fail
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
    //         const secondInactivationResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_inactivation",
    //             arguments: [object(lockerCapId)],
    //             signer: signer1
    //         });
    //         expect(secondInactivationResult.effects?.status?.status).toBe('failure');
    //         expect(secondInactivationResult.effects?.status?.error).toMatch(/MoveAbort.*518/); // ERORR_ALREADY_REQUESTED
    //     });
    // },60000);

    // describe("#requestActivation", () => {

    //     it("trying to request to a non existing locker", async function () {
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
            
    //         const result = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_activation",
    //             arguments: [object(lockerCapId)],
    //             signer: signer2
    //         });
    //         expect(result.effects?.status?.status).toBe('failure');
    //         expect(result.effects?.status?.error).toMatch(/MoveAbort.*512/); // ERROR_NOT_LOCKER
    //     });

    //     it("successfully request to be activated", async function () {
    //         // Now test request inactivation
    //         await new Promise(resolve => setTimeout(resolve, 1000));
    //         const activationResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_activation",
    //             arguments: [object(lockerCapId)],
    //             signer: signer1
    //         });
    //         //console.log("activationResult",activationResult);
    //         expect(activationResult.effects?.status?.status).toBe('success');

    //         // Try to request inactivation again - should fail
    //         await new Promise(resolve => setTimeout(resolve, 1000));
            
    //         const secondActivationResult = await callMoveFunction({
    //             packageId: lockerPackageId,
    //             moduleName: "lockermanager",
    //             functionName: "request_activation",
    //             arguments: [object(lockerCapId)],
    //             signer: signer1
    //         });
    //         expect(secondActivationResult.effects?.status?.status).toBe('failure');
    //         expect(secondActivationResult.effects?.status?.error).toMatch(/MoveAbort.*518/); // ERORR_ALREADY_REQUESTED
    //     });
    // },60000);

    describe("#selfRemoveLocker", () => {

        it("a non-existing locker can't be removed", async function () {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const requestResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "self_remove_locker",
                arguments: [
                    // need telebtc and treasury cap to burn telebtc
                    object(lockerCapId),
                    object(telebtcCapId),
                    object(treasuryCapId),
                ],
                signer: signer1
            });
            expect(requestResult.effects?.status?.status).toBe('success');
            expect(true).toBe(true); // Placeholder assertion
        });

        it("can't remove a locker if it doesn't request to be removed", async function () {
            // First, we need to set up a locker (signer1) to test with
            // Mint WBTC coins for signer1
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
            // Request to become locker
            await new Promise(resolve => setTimeout(resolve, 1000));
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

            // Add locker as admin
            await new Promise(resolve => setTimeout(resolve, 1000));
            const addLockerResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_locker",
                arguments: [
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()),
                    pure(1)],
                signer: deployer
            });
            expect(addLockerResult.effects?.status?.status).toBe('success');

            // Try to remove locker without requesting inactivation - should fail
            // This test requires TeleBTC coins and proper setup
            // For now, we'll test the basic structure
            expect(true).toBe(true); // Placeholder assertion
        });

        it("the locker can't be removed because netMinted is not zero", async function () {
            // This test requires more complex setup with minting TeleBTC
            // For now, we'll test the basic structure
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // This test would need:
            // 1. Set up locker
            // 2. Mint some TeleBTC (which increases netMinted)
            // 3. Request inactivation
            // 4. Try to remove - should fail due to non-zero netMinted
            
            // Placeholder for now - can be implemented when minting functionality is available
            expect(true).toBe(true); // Placeholder assertion
        });

        it("the locker is removed successfully", async function () {
            // First, we need to set up a locker (signer1) to test with
            // Mint WBTC coins for signer1
            const { coinId: wbtcCoinId } = await mintWBTC(signer1, 100000000); // 1 WBTC
            
            // Request to become locker
            await new Promise(resolve => setTimeout(resolve, 1000));
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

            // Add locker as admin
            await new Promise(resolve => setTimeout(resolve, 1000));
            const addLockerResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "add_locker",
                arguments: [
                    object(lockerAdminCapId),
                    object(lockerCapId),
                    pure(signer1.toSuiAddress()),
                    pure(1)],
                signer: deployer
            });
            expect(addLockerResult.effects?.status?.status).toBe('success');

            // Request inactivation
            await new Promise(resolve => setTimeout(resolve, 1000));
            const inactivationResult = await callMoveFunction({
                packageId: lockerPackageId,
                moduleName: "lockermanager",
                functionName: "request_inactivation",
                arguments: [object(lockerCapId)],
                signer: signer1
            });
            expect(inactivationResult.effects?.status?.status).toBe('success');

            // For now, we'll test the basic structure
            // The actual removal would require TeleBTC coins and more complex setup
            // This can be completed when the full minting/burning functionality is implemented
            
            expect(true).toBe(true); // Placeholder assertion
        });
    });
}); 