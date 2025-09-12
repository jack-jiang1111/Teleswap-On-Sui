import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from '../config';
import { getActiveKeypair } from '../helper/sui.utils';
import { verifyUpgradeCap } from '../../tests/utils/utils';
// run the file to deploy the package
// ts-node ./01-deploy_btc_relay.ts [network]
// e.g. ts-node ./01-deploy_btc_relay.ts mainnet

async function main() {
    console.log('Building package...');
    execSync('sui move build', { stdio: 'inherit' });

    // Get network from command line args or use default
    const networkName = process.argv[2];
    const network = getNetwork(networkName);
    console.log('Using network:', network.name);
    
    const client = new SuiClient({ url: network.url });
    
    const keypair = await getActiveKeypair();
    const activeAddress = keypair.toSuiAddress();
    
    console.log('Deploying package...');
    // Get gas coins with proper object references
    const { data: gasObjects } = await client.getOwnedObjects({
        owner: activeAddress,
        filter: { MatchAll: [{ StructType: '0x2::coin::Coin<0x2::sui::SUI>' }] },
        options: { showContent: true, showType: true }
    });
    
    if (!gasObjects.length) {
        throw new Error('No gas coins available');
    }

    const gasCoins = gasObjects.map(obj => ({
        objectId: obj.data?.objectId ?? '',
        version: obj.data?.version?? '',
        digest: obj.data?.digest?? ''
    }));
    
    // Create and configure transaction
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.setGasPayment(gasCoins);

    const modules = [
        Array.from(await getBuildedModule('bitcoin_helper')),
        Array.from(await getBuildedModule('btcrelay'))
    ];

    const [upgradeCap] = tx.publish({
        modules,
        dependencies: ['0x1', '0x2', '0x3'],  // Add Sui Framework dependency
    });
    // Transfer the UpgradeCap to the deployer
    tx.transferObjects([upgradeCap], tx.pure(activeAddress));
    
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: keypair,
        options: { showEffects: true }
    });

    let packageId = "";
    let upgradeCapId = "";
    let relayAdminId = "";
    await new Promise(resolve => setTimeout(resolve, 3000)); // wait for 3s to make sure the transaction is executed

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
            obj.owner.AddressOwner === activeAddress) {
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

    if (result.effects?.status.status === 'success') {
        console.log('Package deployed successfully!');
        console.log('Package ID:', packageId);
        console.log('Upgrade Cap ID:', upgradeCapId);
        console.log('RELAY_ADMIN ID:', relayAdminId);
        fs.writeFileSync(
            'btc_relay.json', 
            JSON.stringify({ packageId, upgradeCapId, relayAdminId }, null, 2)
        );
    } else {
        console.error('Deployment failed:', result.effects?.status);
    }
}

async function getBuildedModule(name: string): Promise<Uint8Array> {
    return fs.readFileSync(
        path.join(__dirname, `../../btcrelay-package/build/btcrelay/bytecode_modules/${name}.mv`)
    );
}

main().catch(console.error);