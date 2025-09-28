import { parseRequest, createRequest, SimpleTransferRequest, tryAsVout, createBitcoinTransactionJson } from './bitcoin_parser';

// Test data
const testCases = [
    {
        name: "Basic test case",
        appId: 1,
        recipientAddress: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        networkFee: BigInt(1000),
        speed: 0,
        thirdParty: 0
    },
    {
        name: "Maximum values test case",
        appId: 255,
        recipientAddress: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        networkFee: BigInt(4294967295), // max 4-byte value
        speed: 1,
        thirdParty: 255
    },
    {
        name: "Zero values test case",
        appId: 0,
        recipientAddress: "0x0000000000000000000000000000000000000000000000000000000000000000",
        networkFee: BigInt(0),
        speed: 0,
        thirdParty: 0
    },
    {
        name: "Mixed values test case",
        appId: 42,
        recipientAddress: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        networkFee: BigInt(123456),
        speed: 1,
        thirdParty: 99
    }
];

// Helper function to validate SimpleTransferRequest
function validateTransferRequest(request: SimpleTransferRequest, expected: any): boolean {
    return request.appId === expected.appId &&
           request.recipientAddress === expected.recipientAddress &&
           request.networkFee === expected.networkFee &&
           request.speed === expected.speed &&
           request.thirdParty === expected.thirdParty;
}

// // Test function for createRequest
// function testCreateRequest() {
//     console.log("=== Testing createRequest function ===");
    
//     testCases.forEach((testCase, index) => {
//         console.log(`\nTest ${index + 1}: ${testCase.name}`);
        
//         try {
//             const hexResult = createRequest(
//                 testCase.appId,
//                 testCase.recipientAddress,
//                 testCase.networkFee,
//                 testCase.speed,
//                 testCase.thirdParty
//             );
            
//             console.log(`✅ Success: Created hex: ${hexResult}`);
//             console.log(`   Length: ${hexResult.length} characters (${hexResult.length / 2} bytes)`);
            
//             // Validate hex length (39 bytes = 78 characters)
//             if (hexResult.length !== 78) {
//                 console.log(`❌ Error: Expected 78 characters, got ${hexResult.length}`);
//             } else {
//                 console.log(`✅ Hex length validation passed`);
//             }
            
//         } catch (error) {
//             console.log(`❌ Error: ${(error as Error).message}`);
//         }
//     });
// }

// // Test function for parseRequest
// function testParseRequest() {
//     console.log("\n=== Testing parseRequest function ===");
    
//     testCases.forEach((testCase, index) => {
//         console.log(`\nTest ${index + 1}: ${testCase.name}`);
        
//         try {
//             // First create the hex
//             const hexValue = createRequest(
//                 testCase.appId,
//                 testCase.recipientAddress,
//                 testCase.networkFee,
//                 testCase.speed,
//                 testCase.thirdParty
//             );
            
//             // Then parse it back
//             const parsed = parseRequest(hexValue);
            
//             console.log(`✅ Success: Parsed hex: ${hexValue}`);
//             console.log(`   Parsed result:`);
//             console.log(`     appId: ${parsed.appId}`);
//             console.log(`     recipientAddress: ${parsed.recipientAddress}`);
//             console.log(`     networkFee: ${parsed.networkFee}`);
//             console.log(`     speed: ${parsed.speed}`);
//             console.log(`     thirdParty: ${parsed.thirdParty}`);
            
//             // Validate the parsed result matches the original
//             if (validateTransferRequest(parsed, testCase)) {
//                 console.log(`✅ Round-trip validation passed`);
//             } else {
//                 console.log(`❌ Round-trip validation failed`);
//             }
            
//         } catch (error) {
//             console.log(`❌ Error: ${(error as Error).message}`);
//         }
//     });
// }

// // Test function for round-trip validation
// function testRoundTrip() {
//     console.log("\n=== Testing round-trip validation ===");
    
//     testCases.forEach((testCase, index) => {
//         console.log(`\nTest ${index + 1}: ${testCase.name}`);
        
//         try {
//             // Create -> Parse -> Create again
//             const hex1 = createRequest(
//                 testCase.appId,
//                 testCase.recipientAddress,
//                 testCase.networkFee,
//                 testCase.speed,
//                 testCase.thirdParty
//             );
            
//             const parsed = parseRequest(hex1);
            
//             const hex2 = createRequest(
//                 parsed.appId,
//                 parsed.recipientAddress,
//                 parsed.networkFee,
//                 parsed.speed,
//                 parsed.thirdParty
//             );
            
//             if (hex1 === hex2) {
//                 console.log(`✅ Round-trip test passed`);
//                 console.log(`   Original: ${hex1}`);
//                 console.log(`   Round-trip: ${hex2}`);
//             } else {
//                 console.log(`❌ Round-trip test failed`);
//                 console.log(`   Original: ${hex1}`);
//                 console.log(`   Round-trip: ${hex2}`);
//             }
            
//         } catch (error) {
//             console.log(`❌ Error: ${(error as Error).message}`);
//         }
//     });
// }

// Main test runner
function runAllTests() {
    console.log("🚀 Starting Bitcoin Parser Tests\n");
    let res = createBitcoinTransactionJson(
        "test",
        1,
        "0xe4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595",
        1000,
        0,
        0,
        false
    )
    console.log(res);
    // testCreateRequest();
    // testParseRequest();
    // testRoundTrip();
    
    console.log("\n✅ All tests completed!");
}

// Run tests if this file is executed directly
runAllTests();

export { runAllTests }; 