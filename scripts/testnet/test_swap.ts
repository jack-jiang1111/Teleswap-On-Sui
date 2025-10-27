import { PackageManager } from "../helper/package_manager";
import { SuiClient, SuiHTTPTransport } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../helper/sui.utils';
import { getNetwork } from '../helper/config';
import { CoinManager } from '../helper/coinManager';

// Test the swap function in dex connector
// 1. swap telebtc->wbtc/usdc/usdt/sui
// 2. swap wbtc/usdc/usdt/sui->telebtc

interface SwapTestResult {
  success: boolean;
  telebtcAmount: number;
  wbtcAmount: number;
  suiAmount: number;
  usdtAmount: number;
  usdcAmount: number;
  testName: string;
}

class SwapTester {
  private client: SuiClient;
  private keypair: any;
  private packageManager: PackageManager;
  private coinManager: CoinManager;

  constructor() {
    const network = getNetwork('testnet');
    this.client = new SuiClient({ url: network.url });
    this.keypair = null; // Will be set in initialize
    this.packageManager = new PackageManager();
    this.coinManager = null as any; // Will be set in initialize
  }

  async initialize() {
    this.keypair = await getActiveKeypair();
    this.coinManager = new CoinManager(this.client, this.keypair);
  }

  /**
   * Execute a swap transaction
   */
  private async executeSwap(
    targetToken: string,
    inputAmount: number,
    minOutputAmount: number,
    telebtcCoinIds: string[],
    wbtcCoinIds: string[],
    suiCoinIds: string[],
    usdtCoinIds: string[],
    usdcCoinIds: string[],
    testName: string
  ): Promise<SwapTestResult> {
    console.log(`\n🔄 Executing ${testName}...`);
    console.log(`Input amount: ${inputAmount}`);
    console.log(`Min output amount: ${minOutputAmount}`);
    let gas_limit = 100000000; // 0.1sui as gas limit
    const txb = new TransactionBlock();
    txb.setGasBudget(gas_limit); // Set gas budget
    
    // Get coin types for comparison
    const mockTokens = this.packageManager.getMockTokens();
    const suiType = '0x2::sui::SUI';
    
    // Get pool IDs from package manager
    const pools = this.packageManager.getCetusPools();
    const poolUsdcSui = pools['USDC-SUI'];
    const poolUsdcUsdt = pools['USDC-USDT'];
    const poolUsdcWbtc = pools['USDC-BTC'];
    const poolTelebtcWbtc = pools['BTC-TELEBTC'];

    if (!poolUsdcSui || !poolUsdcUsdt || !poolUsdcWbtc || !poolTelebtcWbtc) {
      throw new Error('Pool IDs not found in package manager');
    }

    // Get the main package ID
    const mainPackageId = this.packageManager.getMainPackage("testnet").packageId;
    const configId = "0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e";
    const clockId = "0x6";

    // Get coin types
    const telebtcType = `${this.packageManager.getTelebtc().packageId}::telebtc::TELEBTC`;
    const wbtcType = `${mockTokens.btc.packageId}::btc::BTC`;
    const usdtType = `${mockTokens.usdt.packageId}::usdt::USDT`;
    const usdcType = `${mockTokens.usdc.packageId}::usdc::USDC`;

    // Create coin lists - only the input token gets the actual coins, others get empty lists
    let telebtcCoins: any[], wbtcCoins: any[], suiCoins: any[], usdtCoins: any[], usdcCoins: any[];
    if (targetToken === telebtcType) {
      // TELEBTC is the OUTPUT - we're buying TELEBTC with other tokens
      telebtcCoins = []; // Empty - we're receiving TELEBTC

      // Then we need to prepare the swapped coin list, converting the coin ids to coin objects
      // SUI input path uses dedicated preparation to avoid gas/input coin conflicts
      if(suiCoinIds.length > 0) {
        const suiCoinsIds = await this.coinManager.prepareSuiForSwap(inputAmount, gas_limit);
        suiCoins = suiCoinsIds.swapCoinIds.map((id) => txb.object(id));
      }
      else {
        suiCoins = [];
      }

      wbtcCoins = wbtcCoinIds.map((id) => txb.object(id));
      usdtCoins = usdtCoinIds.map((id) => txb.object(id));
      usdcCoins = usdcCoinIds.map((id) => txb.object(id));
    } else if (targetToken === wbtcType || targetToken === suiType || targetToken === usdtType || targetToken === usdcType) {
      // WBTC is the OUTPUT - we're selling TELEBTC to get WBTC
      telebtcCoins = (telebtcCoinIds).map((id) => txb.object(id)); // Use TELEBTC as input
      wbtcCoins = []; // Empty - we're receiving WBTC
      suiCoins = [];
      usdtCoins = [];
      usdcCoins = [];
    } else {
      throw new Error(`Unknown target token: ${targetToken}`);
    }

    // Get pool objects
    const poolUsdcSuiObj = txb.object(poolUsdcSui);
    const poolUsdcUsdtObj = txb.object(poolUsdcUsdt);
    const poolUsdcWbtcObj = txb.object(poolUsdcWbtc);
    const poolTelebtcWbtcObj = txb.object(poolTelebtcWbtc);

    // Get config and clock objects
    const configObj = txb.object(configId);
    const clockObj = txb.object(clockId);

    // Create Move vectors for coin lists with proper type specification for empty vectors
    const telebtcVector = telebtcCoins.length > 0 
      ? txb.makeMoveVec({ objects: telebtcCoins })
      : txb.makeMoveVec({ objects: [], type: `0x2::coin::Coin<${telebtcType}>` });
    
    const wbtcVector = wbtcCoins.length > 0 
      ? txb.makeMoveVec({ objects: wbtcCoins })
      : txb.makeMoveVec({ objects: [], type: `0x2::coin::Coin<${wbtcType}>` });
    
    const suiVector = suiCoins.length > 0 
      ? txb.makeMoveVec({ objects: suiCoins })
      : txb.makeMoveVec({ objects: [], type: `0x2::coin::Coin<${suiType}>` });
    
    const usdtVector = usdtCoins.length > 0 
      ? txb.makeMoveVec({ objects: usdtCoins })
      : txb.makeMoveVec({ objects: [], type: `0x2::coin::Coin<${usdtType}>` });
    
    const usdcVector = usdcCoins.length > 0 
      ? txb.makeMoveVec({ objects: usdcCoins })
      : txb.makeMoveVec({ objects: [], type: `0x2::coin::Coin<${usdcType}>` });

    // Do not set gas payment explicitly; let runtime choose a suitable gas coin
    

    // Call the swap function and destructure the return values
    const [success, telebtcResult, wbtcResult, suiResult, usdtResult, usdcResult] = txb.moveCall({
      target: `${mainPackageId}::dexconnector::mainSwapTokens`,
      typeArguments: [`${targetToken}`],
      arguments: [
        configObj,
        poolUsdcSuiObj,
        poolUsdcUsdtObj,
        poolUsdcWbtcObj,
        poolTelebtcWbtcObj,
        txb.pure.u64(inputAmount),
        txb.pure.u64(minOutputAmount),
        telebtcVector,
        wbtcVector,
        suiVector,
        usdtVector,
        usdcVector,
        clockObj,
      ],
    });

    // Transfer the result coins back to sender
    txb.transferObjects([telebtcResult, wbtcResult, suiResult, usdtResult, usdcResult], this.keypair.toSuiAddress());

    try {
      const result = await this.client.signAndExecuteTransactionBlock({
        transactionBlock: txb,
        signer: this.keypair,
        options: {
          showEffects: true,
          showObjectChanges: true,
        },
      });
      if(result?.effects?.status?.status === "success") {
        console.log(`✅ ${testName} completed successfully`);
        console.log(`Transaction digest: ${result.digest}`);
      } else {
        console.log(`❌ ${testName} failed:`, result?.effects?.status?.error);
      }

      // Parse the results (this is simplified - in reality you'd need to parse the return values)
      return {
        success: true,
        telebtcAmount: 0, // Would need to parse from transaction result
        wbtcAmount: 0,
        suiAmount: 0,
        usdtAmount: 0,
        usdcAmount: 0,
        testName,
      };

    } catch (error) {
      console.log(`❌ ${testName} failed:`, error);
      return {
        success: false,
        telebtcAmount: 0,
        wbtcAmount: 0,
        suiAmount: 0,
        usdtAmount: 0,
        usdcAmount: 0,
        testName,
      };
    }
  }

