import { TeleSwapSDK } from '../sdk/teleswap-sdk';
import { getActiveKeypair } from '../helper/sui.utils';
import { getNetwork } from '../helper/config';
import { CoinManager } from '../helper/coinManager';

// Test data constants
const LOCKER1_LOCKING_SCRIPT = "0x76a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac";
const USER_SCRIPT = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";


const SCRIPT_TYPE = 4;
const THIRD_PARTY = 0;

// Burn proof test data (from burn.test.ts)
const BURN_PROOF_DATA = {
  version: "0x02000000",
  vin: "0x02c25e69e28fcdfd55fc785605882564fd1837bd4f4511b7388af6435306be5186000000006c4830450221002529fcad507dc0b18eea08163af13aee575edb7e6614dcad26b3d32fe9a97b3f0220575e907409f6744d32de346de8cf05eeb7600ae522e843a21088133fc5fb23340121023ba4cb58bd9e0601213fa46cd992b827d46da84f6ff9c141f5f38a7ff463b0eae7feffffff",
  vout: "0x0240899500000000001976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac20f40e00000000001976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac", 
  locktime: "0x00000000",
  intermediateNodes: "a1b2c3d4e5f6789012345678901234567890abcd",
  index: 1,
  burnReqIndexes: [0],
  voutIndexes: [0]
};

class UnwrapTester {
  private sdk: TeleSwapSDK;
  private coinManager: CoinManager;
  private keypair: any;

  constructor() {
    const network = getNetwork('testnet');
    this.sdk = new TeleSwapSDK({ network: 'testnet' as any });
    this.coinManager = null as any; // Will be set in initialize
    this.keypair = null; // Will be set in initialize
  }

  async initialize() {
    this.keypair = await getActiveKeypair();
    // Recreate SDK with keypair
    const network = getNetwork('testnet');
    this.sdk = new TeleSwapSDK({ network: 'testnet' as any, keypair: this.keypair });
    this.coinManager = new CoinManager(this.sdk.getClient(), this.keypair);
    await this.sdk.initialize();
  }

  /**
   * Test 1: Unwrap function
   */
  async testUnwrap(): Promise<boolean> {
    console.log('\n🧪 Testing unwrap function...');
    
    try {
      // First, we need to get a TELEBTC coin to unwrap
      const packageIds = this.sdk.getPackageInfo();
      const telebtcCoins = await this.coinManager.getCoinsSorted(`${packageIds.telebtc.packageId}::telebtc::TELEBTC`);
      if (telebtcCoins.length === 0) {
        console.log('❌ No TELEBTC coins available for unwrap test');
        return false;
      }

      const coinToUnwrap = telebtcCoins[0];
      console.log(`Using TELEBTC coin: ${coinToUnwrap.coinObjectId}`);
      console.log(`Coin balance: ${coinToUnwrap.balance}`);

      // Calculate amount to unwrap (use a small amount for testing)
      const unwrapAmount = Math.min(10000000, parseInt(coinToUnwrap.balance)); // Use 0.1 TELEBTC or available balance
      console.log(`Unwrapping amount: ${unwrapAmount}`);

      // Call unwrap function with new signature
      const result = await this.sdk.unwrap(
        unwrapAmount,
        USER_SCRIPT,
        SCRIPT_TYPE,
        LOCKER1_LOCKING_SCRIPT,
        THIRD_PARTY
      );
      if(result?.success) {
        console.log(`✅ Unwrap completed successfully`);
        console.log(`Transaction digest: ${result.digest}`);
      } else {
        console.log(`❌ Unwrap failed:`, result?.error);
      }
      return result?.success;
    } catch (error) {
      console.error('❌ Unwrap failed:', error);
      return false;
    }
  }

  /**
   * Test 2: Burn proof function
   */
  async testBurnProof(blockNumber: number = 897120): Promise<boolean> {
    console.log('\n🧪 Testing burn proof function...');
    
    // need to provide exact amount of btc to recipient
    // protocol fee: goes to treasury
    // third party fee: 0
    // combined_fee for locker:
    // rewarder fee: goes to rewarder: 0.00005
    try {
      // Call burn proof function
      const result = await this.sdk.burnProof(
        BURN_PROOF_DATA.version,
        BURN_PROOF_DATA.vin,
        BURN_PROOF_DATA.vout, // transfer 0.098449 btc to recipient
        BURN_PROOF_DATA.locktime,
        blockNumber,
        BURN_PROOF_DATA.intermediateNodes,
        BURN_PROOF_DATA.index,
        LOCKER1_LOCKING_SCRIPT,
        BURN_PROOF_DATA.burnReqIndexes,
        BURN_PROOF_DATA.voutIndexes
      );

      if(result?.success) {
        console.log(`✅ Burn proof completed successfully`);
        console.log(`Transaction digest: ${result.digest}`);
      } else {
        console.log(`❌ Burn proof failed:`, result?.error);
      }
      return result?.success;
    } catch (error) {
      console.error('❌ Burn proof failed:', error);
      return false;
    }
  }

