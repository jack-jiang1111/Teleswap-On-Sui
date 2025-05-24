import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from './config';
import { getActiveKeypair } from './sui.utils';

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
    console.log('Using active address:', activeAddress);
    
    // Remove the original keypair creation since we did it in the loop
    // const keypair = Ed25519Keypair.fromSecretKey(fromB64(activeKey));
    
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


    if (result.effects?.status.status === 'success') {
        const packageId = result.effects.created?.[0].reference.objectId;
        console.log('Package deployed successfully!');
        console.log('Package ID:', packageId);
        
        fs.writeFileSync(
            'package-id.json', 
            JSON.stringify({ packageId }, null, 2)
        );
    } else {
        console.error('Deployment failed:', result.effects?.status);
    }
}

async function getBuildedModule(name: string): Promise<Uint8Array> {
    return fs.readFileSync(
        path.join(__dirname, `../build/teleswap/bytecode_modules/${name}.mv`)
    );
}

main().catch(console.error);