import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../../scripts/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import { verifyUpgradeCap } from '../utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

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


    // Get module bytecode
    const telebtcModule = fs.readFileSync(
        path.join(__dirname, '../../build/teleswap/bytecode_modules/telebtc.mv')
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
