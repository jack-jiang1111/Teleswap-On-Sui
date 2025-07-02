import { createBitcoinTransactionJson } from './bitcoin_parser';

// Test the improved Bitcoin transaction generator
function testBitcoinTransactionGenerator() {
    console.log("🚀 Testing Improved Bitcoin Transaction Generator\n");
    
    // Test case 1: Basic transaction (matches normalCCTransfer)
    //console.log("=== Test Case 1: Basic Transaction ===");
    const basicTransaction = createBitcoinTransactionJson(
        "normalCCTransfer",
        1,
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        1000,
        0,
        1000,
        0
    );
    console.log(basicTransaction);
    console.log("\n" + "=".repeat(80) + "\n");
    
    // Test case 2: Zero fee (matches normalCCTransfer_ZeroFee)
    //console.log("=== Test Case 2: Zero Fee ===");
    const zeroFeeTransaction = createBitcoinTransactionJson(
        "normalCCTransfer_ZeroFee",
        1,
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        1000,
        0,
        0,
        0
    );
    console.log(zeroFeeTransaction);

    console.log("\n" + "=".repeat(80) + "\n");
    
    // Test case 3: Invalid fee (matches normalCCTransfer_invalidFee)
    //console.log("=== Test Case 3: Invalid Fee ===");
    const invalidFeeTransaction = createBitcoinTransactionJson(
        "normalCCTransfer_invalidFee",
        1,
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        1000,
        0,
        65535,
        0
    );
    console.log(invalidFeeTransaction);

    console.log("\n" + "=".repeat(80) + "\n");
    
    // Test case 4: Invalid app ID (matches InvalidAppId)
    //console.log("=== Test Case 4: Invalid App ID ===");
    const invalidAppIdTransaction = createBitcoinTransactionJson(
        "InvalidAppId",
        255,
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        1000,
        0,
        1000,
        0
    );
    console.log(invalidAppIdTransaction);

    console.log("\n" + "=".repeat(80) + "\n");
    
    // Test case 5: Invalid speed (matches InvalidSpeed)
    //console.log("=== Test Case 5: Invalid Speed ===");
    const invalidSpeedTransaction = createBitcoinTransactionJson(
        "InvalidSpeed",
        1,
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        1000,
        47,
        1000,
        0
    );
    console.log(invalidSpeedTransaction);

    console.log("\n" + "=".repeat(80) + "\n");
}

// Run the test if this file is executed directly
if (require.main === module) {
    testBitcoinTransactionGenerator();
}

export { testBitcoinTransactionGenerator }; 