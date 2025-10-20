import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { revertBytes32,hexToBytes,printEvents } from '../../tests/utils/utils';


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

async function getBlockHash(height: number): Promise<string> {
    try {
        // First get the block hash from height
        const heightResponse = await fetch(`https://mempool.space/api/block-height/${height}`);
        const blockHash = await heightResponse.text();
        
        return blockHash.trim();
    } catch (error) {
        console.error('Error fetching block hash:', error);
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
    const packageData = JSON.parse(fs.readFileSync('package_id.json', 'utf8'));
    const packageId = packageData.btcrelay.packageId;
    const btcRelayId = packageData.btcrelay.relayId;
    console.log('Using package ID:', packageId);
    console.log('Using BTC relay ID:', btcRelayId);


    while(true){
        // Get the current height from the contract using lastSubmittedHeight function
        const tx = new TransactionBlock();
        tx.moveCall({
            target: `${packageId}::btcrelay::lastSubmittedHeight`,
            arguments: [tx.object(btcRelayId)]
        });
        
        const inspectResult = await client.devInspectTransactionBlock({
            transactionBlock: tx,
            sender: activeAddress
        });
        
        const returnValue = inspectResult.results?.[0]?.returnValues?.[0]?.[0];
        let lastSubmittedHeight = 0;
        
        if (Array.isArray(returnValue)) {
            // Convert little-endian byte array to number
            // u64 is 8 bytes, so we need to handle it properly
            const bytes = returnValue.slice(0, 8); // Take only the first 8 bytes
            lastSubmittedHeight = 0;
            for (let i = 0; i < bytes.length; i++) {
                lastSubmittedHeight += bytes[i] * Math.pow(256, i);
            }
        } else {
            lastSubmittedHeight = parseInt(returnValue || '0');
        }
        console.log('Current relay height:', lastSubmittedHeight);
        // sometimes, there may be a duplicated header error (12) because of the block info has not been updated yet

        // Fetch new block headers
        let newBlocks;
        if((lastSubmittedHeight+1)%2016<1996 && (lastSubmittedHeight+1)%2016!=0){
            newBlocks = await getBlockHeadersInBatch(lastSubmittedHeight + 1);
        }else{
            newBlocks = await getBlockHeaders(lastSubmittedHeight + 1);
        }

        // Create and configure transaction for header submission
        const submitTx = new TransactionBlock();
        submitTx.setGasBudget(500000000);

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
            submitTx.moveCall({
                target: `${packageId}::btcrelay::addHeadersWithRetarget`,
                arguments: [
                    submitTx.object(btcRelayId),
                    submitTx.pure(previousPeriodHeader), // old_period_start_header
                    submitTx.pure(previousHeader), // old_period_end_header
                    submitTx.pure(newBlocks), // headers
                ]
            });
        } else {
            console.log('Performing regular header submission...');
            
            // Call regular addHeaders function
            submitTx.moveCall({
                target: `${packageId}::btcrelay::addHeaders`,
                arguments: [
                    submitTx.object(btcRelayId),
                    submitTx.pure(previousHeader), // anchor
                    submitTx.pure(newBlocks), // headers
                ]
            });
        }

        console.log('Submitting new blocks...');
        const submitResult = await client.signAndExecuteTransactionBlock({
            transactionBlock: submitTx,
            signer: keypair,
            options: { showEffects: true }
        });

        if (submitResult.effects?.status.status === 'success') {
            console.log('Blocks submitted successfully!');
            console.log("--------------------------------")
            await new Promise(resolve => setTimeout(resolve, 500));
        } else {
            console.error('Block submission failed:', submitResult.effects?.status);
        }
    }
}

// Run the script
main().catch(console.error); 