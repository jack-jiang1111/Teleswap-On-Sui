import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';


async function getBlockHeaders(height: number): Promise<string> {
    try {
        // First get the block hash from height
        const heightResponse = await fetch(`https://mempool.space/api/block-height/${height}`);
        const blockHash = await heightResponse.text();
        
        // Then get the block header using the hash
        const headerResponse = await fetch(`https://mempool.space/api/block/${blockHash.trim()}/header`);
        const headerHex = await headerResponse.text();
        
        return headerHex.trim();
    } catch (error) {
        console.error('Error fetching block headers:', error);
        throw error;
    }
}

// get 20 block headers in one time
async function getBlockHeadersInBatch(height: number): Promise<string> {
    let headers = '';
    for(let i = 0; i < 20; i++){
        const header = await getBlockHeaders(height + i);
        headers += header;
    }
    return headers;
}

async function main() {
    // Get network from command line args or use default
    const networkName = process.argv[2];
    const network = getNetwork(networkName);
    console.log('Using network:', network.name);
    
    const client = new SuiClient({ url: network.url });
    
    // Get the keypair and address
    const keypair = await getActiveKeypair();
    const activeAddress = keypair.toSuiAddress();

    // Read contract data from the JSON file
    const contractData = JSON.parse(fs.readFileSync('../deploy/btc_relay.json', 'utf8'));
    const packageId = contractData.packageId;
    const btcRelayId = contractData.btcRelayId;
    console.log('Using package ID:', packageId);
    console.log('Using BTC relay ID:', btcRelayId);


    while(true){
        // Get the current height from the contract
        const btcRelay = await client.getObject({
            id: btcRelayId,
            options: { showContent: true }
        });

        const lastSubmittedHeight = parseInt((btcRelay.data?.content as any).fields.lastSubmittedHeight);
        console.log('Current relay height:', lastSubmittedHeight);
        // sometimes, there may be a duplicated header error (12) because of the block info has not been updated yet

        // Fetch new block headers
        let newBlocks;
        if((lastSubmittedHeight+1)%2016<1996 && (lastSubmittedHeight+1)%2016!=0){
            newBlocks = await getBlockHeadersInBatch(lastSubmittedHeight + 1);
        }else{
            newBlocks = await getBlockHeaders(lastSubmittedHeight + 1);
        }

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

        // Check if we need to do a retargeting submission
        const isRetargetingPeriod = (lastSubmittedHeight + 1) % 2016 === 0;
        const previousHeader = await getBlockHeaders(lastSubmittedHeight);
        if (isRetargetingPeriod) {
            console.log('Performing retargeting submission...');
            
            // Find the start of the current difficulty period
            const previousPeriodHeader = await getBlockHeaders(Math.floor(lastSubmittedHeight / 2016) * 2016);
            console.log('Previous period header:', previousPeriodHeader);
            console.log('Previous header :', previousHeader);
            // Call addHeadersWithRetarget function
            tx.moveCall({
                target: `${packageId}::btcrelay::addHeadersWithRetarget`,
                arguments: [
                    tx.object(btcRelayId),
                    tx.pure(previousPeriodHeader), // old_period_start_header
                    tx.pure(previousHeader), // old_period_end_header
                    tx.pure(newBlocks), // headers
                ]
            });
        } else {
            console.log('Performing regular header submission...');
            
            // Call regular addHeaders function
            tx.moveCall({
                target: `${packageId}::btcrelay::addHeaders`,
                arguments: [
                    tx.object(btcRelayId),
                    tx.pure(previousHeader), // anchor
                    tx.pure(newBlocks), // headers
                ]
            });
        }

        console.log('Submitting new blocks...');
        const result = await client.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: keypair,
            options: { showEffects: true }
        });

        if (result.effects?.status.status === 'success') {
            console.log('Blocks submitted successfully!');
            console.log("--------------------------------")
            await new Promise(resolve => setTimeout(resolve, 500));
        } else {
            console.error('Block submission failed:', result.effects?.status);
        }
    }
}

// Run the script
main().catch(console.error); 