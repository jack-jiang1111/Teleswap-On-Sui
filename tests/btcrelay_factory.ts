// Helper function to convert byte array to hex string
import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../scripts/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import {  printEvents, verifyUpgradeCap } from './utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

export async function BtcRelayFactory(genesisHeader: string, height: number, periodStart: string, finalizationParameter: number): Promise<{deployer: Ed25519Keypair , packageId: string, upgradeCapId: string, relayAdminId: string, btcRelayId: string}> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();
    let packageId= "";
    let relayAdminId= "";
    let upgradeCapId= "";
    let MODULE_NAME = 'btcrelay';
    let btcRelayId= "";

    // Get modules bytecode
    const bitcoinHelperModule = fs.readFileSync(
        path.join(__dirname, '../build/teleswap/bytecode_modules/bitcoin_helper.mv')
    );
    const btcrelayModule = fs.readFileSync(
        path.join(__dirname, '../build/teleswap/bytecode_modules/btcrelay.mv')
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('Deploying package...');
    let tx = new TransactionBlock();
    const [upgradeCap] = tx.publish({
        modules: [Array.from(bitcoinHelperModule), Array.from(btcrelayModule)],
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

    // Verify all created objects and find UpgradeCap and RELAY_ADMIN
    console.log('\nVerifying all created objects:');
    for (const obj of result.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const isUpgradeCap = await verifyUpgradeCap(client, objectId);
        // console.log(`Object ID: ${objectId}`);

        // There will be two objects created under deployer's address: UpgradeCap and RELAY_ADMIN
        // we have to identify which one is the UpgradeCap and which one is the RELAY_ADMIN
        if (obj.owner === 'Immutable'){
            // This is the package ID
            packageId = objectId;
        }
        if (typeof obj.owner === 'object' && 
            obj.owner !== null && 
            'AddressOwner' in obj.owner && 
            obj.owner.AddressOwner === deployer.toSuiAddress()) {
            // Check if this is the UpgradeCap
            if (isUpgradeCap) {
                upgradeCapId = objectId;
            } else{
                relayAdminId = objectId;
            }
        }
    }

    if (upgradeCapId=="") {
        throw new Error('No upgrade capability found in deployment result');
    }

    if (relayAdminId=="") {
        throw new Error('No RELAY_ADMIN object found in deployment result');
    }

    console.log('\nSelected objects:');
    console.log('Package ID:', packageId);
    console.log('Upgrade Cap ID:', upgradeCapId);
    console.log('RELAY_ADMIN ID:', relayAdminId);

    // if we want to initialize later, return here (not a valid height)
    if(height==-1) {
        return {deployer, packageId, upgradeCapId, relayAdminId, btcRelayId};
    }
    tx = new TransactionBlock();
        
    tx.moveCall({
        target: `${packageId}::${MODULE_NAME}::initialize`,
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
    printEvents(result);
    // Get the new BTCRelay object ID from the effects
    const createdObjects = result.effects?.created || [];
    const newBtcRelay = createdObjects.find(obj => 
        (obj.owner as any)?.Shared?.initial_shared_version !== undefined
    );

    if (!newBtcRelay) {
        throw new Error('No new BTCRelay object found in transaction effects');
    }

    // Store the BTCRelay object ID for future tests
    btcRelayId = newBtcRelay.reference.objectId;
    return {deployer, packageId, upgradeCapId, relayAdminId, btcRelayId};
}
