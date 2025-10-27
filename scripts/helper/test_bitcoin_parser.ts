import { parseRequest, createRequest, SimpleTransferRequest, tryAsVout, createBitcoinTransactionJson, createSwapRequest } from './bitcoin_parser';

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

// Main test runner
function runAllTests() {
    console.log("🚀 Starting Bitcoin Parser Tests\n");
    // used for wrapping
    let wrapRes = createBitcoinTransactionJson(
        "test",
        1,
        "0x878799c85d1bcbd9419b150d2e2dabb1cdc49f361944e9235d8204ee45871c2b",
        1000,
        0,
        0,
        false,
        "4062c8aeed4f81c2d73ff854a2957021191e20b6", // sent to locker
        "12ab8dc588ca9d5787dde7eb29569da63c3a238c" // rest return to user
    )
    console.log(wrapRes);

    // use for burn proof
    let burnProofRes = createBitcoinTransactionJson(
        "burnproof",
        1,
        "0x878799c85d1bcbd9419b150d2e2dabb1cdc49f361944e9235d8204ee45871c2b",
        1000,
        0,
        0,
        false,
        "12ab8dc588ca9d5787dde7eb29569da63c3a238c", // main sent to user
        "4062c8aeed4f81c2d73ff854a2957021191e20b6", // rest return to locker
        undefined,
        0.098, // send 0.098 btc to recipient deduce the fee
        undefined,
        0,
        false,
        false
    )
    console.log(burnProofRes);
    
    console.log("\n✅ All tests completed!");
}

// Run tests if this file is executed directly
runAllTests();

export { runAllTests }; 