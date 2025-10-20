import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../../scripts/helper/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import { verifyUpgradeCap } from '../utils/utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { BtcRelayFactory } from './btcrelay_factory';
import { TeleBTCFactory } from './telebtc_factory';
import { callMoveFunction, object, pure } from '../utils/move-helper';

// Function to update Move.toml with actual package IDs
function updateMoveToml(btcrelayPackageId: string) {
    // Update teleswap-main-package/Move.toml
    const TeleswapMainPackageMoveTomlPath = path.join(__dirname, '../../teleswap-main-package/Move.toml');
    let moveTomlContent = fs.readFileSync(TeleswapMainPackageMoveTomlPath, 'utf8');
    
    // Update addresses section - replace entire package ID values
    moveTomlContent = moveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "${btcrelayPackageId}"`
    );
    
    fs.writeFileSync(TeleswapMainPackageMoveTomlPath, moveTomlContent);
    console.log('Updated teleswap-main-package/Move.toml with actual package IDs');

    // Update btcrelay-package/Move.toml
    const btcrelayMoveTomlPath = path.join(__dirname, '../../btcrelay-package/Move.toml');
    let btcrelayMoveTomlContent = fs.readFileSync(btcrelayMoveTomlPath, 'utf8');
    
    // Update the btcrelay address from 0x0 to the deployed package ID
    btcrelayMoveTomlContent = btcrelayMoveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "${btcrelayPackageId}"`
    );
    
    fs.writeFileSync(btcrelayMoveTomlPath, btcrelayMoveTomlContent);
    console.log('Updated btcrelay-package/Move.toml with actual package ID');
}

// Function to update Move.toml with actual package IDs
async function initializeLocker(PackageId: string,adminId: string) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await callMoveFunction({
        packageId: PackageId,
        moduleName: "lockerstorage",
        functionName: "initialize",
        arguments: [
            object(adminId), 
            pure(20), 
            pure(20000), 
            pure(15000), 
            pure(9500), 
        ],
        typeArguments: []
    });
    //console.log(result);
    console.log('Locker system initialized successfully!');
    return result;
}

export async function CCBurnFactory() {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();

    const genesisHeader = "00e05b2315d5244defc05310f45733be5d52dee66f0c0bb19f4802000000000000000000727e95f88f38dc43a55a2a24fa8697c6e682fcd22149b61ff3e958d0d22e90c3568c2868ed5c02179dcd6b73";
    const height = 897110;
    const periodStart = "5559430ef0abdfd1a35fc800b39ea8de6aba033246ef10000000000000000000";
    const finalizationParameter = 3

    // 1. Rebuild the package with updated dependencies
    console.log('Rebuilding package with updated dependencies...');
    const { execSync } = require('child_process');
    try {
        const teleswapMainPackagePath = path.join(__dirname, '../../mock');
        execSync('sui move build --skip-fetch-latest-git-deps', { 
            stdio: 'inherit',
            cwd: teleswapMainPackagePath
        });
        console.log('Package rebuilt successfully');
    } catch (error) {
        console.error('Failed to rebuild package:', error);
        throw error;
    }

    // 2. Deploy Burn Router
    console.log('Deploying Burn Router...');
    let telebtcCapId = "";
    let telebtcTreasuryCapId = "";
    let telebtcAdminId = "";

    let burnRouterPackageId = "";
    let burnRouterAdminId = "";
    
    let btcrelayCapId = "";
    let btcrelayAdminId = "";

    let LockerCapId = "";
    let lockerAdminCapabilityId = "";
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

    // Identify created objects
    for (const obj of result.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';

        if(type === "package") {
            burnRouterPackageId = objectId;
        }
        else if (type.includes('BURN_ROUTER_ADMIN')) {
            burnRouterAdminId = objectId;
        }
        else if (type.includes('LockerAdminCap')) {
            lockerAdminCapabilityId = objectId;
        }
        else if (type.includes('TreasuryCap')&&type.includes('TELEBTC')) {
            telebtcTreasuryCapId = objectId;
        } 
        else if (type.includes('TeleBTCCap')) {
            telebtcCapId = objectId;
        }
        else if (type.includes('TELEBTC_ADMIN')) {
            telebtcAdminId = objectId;
        }
        else if (type.includes('RELAY_ADMIN')) {
            btcrelayAdminId = objectId;
        }
    }

    // 3. Initialize BTC Relay
    console.log('Initializing BTC Relay...');
    tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
        target: `${burnRouterPackageId}::btcrelay::initialize`,
        arguments: [
            tx.pure(genesisHeader),
            tx.pure(height),
            tx.pure(periodStart),
            tx.pure(finalizationParameter),
            tx.object(btcrelayAdminId),
        ]
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    let initResult = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    if(initResult.effects?.status?.status !== 'success') {
        console.log(initResult.effects);
        throw new Error('Transaction failed');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Identify created objects
    for (const obj of initResult.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';

        if(type.includes('BTCRelay')) {
            btcrelayCapId = objectId;
        }
    }

    // 4. Initialize Locker
    let lockerResult = await initializeLocker(burnRouterPackageId,lockerAdminCapabilityId);
    if(lockerResult.effects?.status?.status !== 'success') {
        console.log(lockerResult.effects);
        throw new Error('Transaction failed');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Identify created objects
    for (const obj of lockerResult.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';

        if(type.includes('LockerCap')) {
            LockerCapId = objectId;
        }
    }

    console.log('\nSelected objects:');
    console.log('Burn Router Package ID:', burnRouterPackageId);
    console.log('Burn Router Admin ID:', burnRouterAdminId);
    console.log('TeleBTC Cap ID:', telebtcCapId);
    console.log('TeleBTC Treasury Cap ID:', telebtcTreasuryCapId);
    console.log('TeleBTC Admin ID:', telebtcAdminId);
    console.log('BTC Relay Cap ID:', btcrelayCapId);
    console.log('BTC Relay Admin ID:', btcrelayAdminId);
    console.log('Locker Capability ID:', LockerCapId);

    // Return all the important variables
    return {
        // Burn Router
        burnRouterPackageId,
        burnRouterAdminId,
        
        // TeleBTC
        telebtcCapId,
        telebtcTreasuryCapId,
        telebtcAdminId,
        
        // BTC Relay
        btcrelayCapId,
        btcrelayAdminId,

        // Locker Capability
        LockerCapId,
    };
}
