async function fetchBlockHeader(blockHeight) {
    try {
        // First get the block hash from height
        const heightResponse = await fetch(`https://mempool.space/api/block-height/${blockHeight}`);
        const blockHash = await heightResponse.text();
        
        // Then get the block header using the hash
        const headerResponse = await fetch(`https://mempool.space/api/block/${blockHash.trim()}/header`);
        const headerHex = await headerResponse.text();
        
        console.log(`Block Height: ${blockHeight}`);
        console.log(`Block Hash: ${blockHash.trim()}`);
        console.log(`Block Header (hex): ${headerHex.trim()}`);
        console.log(`Header Length: ${headerHex.trim().length / 2} bytes`);
        
        return headerHex.trim();
    } catch (error) {
        console.error('Error fetching block header:', error);
    }
}

// Example usage
const blockHeight = 841968; // You can change this to any height
fetchBlockHeader(blockHeight);