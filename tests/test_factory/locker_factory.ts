import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../../scripts/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import { printEvents, verifyUpgradeCap } from '../utils/utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { BtcRelayFactory } from './btcrelay_factory';
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
        const teleswapMainPackagePath = path.join(__dirname, '../../teleswap-main-package');
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
    wbtcTreasuryCapId: string
}> {
    // Reset Move.toml addresses first
    resetLockerMoveToml();
    
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();
    
    // Step 1: Deploy btcrelay package without mock
    console.log('--------------------------------');
    console.log('Step 1: Deploying btcrelay package...');
    
    // 1. Deploy BTC Relay
    console.log('Deploying BTC Relay...');
    const genesisHeader = "00e05b2315d5244defc05310f45733be5d52dee66f0c0bb19f4802000000000000000000727e95f88f38dc43a55a2a24fa8697c6e682fcd22149b61ff3e958d0d22e90c3568c2868ed5c02179dcd6b73";
    const height = 897110;
    const periodStart = "5559430ef0abdfd1a35fc800b39ea8de6aba033246ef10000000000000000000";
    const finalizationParameter = 3;
    
    const btcrelayResult = await BtcRelayFactory(genesisHeader, height, periodStart, finalizationParameter,false);// set mock to false

    console.log('Btcrelay deployed successfully:');
    console.log('Package ID:', btcrelayResult.packageId);
    console.log('Upgrade Cap ID:', btcrelayResult.upgradeCapId);
    console.log('RELAY_ADMIN ID:', btcrelayResult.relayAdminId);
    console.log('BTC Relay ID:', btcrelayResult.btcRelayId);

    

    let wbtcTreasuryCapId = "";

    // Step 3: Update Move.toml files
    console.log('--------------------------------');
    console.log('Step 3: Updating Move.toml files...');
    updateLockerMoveToml(btcrelayResult.packageId);

    // Step 4: Compile locker contracts
    console.log('--------------------------------');
    console.log('Step 4: Compiling locker contracts...');
    compileLockerContracts();

    // Step 5: Deploy locker contracts
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('--------------------------------');
    console.log('Step 5: Deploying locker contracts...');

    // Get all the locker contract modules
    const lockerModules = [
        'lockercore.mv',
        'lockerhelper.mv', 
        'lockerstorage.mv',
        'lockermanager.mv',
        'price_oracle.mv',
        'telebtc.mv',
        'burn_router_helper.mv',
        'burn_router_locker_connector.mv',
        'burn_router_storage.mv',
        'wbtc.mv'
    ];
    
    const lockerModuleBuffers = lockerModules.map(moduleName => 
        fs.readFileSync(
            path.join(__dirname, `../../teleswap-main-package/build/teleswap/bytecode_modules/${moduleName}`)
        )
    );
    
    let tx = new TransactionBlock();
    const [lockerUpgradeCap] = tx.publish({
        modules: lockerModuleBuffers.map(buffer => Array.from(buffer)),
        dependencies: ['0x1', '0x2', '0x3', btcrelayResult.packageId]
    });

    tx.transferObjects([lockerUpgradeCap], tx.pure(deployer.toSuiAddress()));
    
    let result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    let lockerPackageId = "";
    let lockerAdminCapId = "";
    
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
    }

    if (!lockerPackageId) {
        throw new Error('Failed to get locker package address');
    }
    if (!lockerAdminCapId) {
        throw new Error('Failed to get LockerAdminCap address');
    }

    console.log('Locker contracts deployed successfully at:', lockerPackageId);
    console.log('LockerAdminCap created at:', lockerAdminCapId);
    console.log('WBTC Treasury Cap ID:', wbtcTreasuryCapId);
    console.log('Locker factory setup completed successfully!');
    
    return {
        deployer,
        lockerPackageId,
        lockerAdminCapId,
        wbtcTreasuryCapId
    };
} 