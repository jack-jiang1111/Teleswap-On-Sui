import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../../scripts/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import { verifyUpgradeCap } from '../utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
// Function to update Move.toml with actual package IDs
function ResetTelebtcMoveToml() {

    // Update telebtc-package/Move.toml
    const telebtcMovetomlPath = path.join(__dirname, '../../telebtc-package/Move.toml');
    let telebtcMoveTomlContent = fs.readFileSync(telebtcMovetomlPath, 'utf8');
    
    // Update the btcrelay address from 0x0 to the deployed package ID
    telebtcMoveTomlContent = telebtcMoveTomlContent.replace(
        /telebtc = "[^"]*"/,
        `telebtc = "0x0"`
    );
    
    fs.writeFileSync(telebtcMovetomlPath, telebtcMoveTomlContent);
    console.log('Reset telebtc-package/Move.toml');

    // Rebuild the package with updated dependencies
    console.log('Rebuilding package with updated dependencies...');
    const { execSync } = require('child_process');
    try {
        const teleswapMainPackagePath = path.join(__dirname, '../../telebtc-package');
        execSync('sui move build --skip-fetch-latest-git-deps', { 
            stdio: 'inherit',
            cwd: teleswapMainPackagePath
        });
        console.log('Package rebuilt successfully');
    } catch (error) {
        console.error('Failed to rebuild package:', error);
        throw error;
    }
}
export async function TeleBTCFactory(): Promise<{
    deployer: Ed25519Keypair,
    packageId: string,
    upgradeCapId: string,
    treasuryCapId: string,
    capId: string,
    adminId: string
}> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();
    let packageId = "";
    let upgradeCapId = "";
    let treasuryCapId = "";
    let capId = "";
    let adminId = "";

    ResetTelebtcMoveToml()
    // Get module bytecode
    const telebtcModule = fs.readFileSync(
        path.join(__dirname, '../../telebtc-package/build/telebtc/bytecode_modules/telebtc.mv')
    );
    console.log('Deploying telebtc package...');
    let tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    const [upgradeCap] = tx.publish({
        modules: [Array.from(telebtcModule)],
        dependencies: ['0x1', '0x2', '0x3']
    });

    // Transfer the UpgradeCap to the deployer
    tx.transferObjects([upgradeCap], tx.pure(deployer.toSuiAddress()));
    await new Promise(resolve => setTimeout(resolve, 1000));
    let result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });

    await new Promise(resolve => setTimeout(resolve, 3000)); // wait for 3s
    if(result.effects?.status?.status !== 'success') {
        console.log(result.effects?.status);
        throw new Error('Transaction failed');
    }
    // Identify created objects
    for (const obj of result.effects?.created || []) {

        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';

        if(type=="package"){
            packageId = objectId;
        }
        else if (type.includes('TreasuryCap')) {
            treasuryCapId = objectId;
        } 
        else if (type.includes('TeleBTCCap')) {
            capId = objectId;
        }
        else if (type.includes('UpgradeCap')) {
            upgradeCapId = objectId;
        }
        else if (type.includes('TELEBTC_ADMIN')) {
            adminId = objectId;
        }
    }

    if (!upgradeCapId) throw new Error('No upgrade capability found in deployment result');
    if (!treasuryCapId) throw new Error('No TreasuryCap object found in deployment result');
    if (!capId) throw new Error('No TeleBTCCap object found in deployment result');

    console.log('\nSelected objects:');
    console.log('Package ID:', packageId);
    console.log('Upgrade Cap ID:', upgradeCapId);
    console.log('TreasuryCap ID:', treasuryCapId);
    console.log('TeleBTCCap ID:', capId);
    console.log('Admin ID:', adminId);

    return { deployer, packageId, upgradeCapId, treasuryCapId, capId, adminId };
}
