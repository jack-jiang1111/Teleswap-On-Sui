import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';

async function main() {
    // Get network from command line args or use default
    const networkName = process.argv[2];
    const network = getNetwork(networkName);
    console.log('Using network:', network.name);
    
    const client = new SuiClient({ url: network.url });
    
    // Get the keypair and address
    const keypair = await getActiveKeypair();
    const activeAddress = keypair.toSuiAddress();

    // Read package ID from the JSON file in main directory
    const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package_id.json'), 'utf8'));
    const packageId = packageData.btcrelayPackageId;
    console.log('Using package ID:', packageId);

    // Parameters for initialization
    // TODO: Replace these with actual values
    const genesis_header_hex = "00e05b2315d5244defc05310f45733be5d52dee66f0c0bb19f4802000000000000000000727e95f88f38dc43a55a2a24fa8697c6e682fcd22149b61ff3e958d0d22e90c3568c2868ed5c02179dcd6b73"; 
    const height = 897110; 
    // 806400 hash in little endian
    const period_start_hex = "5559430ef0abdfd1a35fc800b39ea8de6aba033246ef10000000000000000000";  
    const finalization_parameter = 3; // Default value

    console.log('Initializing BTC relay with parameters:');
    console.log('Genesis header:', genesis_header_hex);
    console.log('Height:', height);
    console.log('Period start:', period_start_hex);
    console.log('Finalization parameter:', finalization_parameter);

    // Get gas coins
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

    // Call initialize function
    tx.moveCall({
        target: `${packageId}::btcrelay::initialize`,
        arguments: [
            tx.pure(genesis_header_hex),
            tx.pure(height),
            tx.pure(period_start_hex),
            tx.pure(finalization_parameter),
            tx.object(packageData.btcrelayAdminId), // Pass the relayAdmin object
        ]
    });

    console.log('Executing transaction...');
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: keypair,
        options: { showEffects: true }
    });

    if (result.effects?.status.status === 'success') {
        console.log('BTC relay initialized successfully!');
        // Save the relay object ID if needed
        // Get the new BTCRelay object ID from the effects
        const createdObjects = result.effects?.created || [];
        const newBtcRelay = createdObjects.find(obj => 
            (obj.owner as any)?.Shared?.initial_shared_version !== undefined
        );

        if (!newBtcRelay) {
            throw new Error('No new BTCRelay object found in transaction effects');
        }

        // Store the BTCRelay object ID for future tests
        let btcRelayId = newBtcRelay.reference.objectId;
        if (btcRelayId) {
            // Read existing JSON file
            const existingData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package_id.json'), 'utf8'));
            
            // Append new data
            const updatedData = {
                ...existingData,
                btcRelayId: btcRelayId
            };
            
            // Write back the combined data
            fs.writeFileSync(
                path.join(__dirname, '../../package_id.json'),
                JSON.stringify(updatedData, null, 2)
            );
            console.log('Relay object ID:', btcRelayId);
        }
    } else {
        console.error('Initialization failed:', result.effects?.status);
    }
}

main().catch(console.error); 