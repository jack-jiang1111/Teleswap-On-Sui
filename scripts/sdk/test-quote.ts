import { TeleSwapSDK, Network } from './teleswap-sdk';
import { getActiveKeypair } from '../helper/sui.utils';

async function testGetQuote() {
  console.log('🚀 Testing getQuote function...\n');

  try {
    // Initialize SDK
    const keypair = await getActiveKeypair();
    const sdk = new TeleSwapSDK({
      network: Network.TESTNET,
      keypair: keypair
    });

    console.log('📋 Test Parameters:');
    console.log(`- Network: ${sdk.getNetwork()}`);
    console.log(`- Address: ${sdk.getActiveAddress()}\n`);

    // Define supported tokens
    const supportedTokens = ['WBTC', 'SUI', 'USDC', 'USDT'];
    const telebtcToken = 'TELEBTC';
    
    // Test amounts for different tokens
    const testAmounts: Record<string, string> = {
      'TELEBTC': '1000000000',    // 10 TELEBTC (assuming 8 decimals)
      'WBTC': '10000000',     // 0.1 WBTC (assuming 8 decimals)
      'SUI': '100000000',   // 0.1 SUI (assuming 9 decimals)
      'USDC': '100000000',     // 100 USDC (assuming 6 decimals)
      'USDT': '100000000'      // 100 USDT (assuming 6 decimals)
    };

    let testCount = 0;
    let successCount = 0;
    let errorCount = 0;

    console.log('🔄 Testing all TELEBTC combinations...\n');

    // Test 1: Selling TELEBTC for other tokens
    console.log('📤 SELLING TELEBTC FOR OTHER TOKENS:');
    console.log('='.repeat(60));
    
    for (const outputToken of supportedTokens) {
      testCount++;
      console.log(`\n🔄 Test ${testCount}: Selling TELEBTC for ${outputToken}`);
      try {
        const [quoteSuccess, outputAmount] = await sdk.getQuote(
          telebtcToken,
          outputToken,
          testAmounts[telebtcToken],
          '0'
        );
        console.log('✅ Success: Yes');
        successCount++;
        console.log('📊 Quote Success:', quoteSuccess ? 'Yes' : 'No');
        console.log('💰 Output Amount:', outputAmount);
      } catch (error) {
        errorCount++;
        console.log('❌ Error:', error);
      }
    }

    console.log('\n' + '='.repeat(60) + '\n');

    // Test 2: Buying TELEBTC with other tokens
    console.log('📥 BUYING TELEBTC WITH OTHER TOKENS:');
    console.log('='.repeat(60));
    
    for (const inputToken of supportedTokens) {
      testCount++;
      console.log(`\n🔄 Test ${testCount}: Buying TELEBTC with ${inputToken}`);
      try {
        const [quoteSuccess, outputAmount] = await sdk.getQuote(
          inputToken,
          telebtcToken,
          testAmounts[inputToken],
          '0'
        );
        console.log('✅ Success: Yes');
        successCount++;
        console.log('📊 Quote Success:', quoteSuccess ? 'Yes' : 'No');
        console.log('💰 Output Amount:', outputAmount);
      } catch (error) {
        errorCount++;
        console.log('❌ Error:', error);
      }
    }

    console.log('\n' + '='.repeat(60) + '\n');

    // Test 3: Large output amount tests
    console.log('💰 TESTING WITH LARGE OUTPUT AMOUNTS:');
    console.log('='.repeat(60));
    
    for (const outputToken of supportedTokens) {
      testCount++;
      console.log(`\n🔄 Test ${testCount}: Selling TELEBTC for ${outputToken} (Large amount)`);
      try {
        const [quoteSuccess, outputAmount] = await sdk.getQuote(
          telebtcToken,
          outputToken,
          testAmounts[telebtcToken],
          '10000000000' // 1e10 - very large minimum output
        );
        console.log('✅ Success: Yes');
        successCount++;
        console.log('📊 Quote Success:', quoteSuccess ? 'Yes' : 'No');
        console.log('💰 Output Amount:', outputAmount);
        console.log('🎯 Min Output Required: 10000000000');
      } catch (error) {
        errorCount++;
        console.log('❌ Error:', error);
      }
    }

    console.log('\n' + '='.repeat(60) + '\n');

    console.log('📊 TEST SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${testCount}`);
    console.log(`✅ Successful: ${successCount}`);
    console.log(`❌ Failed: ${errorCount}`);
    console.log(`Success Rate: ${((successCount / testCount) * 100).toFixed(1)}%`);

    console.log('\n🎉 All tests completed!');

  } catch (error) {
    console.error('❌ Test setup failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testGetQuote().catch(console.error);
}

export { testGetQuote };