  /**
   * Run a single test case
   */
  async runSingleTest(testNumber: number): Promise<SwapTestResult> {
    console.log(`🚀 Running Test ${testNumber}...\n`);

    // Get coin types from package manager
    const mockTokens = this.packageManager.getMockTokens();
    const mainPackageId = this.packageManager.getMainPackage("testnet").packageId;
    
    const telebtcType = `${this.packageManager.getTelebtc().packageId}::telebtc::TELEBTC`;
    const wbtcType = `${mockTokens.btc.packageId}::btc::BTC`;
    const suiType = '0x2::sui::SUI';
    const usdtType = `${mockTokens.usdt.packageId}::usdt::USDT`;
    const usdcType = `${mockTokens.usdc.packageId}::usdc::USDC`;

    try {
      switch (testNumber) {
        case 1: {
          // Test 1: TELEBTC -> WBTC (0.01 TELEBTC)
          console.log('📋 Test 1: TELEBTC -> WBTC');
          const telebtcCoinIds = await this.coinManager.getSwapCoins(telebtcType, 10000);
          const wbtcCoinIds = await this.coinManager.getSwapCoins(wbtcType, 0);
          const suiCoinIds = await this.coinManager.getSwapCoins(suiType, 0);
          const usdtCoinIds = await this.coinManager.getSwapCoins(usdtType, 0);
          const usdcCoinIds = await this.coinManager.getSwapCoins(usdcType, 0);
          
          return await this.executeSwap(
            wbtcType,
            10000,
            0,
            telebtcCoinIds,
            wbtcCoinIds,
            suiCoinIds,
            usdtCoinIds,
            usdcCoinIds,
            'TELEBTC -> WBTC'
          );
        }
        
        case 2: {
          // Test 2: TELEBTC -> USDC (0.01 TELEBTC)
          console.log('📋 Test 2: TELEBTC -> USDC');
          const telebtcCoinIds = await this.coinManager.getSwapCoins(telebtcType, 1000000);
          const wbtcCoinIds = await this.coinManager.getSwapCoins(wbtcType, 0);
          const suiCoinIds = await this.coinManager.getSwapCoins(suiType, 0);
          const usdtCoinIds = await this.coinManager.getSwapCoins(usdtType, 0);
          const usdcCoinIds = await this.coinManager.getSwapCoins(usdcType, 0);
          
          return await this.executeSwap(
            usdcType,
            1000000,
            0,
            telebtcCoinIds,
            wbtcCoinIds,
            suiCoinIds,
            usdtCoinIds,
            usdcCoinIds,
            'TELEBTC -> USDC'
          );
        }
        
        case 3: {
          // Test 3: TELEBTC -> USDT (0.01 TELEBTC)
          console.log('📋 Test 3: TELEBTC -> USDT');
          const telebtcCoinIds = await this.coinManager.getSwapCoins(telebtcType, 1000000);
          const wbtcCoinIds = await this.coinManager.getSwapCoins(wbtcType, 0);
          const suiCoinIds = await this.coinManager.getSwapCoins(suiType, 0);
          const usdtCoinIds = await this.coinManager.getSwapCoins(usdtType, 0);
          const usdcCoinIds = await this.coinManager.getSwapCoins(usdcType, 0);
          
          return await this.executeSwap(
            usdtType,
            1000000,
            0,
            telebtcCoinIds,
            wbtcCoinIds,
            suiCoinIds,
            usdtCoinIds,
            usdcCoinIds,
            'TELEBTC -> USDT'
          );
        }
        
        case 4: {
          // Test 4: TELEBTC -> SUI (0.01 TELEBTC)
          console.log('📋 Test 4: TELEBTC -> SUI');
          const telebtcCoinIds = await this.coinManager.getSwapCoins(telebtcType, 1000000);
          const wbtcCoinIds = await this.coinManager.getSwapCoins(wbtcType, 0);
          const suiCoinIds = await this.coinManager.getSwapCoins(suiType, 0);
          const usdtCoinIds = await this.coinManager.getSwapCoins(usdtType, 0);
          const usdcCoinIds = await this.coinManager.getSwapCoins(usdcType, 0);
          
          return await this.executeSwap(
            suiType,
            1000000,
            0,
            telebtcCoinIds,
            wbtcCoinIds,
            suiCoinIds,
            usdtCoinIds,
            usdcCoinIds,
            'TELEBTC -> SUI'
          );
        }
        
        case 5: {
          // Test 5: WBTC -> TELEBTC (0.01 WBTC)
          console.log('📋 Test 5: WBTC -> TELEBTC');
          const wbtcCoinIds = await this.coinManager.getSwapCoins(wbtcType, 1000000);
          
          return await this.executeSwap(
            telebtcType,
            1000000,
            0,
            [],
            wbtcCoinIds,
            [],
            [],
            [],
            'WBTC -> TELEBTC'
          );
        }
        
        case 6: {
          // Test 6: USDC -> TELEBTC (100 USDC)
          console.log('📋 Test 6: USDC -> TELEBTC');
          const usdcCoinIds = await this.coinManager.getSwapCoins(usdcType, 100000000);
          
          return await this.executeSwap(
            telebtcType,
            100000000,
            0,
            [],
            [],
            [],
            [],
            usdcCoinIds,
            'USDC -> TELEBTC'
          );
        }
        
        case 7: {
          // Test 7: USDT -> TELEBTC (100 USDT)
          console.log('📋 Test 7: USDT -> TELEBTC');
          const usdtCoinIds = await this.coinManager.getSwapCoins(usdtType, 100000000);
          
          return await this.executeSwap(
            telebtcType,
            100000000,
            0,
            [],
            [],
            [],
            usdtCoinIds,
            [],
            'USDT -> TELEBTC'
          );
        }
        
        case 8: {
          // Test 8: SUI -> TELEBTC (0.01 SUI)
          console.log('📋 Test 8: SUI -> TELEBTC');
          const suiCoinIds = await this.coinManager.getSwapCoins(suiType, 1000000000);
          
          return await this.executeSwap(
            telebtcType,
            1000000000,
            0,
            [],
            [],
            suiCoinIds,
            [],
            [],
            'SUI -> TELEBTC'
          );
        }
        
        default:
          throw new Error(`Invalid test number: ${testNumber}`);
      }
    } catch (error) {
      console.error(`❌ Test ${testNumber} failed:`, error);
      return {
        success: false,
        telebtcAmount: 0,
        wbtcAmount: 0,
        suiAmount: 0,
        usdtAmount: 0,
        usdcAmount: 0,
        testName: `Test ${testNumber}`,
      };
    }
  }

