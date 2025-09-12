import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../../scripts/helper/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import { printEvents, verifyUpgradeCap } from '../utils/utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { BtcRelayFactory } from './btcrelay_factory';
import { callMoveFunction, object, pure } from '../utils/move-helper';
const { execSync } = require('child_process');

// Function to reset Move.toml addresses
function resetLockerMoveToml() {
    // Update teleswap-main-package/Move.toml
    const teleswapMainPackageMoveTomlPath = path.join(__dirname, '../../teleswap-main-package/Move.toml');
    let teleswapMainPackageMoveTomlContent = fs.readFileSync(teleswapMainPackageMoveTomlPath, 'utf8');
    
    // Reset the btcrelay address to 0x0
    teleswapMainPackageMoveTomlContent = teleswapMainPackageMoveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "0x0"`
    );
    
    // Reset the wbtc address to 0x0
    teleswapMainPackageMoveTomlContent = teleswapMainPackageMoveTomlContent.replace(
        /wbtc = "[^"]*"/,
        `wbtc = "0x0"`
    );
    
    fs.writeFileSync(teleswapMainPackageMoveTomlPath, teleswapMainPackageMoveTomlContent);
    console.log('Reset teleswap-main-package/Move.toml addresses to 0x0');
}

// Function to update Move.toml with actual package IDs
function updateLockerMoveToml(btcrelayPackageId: string) {
    // Update teleswap-main-package/Move.toml
    const teleswapMainPackageMoveTomlPath = path.join(__dirname, '../../teleswap-main-package/Move.toml');
    let teleswapMainPackageMoveTomlContent = fs.readFileSync(teleswapMainPackageMoveTomlPath, 'utf8');
    
    // Update the btcrelay address
    teleswapMainPackageMoveTomlContent = teleswapMainPackageMoveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "${btcrelayPackageId}"`
    );
    
    
    fs.writeFileSync(teleswapMainPackageMoveTomlPath, teleswapMainPackageMoveTomlContent);
    console.log('Updated teleswap-main-package/Move.toml with btcrelay addresses');

    // Update btcrelay-package/Move.toml
    const btcrelayPackageMoveTomlPath = path.join(__dirname, '../../btcrelay-package/Move.toml');
    let btcrelayPackageMoveTomlContent = fs.readFileSync(btcrelayPackageMoveTomlPath, 'utf8');
    
    // Update the btcrelay address in btcrelay-package
    btcrelayPackageMoveTomlContent = btcrelayPackageMoveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "${btcrelayPackageId}"`
    );
    
    fs.writeFileSync(btcrelayPackageMoveTomlPath, btcrelayPackageMoveTomlContent);
    console.log('Updated btcrelay-package/Move.toml with btcrelay address');
}

// Function to compile locker contracts
function compileLockerContracts() {
    console.log('Compiling locker contracts...');
    
    try {
        const teleswapMainPackagePath = path.join(__dirname, '../../mock');
        execSync('sui move build --skip-fetch-latest-git-deps', { 
            stdio: 'inherit',
            cwd: teleswapMainPackagePath
        });
        console.log('Locker contracts compiled successfully');
    } catch (error) {
        console.error('Failed to compile locker contracts:', error);
        throw error;
    }
}

export async function LockerFactory(
): Promise<{
    deployer: Ed25519Keypair, 
    lockerPackageId: string,
    lockerAdminCapId: string,
    wbtcTreasuryCapId: string,
    telebtcCapId: string,
    telebtcTreasuryCapId: string,
    btcrelayCapId: string,
    burnRouterCapId: string
}> {

    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();

    // Step 1: Compile locker contracts
    console.log('--------------------------------');
    console.log('Step 1: Compiling locker contracts...');
    compileLockerContracts();

    // Step 2: Deploy locker contracts
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('--------------------------------');
    console.log('Step 2: Deploying locker contracts...');

    // Get modules bytecode by traversing the build output and collecting all .mv files
    const modulesDir = path.join(__dirname, '../../mock/build/teleswap/bytecode_modules');
    const moduleFiles = fs.readdirSync(modulesDir)
        .filter((f) => f.endsWith('.mv'))
        .sort(); // ensure deterministic order

    // deploy all the modules except the cc_exchange_logic/cc_exchange_storage/dexconnector
    const excluded = new Set(['cc_exchange_logic.mv', 'cc_exchange_storage.mv', 'dexconnector.mv']);
    const filteredFiles = moduleFiles.filter((f) => !excluded.has(f));
    const modules = filteredFiles.map((f) => Array.from(fs.readFileSync(path.join(modulesDir, f))));

    let tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    const [upgradeCap] = tx.publish({
        modules,
        dependencies: [
            '0x1', '0x2', '0x3',
        ]
    });

    // Transfer the UpgradeCap to the deployer
    tx.transferObjects([upgradeCap], tx.pure(deployer.toSuiAddress()));
    let result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    if(result.effects?.status?.status !== 'success') {
        console.log(result.effects);
        throw new Error('Transaction failed');
    }
    await new Promise(resolve => setTimeout(resolve, 3000));

    let lockerPackageId = "";
    let lockerAdminCapId = "";
    let telebtcCapId = "";
    let telebtcTreasuryCapId = "";
    let wbtcTreasuryCapId = "";
    let btcrelayCapId = "";
    let burnRouterCapId = "";
    let relayAdminId = "";
    let burnRouterAdminId = "";
    for (const obj of result.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';
        //console.log(objectId,objInfo,type);
        if (type === "package") {
            lockerPackageId = objectId;
        }
        else if (type.includes('LockerAdminCap')) {
            lockerAdminCapId = objectId;
        }
        else if (type.includes('TreasuryCap') && type.includes('WBTC')) {
            wbtcTreasuryCapId = objectId;
        }
        else if (type.includes('TeleBTCCap')) {
            telebtcCapId = objectId;
        }
        else if(type.includes('TreasuryCap') && type.includes('TELEBTC')){
            telebtcTreasuryCapId = objectId;
        }
        else if(type.includes('BurnRouter')){
            burnRouterCapId = objectId;
        }
        else if(type.includes('RELAY_ADMIN')){
            relayAdminId = objectId;
        }
        else if(type.includes('BURN_ROUTER_ADMIN')){
            burnRouterAdminId = objectId;
        }
    }

    if (!lockerPackageId) {
        throw new Error('Failed to get locker package address');
    }
    if (!lockerAdminCapId) {
        throw new Error('Failed to get LockerAdminCap address');
    }
    if (!telebtcCapId) {
        throw new Error('Failed to get TeleBTCCap address');
    }
    if (!telebtcTreasuryCapId) {
        throw new Error('Failed to get TeleBTCTreasuryCap address');
    }
    if (!wbtcTreasuryCapId) {
        throw new Error('Failed to get WBTC Treasury Cap address');
    }
    if (!relayAdminId) {
        throw new Error('Failed to get RelayAdminCap address');
    }
    if (!burnRouterAdminId) {
        throw new Error('Failed to get BurnRouterAdminCap address');
    }
    // Call initialize function in btcrelay
    console.log('--------------------------------');
    console.log('Step 3: Initializing BTCRelay...');
    tx = new TransactionBlock();
    const genesisHeader = "00e05b2315d5244defc05310f45733be5d52dee66f0c0bb19f4802000000000000000000727e95f88f38dc43a55a2a24fa8697c6e682fcd22149b61ff3e958d0d22e90c3568c2868ed5c02179dcd6b73";
    const height = 897110;
    const periodStart = "5559430ef0abdfd1a35fc800b39ea8de6aba033246ef10000000000000000000";
    const finalizationParameter = 3;
    tx.moveCall({
        target: `${lockerPackageId}::btcrelay::initialize`,
        arguments: [
            tx.pure(genesisHeader),
            tx.pure(height),
            tx.pure(periodStart),
            tx.pure(finalizationParameter),
            tx.object(relayAdminId)
        ]
    });
    
    result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    
    expect(result.effects?.status?.status).toBe('success');
    //printEvents(result);
    // Get the new BTCRelay object ID from the effects
    const createdObjects = result.effects?.created || [];
    const newBtcRelay = createdObjects.find(obj => 
        (obj.owner as any)?.Shared?.initial_shared_version !== undefined
    );

    if (!newBtcRelay) {
        throw new Error('No new BTCRelay object found in transaction effects');
    }

    // Store the BTCRelay object ID for future tests
    btcrelayCapId = newBtcRelay.reference.objectId;
    let TRANSFER_DEADLINE = 20
    let PROTOCOL_PERCENTAGE_FEE = 5 // means 0.05%
    let LOCKER_PERCENTAGE_FEE = 10 // means 0.1%
    let SLASHER_PERCENTAGE_REWARD = 5 // means 0.05%
    let BITCOIN_FEE = 49700 // estimation of Bitcoin transaction fee in Satoshi
    let TREASURY = "0x0000000000000000000000000000000000000000000000000000000000000002";
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('--------------------------------');
    console.log('Step 4: Initializing BurnRouter...');
    // call burn initialize function
    let BurnRouterInitializeResult = await callMoveFunction({
        packageId: lockerPackageId,
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
            pure(deployer.toSuiAddress()),
            pure(btcrelayCapId),
        ],
        signer: deployer
    });
    
    expect(BurnRouterInitializeResult.effects?.status?.status).toBe("success");
    // Extract burnRouterId from the created object
    burnRouterCapId = BurnRouterInitializeResult.effects?.created?.[0]?.reference?.objectId || '';

    console.log('Locker contracts deployed successfully at:', lockerPackageId);
    console.log('LockerAdminCap created at:', lockerAdminCapId);
    console.log('WBTC Treasury Cap ID:', wbtcTreasuryCapId);
    console.log('TeleBTC Cap ID:', telebtcCapId);
    console.log('TeleBTC Treasury Cap ID:', telebtcTreasuryCapId);
    console.log('BTCRelay Cap ID:', btcrelayCapId);
    console.log('BurnRouter Cap ID:', burnRouterCapId);
    console.log('Locker factory setup completed successfully!');
    
    return {
        deployer,
        lockerPackageId,
        lockerAdminCapId,
        wbtcTreasuryCapId,
        telebtcCapId,
        telebtcTreasuryCapId,
        btcrelayCapId,
        burnRouterCapId
    };
} 