  /**
   * Test 3: Swap and unwrap function
   */
  async testSwapAndUnwrap(): Promise<boolean> {
    console.log('\n🧪 Testing swap and unwrap function...');
    console.log('Try to swap and unwrap 100 usdc to telebtc')
    try {
      // Get input coins for swapping
      const packageIds = this.sdk.getPackageInfo();
      const wbtcCoins = await this.coinManager.getCoinsSorted(`${packageIds.mockTokens.btc.packageId}::btc::BTC`);
      const suiCoins = await this.coinManager.getCoinsSorted('0x2::sui::SUI');
      const usdtCoins = await this.coinManager.getCoinsSorted(`${packageIds.mockTokens.usdt.packageId}::usdt::USDT`);
      const usdcCoins = await this.coinManager.getCoinsSorted(`${packageIds.mockTokens.usdc.packageId}::usdc::USDC`);

      console.log(`Available coins:`);
      console.log(`- WBTC: ${wbtcCoins.length} coins`);
      console.log(`- SUI: ${suiCoins.length} coins`);
      console.log(`- USDT: ${usdtCoins.length} coins`);
      console.log(`- USDC: ${usdcCoins.length} coins`);

      // Use SUI coins for the swap if available
      let inputCoinIds: any = {};
      let amounts: number[] = [];
      
      if (usdcCoins.length > 0) {
        amounts = [100,0]; // [inputTokenAmount, minTeleBTCAmount]
        inputCoinIds.usdc = usdcCoins.map(coin => coin.coinObjectId);
        inputCoinIds.wbtc = [];
        inputCoinIds.sui = [];
        inputCoinIds.usdt = [];
        console.log(`Using USDC coin: ${usdcCoins.map(coin => coin.coinObjectId)} with amount: ${amounts[0]}`);
      } else {
        console.log('❌ No suitable input coins available for swap and unwrap test');
        return false;
      }

      // Call swap and unwrap function
      const result = await this.sdk.swapAndUnwrap(
        amounts,
        USER_SCRIPT,
        SCRIPT_TYPE,
        LOCKER1_LOCKING_SCRIPT,
        THIRD_PARTY,
        inputCoinIds
      );

      console.log('✅ Swap and unwrap transaction successful');
      console.log(`Transaction digest: ${result.digest}`);
      
      return true;
    } catch (error) {
      console.error('❌ Swap and unwrap test failed:', error);
      return false;
    }
  }

  /**
   * Test 4: Burn proof after swap and unwrap
   */
  async testBurnProofAfterSwap(blockNumber: number = 897121): Promise<boolean> {
    console.log('\n🧪 Testing burn proof after swap and unwrap...');
    
    try {
      // Call burn proof function with a different block number
      const result = await this.sdk.burnProof(
        BURN_PROOF_DATA.version,
        BURN_PROOF_DATA.vin,
        BURN_PROOF_DATA.vout,
        BURN_PROOF_DATA.locktime,
        blockNumber,
        BURN_PROOF_DATA.intermediateNodes,
        BURN_PROOF_DATA.index,
        LOCKER1_LOCKING_SCRIPT,
        BURN_PROOF_DATA.burnReqIndexes,
        BURN_PROOF_DATA.voutIndexes
      );

      console.log('✅ Burn proof after swap transaction successful');
      console.log(`Transaction digest: ${result.digest}`);
      
      return true;
    } catch (error) {
      console.error('❌ Burn proof after swap test failed:', error);
      return false;
    }
  }

  /**
   * Run all tests in sequence
   */
  async runAllTests(): Promise<void> {
    console.log('🚀 Starting Unwrap Tests...');
    console.log('=====================================');

    const results = {
      unwrap: false,
      burnProof: false,
      swapAndUnwrap: false,
      burnProofAfterSwap: false
    };

    try {
      // // Test 1: Unwrap
      // results.unwrap = await this.testUnwrap();
      
      // // Wait a bit between tests
      // await new Promise(resolve => setTimeout(resolve, 2000));
      
      // // Test 2: Burn proof
      // results.burnProof = await this.testBurnProof();
      
      // // Wait a bit between tests
      // await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Test 3: Swap and unwrap
      results.swapAndUnwrap = await this.testSwapAndUnwrap();
      
      // // Wait a bit between tests
      // await new Promise(resolve => setTimeout(resolve, 2000));
      
      // // Test 4: Burn proof after swap
      // results.burnProofAfterSwap = await this.testBurnProofAfterSwap();

    } catch (error) {
      console.error('❌ Test execution failed:', error);
    }

    // Print results summary
    console.log('\n📊 Test Results Summary:');
    console.log('=====================================');
    console.log(`✅ Unwrap: ${results.unwrap ? 'PASSED' : 'FAILED'}`);
    console.log(`✅ Burn Proof: ${results.burnProof ? 'PASSED' : 'FAILED'}`);
    console.log(`✅ Swap and Unwrap: ${results.swapAndUnwrap ? 'PASSED' : 'FAILED'}`);
    console.log(`✅ Burn Proof After Swap: ${results.burnProofAfterSwap ? 'PASSED' : 'FAILED'}`);
    
    const totalTests = 4;
    const passedTests = Object.values(results).filter(Boolean).length;
    console.log(`\n🎯 Overall: ${passedTests}/${totalTests} tests passed`);
    
    if (passedTests === totalTests) {
      console.log('🎉 All tests passed!');
    } else {
      console.log('⚠️  Some tests failed. Check the logs above for details.');
    }
  }
}

// Main execution
async function main() {
  const tester = new UnwrapTester();
  
  try {
    await tester.initialize();
    await tester.runAllTests();
  } catch (error) {
    console.error('❌ Test initialization failed:', error);
    process.exit(1);
  }
}

// Run the tests if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { UnwrapTester };