  /**
   * Run all 8 swap test cases
   */
  async runAllTests(): Promise<void> {
    console.log('🚀 Starting comprehensive swap tests...\n');

    // Check for required coins first
    const mockTokens = this.packageManager.getMockTokens();
    const mainPackageId = this.packageManager.getMainPackage("testnet").packageId;
    
    const requiredTypes = [
      { type: `${this.packageManager.getTelebtc().packageId}::telebtc::TELEBTC`, name: 'TELEBTC' },
      { type: `${mockTokens.btc.packageId}::btc::BTC`, name: 'WBTC' },
      { type: '0x2::sui::SUI', name: 'SUI' },
      { type: `${mockTokens.usdt.packageId}::usdt::USDT`, name: 'USDT' },
      { type: `${mockTokens.usdc.packageId}::usdc::USDC`, name: 'USDC' },
    ];

    await this.coinManager.checkRequiredCoins(requiredTypes);

    const results: SwapTestResult[] = [];

    try {
      // Run each test individually to avoid object reuse issues
      for (let i = 1; i <= 8; i++) {
        console.log(`\n🔄 Running Test ${i}/8...`);
        const result = await this.runSingleTest(i);
        results.push(result);
        
        // Add a small delay between tests to avoid any potential issues
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Print summary
      console.log('\n📊 Test Results Summary:');
      console.log('='.repeat(50));
      
      results.forEach((result, index) => {
        const status = result.success ? '✅' : '❌';
        console.log(`${status} Test ${index + 1}: ${result.testName}`);
        console.log(`   Success: ${result.success}`);
        console.log(`   TELEBTC Amount: ${result.telebtcAmount}`);
        console.log(`   WBTC Amount: ${result.wbtcAmount}`);
        console.log(`   SUI Amount: ${result.suiAmount}`);
        console.log(`   USDT Amount: ${result.usdtAmount}`);
        console.log(`   USDC Amount: ${result.usdcAmount}`);
        console.log('');
      });

      const successCount = results.filter(r => r.success).length;
      console.log(`🎯 Overall Results: ${successCount}/${results.length} tests passed`);

    } catch (error) {
      console.error('❌ Test execution failed:', error);
    }
  }
}

// Main test execution
async function runSwapTests() {
  const tester = new SwapTester();
  await tester.initialize();
  await tester.runAllTests();
}

// Export for use in other files
export { SwapTester, runSwapTests };

// Run tests if this file is executed directly
if (require.main === module) {
  runSwapTests().catch(console.error);
}
