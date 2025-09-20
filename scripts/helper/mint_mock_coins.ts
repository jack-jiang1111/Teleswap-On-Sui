import { SuiClient, SuiHTTPTransport } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { getNetwork } from './config';
import { getActiveKeypair } from './sui.utils';

async function main() {
    const networkName = process.argv[2] || 'testnet';
    const network = getNetwork(networkName);
    const transport = new SuiHTTPTransport({
        url: network.url,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fetchWithTimeout(input, init || {}, 120_000),
    });
  
    const client = new SuiClient({ transport });
    const keypair = await getActiveKeypair();
    const activeAddress = keypair.toSuiAddress();
    const receiveAddress = "0xe5a7c377bb13572959b1dc7589e0abd951a89ca7ba9f2ed9167ba4e290ea8ad5";

  

    function fetchWithTimeout(url: RequestInfo | URL, options: RequestInit = {}, timeout = 120_000): Promise<Response> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        return fetch(url as any, { ...options, signal: controller.signal })
            .finally(() => clearTimeout(id));
    }

  

  // Load package IDs and treasury cap IDs from package_id.json
  const packageIds = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package_id.json'), 'utf8'));
  const mockBtcPackageId = packageIds.mockBtcPackageId;
  const mockUsdtPackageId = packageIds.mockUsdtPackageId;
  const mockUsdcPackageId = packageIds.mockUsdcPackageId;
  const mockBtcTreasuryCapId = packageIds.mockBtcTreasuryCapId;
  const mockUsdtTreasuryCapId = packageIds.mockUsdtTreasuryCapId;
  const mockUsdcTreasuryCapId = packageIds.mockUsdcTreasuryCapId;

  if (!mockBtcPackageId) throw new Error('mockBtcPackageId not found in package_id.json');
  if (!mockUsdtPackageId) throw new Error('mockUsdtPackageId not found in package_id.json');
  if (!mockUsdcPackageId) throw new Error('mockUsdcPackageId not found in package_id.json');
  if (!mockBtcTreasuryCapId) throw new Error('mockBtcTreasuryCapId not found in package_id.json. Please run the mock token deployment script first.');
  if (!mockUsdtTreasuryCapId) throw new Error('mockUsdtTreasuryCapId not found in package_id.json. Please run the mock token deployment script first.');
  if (!mockUsdcTreasuryCapId) throw new Error('mockUsdcTreasuryCapId not found in package_id.json. Please run the mock token deployment script first.');

  console.log('Minting mock coins...');
  console.log('Active Address:', activeAddress);
  console.log('Receive Address:', receiveAddress);
  console.log('BTC Package ID:', mockBtcPackageId);
  console.log('USDT Package ID:', mockUsdtPackageId);
  console.log('USDC Package ID:', mockUsdcPackageId);

  // Default amounts (in smallest units)
  const btcAmount = 1 * 10**8; // 1 BTC (8 decimals)
  const usdtAmount = 10000 * 10**6; // 10000 USDT (6 decimals)
  const usdcAmount = 10000 * 10**6; // 10000 USDC (6 decimals)

  const tx = new TransactionBlock();
  tx.setGasBudget(100000000);

  // Mint BTC
  const btcCoin = tx.moveCall({
    target: `${mockBtcPackageId}::btc::mint`,
    arguments: [
      tx.object(mockBtcTreasuryCapId),
      tx.pure(btcAmount)
    ]
  });

  // Mint USDT
  const usdtCoin = tx.moveCall({
    target: `${mockUsdtPackageId}::usdt::mint`,
    arguments: [
      tx.object(mockUsdtTreasuryCapId),
      tx.pure(usdtAmount)
    ]
  });

  // Mint USDC
  const usdcCoin = tx.moveCall({
    target: `${mockUsdcPackageId}::usdc::mint`,
    arguments: [
      tx.object(mockUsdcTreasuryCapId),
      tx.pure(usdcAmount)
    ]
  });

  // Transfer coins if receive address is different from active address
  if (receiveAddress !== activeAddress) {
    console.log('Transferring coins to receive address...');
    tx.transferObjects([btcCoin, usdtCoin, usdcCoin], tx.pure(receiveAddress));
  } else {
    console.log('Receive address same as active address, keeping coins...');
    tx.transferObjects([btcCoin, usdtCoin, usdcCoin], tx.pure(activeAddress));
  }

  const result = await client.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    signer: keypair,
    options: {
      showEffects: true,
    }
  });

  if (result.effects?.status?.status !== 'success') {
    console.error('Transaction failed:', result.effects);
    throw new Error('Transaction failed');
  }

  console.log('✅ Successfully minted and transferred mock coins!');
  console.log('Transaction Digest:', result.digest);
  console.log('Minted amounts:');
  console.log(`- BTC: ${btcAmount / 10**8} (${btcAmount} smallest units)`);
  console.log(`- USDT: ${usdtAmount / 10**6} (${usdtAmount} smallest units)`);
  console.log(`- USDC: ${usdcAmount / 10**6} (${usdcAmount} smallest units)`);
}

main().catch((e) => { 
  console.error('Error:', e); 
  process.exit(1); 
});
