import { PackageManager } from "../helper/package_manager";
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../helper/sui.utils';
import { getNetwork } from '../helper/config';

async function testQuote() {
  console.log('🚀 Testing getQuoteSellTelebtc function...\n');

  // Initialize client and keypair
  const network = getNetwork('testnet');
  const client = new SuiClient({ url: network.url });
  const keypair = await getActiveKeypair();
  const packageManager = new PackageManager();

  // Get package IDs
  const mainPackageId = packageManager.getMainPackage("testnet").packageId;
  const mockTokens = packageManager.getMockTokens();
  
  // Get pool IDs
  const pools = packageManager.getCetusPools();
  const poolUsdcSui = pools['USDC-SUI'];
  const poolUsdcUsdt = pools['USDC-USDT'];
  const poolUsdcWbtc = pools['USDC-BTC'];
  const poolTelebtcWbtc = pools['TELEBTC-BTC'];

  if (!poolUsdcSui || !poolUsdcUsdt || !poolUsdcWbtc || !poolTelebtcWbtc) {
    throw new Error('Pool IDs not found in package manager');
  }

  // Get config and clock objects
  const configId = "0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e";
  const clockId = "0x6";

  // Define target token (WBTC)
  const wbtcType = `${mockTokens.btc.packageId}::btc::BTC`;
  const wbtcTypeArg = `0x2::coin::Coin<${wbtcType}>`;

  console.log('📋 Test Parameters:');
  console.log(`- Target Token: WBTC (${wbtcType})`);
  console.log(`- Input Amount: 1000 (0.00001 TELEBTC)`);
  console.log(`- Min Output: 0`);
  console.log(`- Pool TELEBTC-WBTC: ${poolTelebtcWbtc}`);
  console.log(`- Pool USDC-WBTC: ${poolUsdcWbtc}`);
  console.log(`- Pool USDC-SUI: ${poolUsdcSui}`);
  console.log(`- Pool USDC-USDT: ${poolUsdcUsdt}\n`);

  const txb = new TransactionBlock();
  txb.setGasBudget(100000000);

  // Get pool objects
  const poolUsdcSuiObj = txb.object(poolUsdcSui);
  const poolUsdcUsdtObj = txb.object(poolUsdcUsdt);
  const poolUsdcWbtcObj = txb.object(poolUsdcWbtc);
  const poolTelebtcWbtcObj = txb.object(poolTelebtcWbtc);

  // Get config and clock objects
  const configObj = txb.object(configId);
  const clockObj = txb.object(clockId);

  // Call the quote function
  // Note: The function expects pools in this order:
  // 1. pool_usdc_sui: Pool<USDC, SUI>
  // 2. pool_usdc_usdt: Pool<USDC, USDT>  
  // 3. pool_usdc_wbtc: Pool<USDC, BTC>
  // 4. pool_telebtc_wbtc: Pool<BTC, TELEBTC> (reverse order for _rev function)
  const [success, wbtcResult] = txb.moveCall({
    target: `${mainPackageId}::dexconnector::getQuoteSellTelebtc_rev`,
    typeArguments: [wbtcTypeArg],
    arguments: [
      poolUsdcSuiObj,    // Pool<USDC, SUI>
      poolUsdcUsdtObj,   // Pool<USDC, USDT>
      poolUsdcWbtcObj,   // Pool<USDC, BTC>
      poolTelebtcWbtcObj, // Pool<TELEBTC, BTC>
      txb.pure.u64(10000), // input_amount
      txb.pure.u64(0),      // min_output_amount
    ],
  });


  try {
    console.log('🔄 Executing quote transaction...');
    const txResult = await client.devInspectTransactionBlock({
        transactionBlock: txb,
        sender: keypair.toSuiAddress(),
    });

    if (txResult?.effects?.status?.status === "success") {
      console.log(txResult.results?.[0]?.returnValues?.[0]?.[0]);
      console.log(txResult.results?.[0]?.returnValues?.[0]?.[1]);
      console.log('✅ Quote transaction successful!');
      console.log(`Transaction digest: ${txResult}`);
      
      // Parse the result (this is a simplified version - you'd need to parse the actual return values)
      console.log('\n📊 Quote Result:');
      console.log('- The function returned a tuple (bool, u64)');
      console.log('- First value: success flag (true/false)');
      console.log('- Second value: output amount in WBTC units');
      console.log('\nNote: To get the actual values, you would need to parse the transaction result');
      
    } else {
      console.log('❌ Quote transaction failed:');
      console.log(txResult?.effects?.status?.error);
    }

  } catch (error) {
    console.log('❌ Quote test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testQuote().catch(console.error);
}

export { testQuote };
