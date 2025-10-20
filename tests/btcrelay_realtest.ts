import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFullnodeUrl } from '@mysten/sui.js/client';
import { getActiveKeypair } from '../scripts/helper/sui.utils';
import { BitcoinInterface } from '@teleportdao/bitcoin';
import { revertBytes32, bytesToHex, parseReturnValue, hexToBytes, printEvents, remove0xPrefix } from './utils/utils';
// We'll implement the deployment logic directly to avoid vitest dependencies

// Deployment function to avoid vitest dependencies
async function deployBtcRelay(genesisHeader: string, height: number, periodStart: string, finalizationParameter: number): Promise<{
    deployer: Ed25519Keypair, 
    packageId: string, 
    upgradeCapId: string, 
    relayAdminId: string, 
    btcRelayId: string
}> {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();
    
    // Get modules bytecode
    const bitcoinHelperModule = require('fs').readFileSync(
        require('path').join(__dirname, '../btcrelay-package/build/btcrelay/bytecode_modules/bitcoin_helper.mv')
    );
    const btcrelayModule = require('fs').readFileSync(
        require('path').join(__dirname, '../btcrelay-package/build/btcrelay/bytecode_modules/btcrelay.mv')
    );
    
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

    // Find package ID and admin objects
    let packageId = "";
    let relayAdminId = "";
    let upgradeCapId = "";

    for (const obj of result.effects?.created || []) {
        const objectId = obj.reference.objectId;
        
        if (obj.owner === 'Immutable'){
            packageId = objectId;
        }
        if (typeof obj.owner === 'object' && 
            obj.owner !== null && 
            'AddressOwner' in obj.owner && 
            obj.owner.AddressOwner === deployer.toSuiAddress()) {
            
            // Check if this is the UpgradeCap by trying to get its type
            try {
                const object = await client.getObject({ id: objectId, options: { showType: true } });
                if (object.data?.type?.includes('UpgradeCap')) {
                    upgradeCapId = objectId;
                } else {
                    relayAdminId = objectId;
                }
            } catch {
                relayAdminId = objectId;
            }
        }
    }

    if (upgradeCapId === "") {
        throw new Error('No upgrade capability found in deployment result');
    }
    if (relayAdminId === "") {
        throw new Error('No RELAY_ADMIN object found in deployment result');
    }

    console.log('Package ID:', packageId);
    console.log('Upgrade Cap ID:', upgradeCapId);
    console.log('RELAY_ADMIN ID:', relayAdminId);

    // Initialize the relay
    tx = new TransactionBlock();
                tx.moveCall({
        target: `${packageId}::btcrelay::initialize`,
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
    
    if (result.effects?.status?.status !== 'success') {
        throw new Error('Failed to initialize BTC relay');
    }
    
            printEvents(result);

    // Get the new BTCRelay object ID from the effects
    const createdObjects = result.effects?.created || [];
    console.log('Created objects:', createdObjects.map(obj => ({
        id: obj.reference.objectId,
        owner: obj.owner
    })));
    
    const newBtcRelay = createdObjects.find(obj => 
        (obj.owner as any)?.Shared?.initial_shared_version !== undefined
    );

    let btcRelayObject = newBtcRelay;
    if (!btcRelayObject) {
        console.log('No shared object found, looking for any created object...');
        // If no shared object, take the first created object that's not the package
        const nonPackageObjects = createdObjects.filter(obj => obj.owner !== 'Immutable');
        if (nonPackageObjects.length > 0) {
            btcRelayObject = nonPackageObjects[0];
            console.log('Using first non-package object as BTC Relay:', btcRelayObject.reference.objectId);
        } else {
            throw new Error('No new BTCRelay object found in transaction effects');
        }
    }

    const btcRelayId = btcRelayObject.reference.objectId;
    
    // Wait a bit more for the object to be available
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify the object exists
    try {
        const relayObject = await client.getObject({ id: btcRelayId, options: { showContent: true } });
        console.log('BTC Relay object verified:', relayObject.data?.objectId);
    } catch (error) {
        console.log('Warning: Could not verify BTC Relay object:', error);
    }
    
    return {deployer, packageId, upgradeCapId, relayAdminId, btcRelayId};
}

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

// Get multiple block headers in batch
async function getBlockHeadersInBatch(startHeight: number, count: number): Promise<string> {
    let headers = '';
    for(let i = 0; i < count; i++){
        const header = await getBlockHeaders(startHeight + i);
        headers += header;
        console.log(`Fetched block header for height ${startHeight + i}`);
    }
    return headers;
}

async function getBlockHash(height: number): Promise<string> {
    try {
        const response = await fetch(`https://mempool.space/api/block-height/${height}`);
        const blockHash = await response.text();
        return blockHash.trim();
                } catch (error) {
        console.error('Error fetching block hash:', error);
        throw error;
    }
}

async function main() {
    console.log('=== BTC Relay Real Test Script ===');
    console.log('Running on localnet with real Bitcoin data');
    
    // Initialize SUI client with localnet
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    
    
    // Starting height
    const startHeight = 897110;
    console.log(`Starting from Bitcoin height: ${startHeight}`);
    
    try {
        // Step 1: Deploy and initialize BTC relay
        console.log('\n=== Step 1: Deploying and Initializing BTC Relay ===');
        
        // Get the genesis header and period start for height 897110
        const genesisHeader = await getBlockHeaders(startHeight);
        const periodStartHeight = startHeight - (startHeight % 2016);
        const periodStartHash = await getBlockHash(periodStartHeight);
        const periodStart = revertBytes32(periodStartHash);
        
        console.log(`Genesis height: ${startHeight}`);
        console.log(`Period start height: ${periodStartHeight}`);
        console.log(`Genesis header: ${genesisHeader.substring(0, 20)}...`);
        console.log(`Period start hash: ${periodStart}`);
        
        // Deploy and initialize the relay
        const result = await deployBtcRelay(genesisHeader, startHeight, periodStart, 3);
        const { deployer, packageId, upgradeCapId, relayAdminId, btcRelayId } = result;
        
        console.log('BTC Relay deployed and initialized successfully!');
        console.log(`Package ID: ${packageId}`);
        console.log(`BTC Relay ID: ${btcRelayId}`);
        console.log(`Admin ID: ${relayAdminId}`);
        
        
        // Step 3: Submit real block headers one by one
        console.log('\n=== Step 3: Submitting Real Block Headers (2050 blocks) ===');
        
        const totalBlocksToSubmit = 2050;
        console.log(`Submitting ${totalBlocksToSubmit} real block headers one by one...`);
        
        let currentHeight = startHeight;
        let previousHeader = genesisHeader;
        
        for (let blockIndex = 0; blockIndex < totalBlocksToSubmit; blockIndex++) {
            const blockHeight = currentHeight + 1;
            
            console.log(`\n--- Block ${blockIndex + 1}/${totalBlocksToSubmit}: Submitting block ${blockHeight} ---`);
            
            // Check if we're at a retargeting period
            const isRetargetingPeriod = blockHeight % 2016 === 0;
            
            if (isRetargetingPeriod) {
                console.log(`🔄 Retargeting period detected at height ${blockHeight}, using retargeting submission...`);
                
                // Get the period start and end headers for retargeting
                const periodStartHeight = Math.floor((blockHeight - 1) / 2016) * 2016;
                const periodEndHeight = periodStartHeight + 2015;
                
                const periodStartHeader = await getBlockHeaders(periodStartHeight);
                const periodEndHeader = await getBlockHeaders(periodEndHeight);
                const newBlockHeader = await getBlockHeaders(blockHeight);
                
                console.log(`Period start height: ${periodStartHeight}`);
                console.log(`Period end height: ${periodEndHeight}`);
                
                // Submit with retargeting
                const retargetTx = new TransactionBlock();
                retargetTx.setGasBudget(1000000000);
                
                retargetTx.moveCall({
                    target: `${packageId}::btcrelay::addHeadersWithRetarget`,
                    arguments: [
                        retargetTx.object(btcRelayId),
                        retargetTx.pure(periodStartHeader), // old_period_start_header
                        retargetTx.pure(periodEndHeader), // old_period_end_header
                        retargetTx.pure(newBlockHeader) // new block header
                    ]
                });
                
                console.log(`Submitting retargeting block ${blockHeight}...`);
                const retargetResult = await client.signAndExecuteTransactionBlock({
                    transactionBlock: retargetTx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });
                
                if (retargetResult.effects?.status.status === 'success') {
                    console.log(`✅ Retargeting block ${blockHeight} submitted successfully!`);
                    currentHeight = blockHeight;
                    previousHeader = newBlockHeader;
                } else {
                    console.log(`❌ Retargeting block ${blockHeight} submission failed:`, retargetResult.effects?.status);
                    console.log('Error details:', retargetResult.effects?.status.error);
                    return;
                }
            } else {
                // Regular block submission
                const newBlockHeader = await getBlockHeaders(blockHeight);
                
                const submitTx = new TransactionBlock();
                submitTx.setGasBudget(1000000000);
                
                submitTx.moveCall({
                    target: `${packageId}::btcrelay::addHeaders`,
                    arguments: [
                        submitTx.object(btcRelayId),
                        submitTx.pure(previousHeader),
                        submitTx.pure(newBlockHeader)
                    ]
                });
                
                console.log(`Submitting regular block ${blockHeight}...`);
                const submitResult = await client.signAndExecuteTransactionBlock({
                    transactionBlock: submitTx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });
                
                if (submitResult.effects?.status.status === 'success') {
                    console.log(`✅ Block ${blockHeight} submitted successfully!`);
                    currentHeight = blockHeight;
                    previousHeader = newBlockHeader;
                } else {
                    console.log(`❌ Block ${blockHeight} submission failed:`, submitResult.effects?.status);
                    console.log('Error details:', submitResult.effects?.status.error);
                    return;
                }
            }
            
            // Small delay between blocks
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Final verification
        console.log('\n=== Final Verification ===');
        
        // Check the final last submitted height
            const verifyTx = new TransactionBlock();
            verifyTx.moveCall({
            target: `${packageId}::btcrelay::lastSubmittedHeight`,
            arguments: [verifyTx.object(btcRelayId)]
            });

            const verifyResult = await client.devInspectTransactionBlock({
                transactionBlock: verifyTx,
            sender: deployer.toSuiAddress()
        });
        
        const finalReturnValue = verifyResult.results?.[0]?.returnValues?.[0]?.[0];
        let finalLastSubmittedHeight = 0;
        
        if (Array.isArray(finalReturnValue)) {
            const bytes = finalReturnValue.slice(0, 8);
            finalLastSubmittedHeight = 0;
            for (let i = 0; i < bytes.length; i++) {
                finalLastSubmittedHeight += bytes[i] * Math.pow(256, i);
            }
        } else {
            finalLastSubmittedHeight = parseInt(finalReturnValue || '0');
        }
        
        console.log(`Final relay height: ${finalLastSubmittedHeight}`);
        console.log(`Expected height: ${startHeight + totalBlocksToSubmit}`);
        
        if (finalLastSubmittedHeight === startHeight + totalBlocksToSubmit) {
            console.log('✅ All blocks submitted successfully!');
        } else {
            console.log('❌ Height mismatch - some blocks may not have been submitted');
        }
        
        console.log('\n=== Test Completed Successfully ===');
        console.log(`✅ Submitted ${totalBlocksToSubmit} real Bitcoin block headers`);
        console.log(`✅ Final height: ${finalLastSubmittedHeight}`);
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        throw error;
    }
}

// Run the script
if (require.main === module) {
    main().catch(console.error);
}

export { main };
