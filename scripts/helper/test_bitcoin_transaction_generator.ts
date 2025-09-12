import { createBitcoinTransactionJson } from './bitcoin_parser';
import * as fs from 'fs';
import * as path from 'path';

// Test the improved Bitcoin transaction generator
function testBitcoinTransactionGenerator() {
    console.log("🚀 Testing Improved Bitcoin Transaction Generator\n");
    
    // Create the JSON object in the correct format
    const ccTransferRequests = {
        normalCCTransfer: createBitcoinTransactionJson(
            "normalCCTransfer",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            0,
            0
        ),
        normalCCTransfer_ZeroFee: createBitcoinTransactionJson(
            "normalCCTransfer_ZeroFee",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            0,
            0,
            0
        ),
        normalCCTransfer_zeroProtocolFee: createBitcoinTransactionJson(
            "normalCCTransfer_zeroProtocolFee",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            0,
            0
        ),
        normalCCTransfer_invalidFee: createBitcoinTransactionJson(
            "normalCCTransfer_invalidFee",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            65535,
            0,
            0
        ),
        UnfinalizedRequest: createBitcoinTransactionJson(
            "UnfinalizedRequest",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            0,
            0
        ),
        InvalidAppId: createBitcoinTransactionJson(
            "InvalidAppId",
            255,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            0,
            0
        ),
        InvalidSpeed: createBitcoinTransactionJson(
            "InvalidSpeed",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            47,
            0
        ),
        OlderBlock: createBitcoinTransactionJson(
            "OlderBlock",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            0,
            0
        ),
        NoBitcoinSent: createBitcoinTransactionJson(
            "NoBitcoinSent",
            1,
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            1000,
            0,
            0,
            true
        )
    };

    // Write to JSON file
    const outputPath = path.join(__dirname, '../tests/test_fixtures/ccTransferRequests.json');
    const jsonContent = JSON.stringify(ccTransferRequests, null, '\t'); // Use tabs for indentation
    
    try {
        fs.writeFileSync(outputPath, jsonContent, 'utf8');
        console.log(`✅ Successfully generated JSON file: ${outputPath}`);
        console.log(`📄 File contains ${Object.keys(ccTransferRequests).length} test cases`);
        
        // Also log the content to console for verification
        console.log("\n📋 Generated JSON content:");
        console.log(jsonContent);
        
    } catch (error) {
        console.error('❌ Error writing JSON file:', error);
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    testBitcoinTransactionGenerator();
}

export { testBitcoinTransactionGenerator }; 