import { SuiClient, SuiHTTPTransport } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { PackageManager } from '../helper/package_manager';

// Pool configuration
interface PoolConfig {
  name: string;
  coinTypeA: string;
  coinTypeB: string;
  amountA: number;
  amountB: number;
  tickSpacing: number;
  initialPrice: number;
}

// Cetus Protocol addresses (testnet)
const CETUS_PROTOCOL = {
  CLMM_POOL: '0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018',
  CLMM_FACTORY: '0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018',
  CLMM_ROUTER: '0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018',
  CETUS_CLMM: '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12',
};

// Coin type definitions (will be set from PackageManager)
const COIN_TYPES = {
  SUI: '0x2::sui::SUI',
  USDC: '', // Will be set from PackageManager
  USDT: '', // Will be set from PackageManager
  BTC: '',  // Will be set from PackageManager
  TELEBTC: '', // Will be set from PackageManager
};

// Pool configurations
const POOL_CONFIGS: PoolConfig[] = [
  {
    name: 'USDC-SUI',
    coinTypeA: '',
    coinTypeB: '',
    amountA: 10000 * 10**6, // 10,000 USDC (6 decimals)
    amountB: 1 * 10**9,     // 1 SUI (9 decimals)
    tickSpacing: 60,
    initialPrice: 10000, // 1 SUI = 10,000 USDC
  },
  {
    name: 'USDC-USDT',
    coinTypeA: '',
    coinTypeB: '',
    amountA: 10000 * 10**6, // 10,000 USDC (6 decimals)
    amountB: 10000 * 10**6, // 10,000 USDT (6 decimals)
    tickSpacing: 60,
    initialPrice: 1, // 1 USDC = 1 USDT
  },
  {
    name: 'USDC-BTC',
    coinTypeA: '',
    coinTypeB: '',
    amountA: 10000 * 10**6, // 10,000 USDC (6 decimals)
    amountB: 1 * 10**8,     // 1 BTC (8 decimals)
    tickSpacing: 60,
    initialPrice: 10000, // 1 BTC = 10,000 USDC
  },
  {
    name: 'TELEBTC-BTC',
    coinTypeA: '',
    coinTypeB: '',
    amountA: 1 * 10**8, // 1 TELEBTC (8 decimals)
    amountB: 1 * 10**8, // 1 BTC (8 decimals)
    tickSpacing: 60,
    initialPrice: 1, // 1 TELEBTC = 1 BTC
  },
];

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

  console.log('Creating Cetus pools...');
  console.log('Active Address:', activeAddress);
  console.log('Network:', network.name);

  // Load package IDs using PackageManager
  const packageManager = new PackageManager();
  const mockTokens = packageManager.getMockTokens();
  const telebtc = packageManager.getTelebtc();
  
  // Set coin types
  COIN_TYPES.USDC = `${mockTokens.usdc.packageId}::usdc::USDC`;
  COIN_TYPES.USDT = `${mockTokens.usdt.packageId}::usdt::USDT`;
  COIN_TYPES.BTC = `${mockTokens.btc.packageId}::btc::BTC`;
  COIN_TYPES.TELEBTC = `${telebtc.adminId}::telebtc::TELEBTC`;

  console.log('Coin Types:');
  console.log('- SUI:', COIN_TYPES.SUI);
  console.log('- USDC:', COIN_TYPES.USDC);
  console.log('- USDT:', COIN_TYPES.USDT);
  console.log('- BTC:', COIN_TYPES.BTC);
  console.log('- TELEBTC:', COIN_TYPES.TELEBTC);

  // Update pool configurations with actual coin types
  POOL_CONFIGS[0].coinTypeA = COIN_TYPES.USDC;
  POOL_CONFIGS[0].coinTypeB = COIN_TYPES.SUI;
  POOL_CONFIGS[1].coinTypeA = COIN_TYPES.USDC;
  POOL_CONFIGS[1].coinTypeB = COIN_TYPES.USDT;
  POOL_CONFIGS[2].coinTypeA = COIN_TYPES.USDC;
  POOL_CONFIGS[2].coinTypeB = COIN_TYPES.BTC;
  POOL_CONFIGS[3].coinTypeA = COIN_TYPES.TELEBTC;
  POOL_CONFIGS[3].coinTypeB = COIN_TYPES.BTC;

  // Create pools
  for (const poolConfig of POOL_CONFIGS) {
    console.log(`\nCreating pool: ${poolConfig.name}`);
    
    try {
      // Get coins for the pool
      const coinsA = await getCoins(client, activeAddress, poolConfig.coinTypeA, poolConfig.amountA);
      const coinsB = await getCoins(client, activeAddress, poolConfig.coinTypeB, poolConfig.amountB);

      if (coinsA.length === 0) {
        console.log(`❌ No ${poolConfig.coinTypeA} coins found. Please mint some first.`);
        continue;
      }
      if (coinsB.length === 0) {
        console.log(`❌ No ${poolConfig.coinTypeB} coins found. Please mint some first.`);
        continue;
      }

      // Create the pool using TransactionBlock
      const tx = new TransactionBlock();
      tx.setGasBudget(100000000);

      // Create pool
      const createPoolResult = tx.moveCall({
        target: `${CETUS_PROTOCOL.CLMM_FACTORY}::pool::create_pool`,
        arguments: [
          tx.pure(poolConfig.coinTypeA),
          tx.pure(poolConfig.coinTypeB),
          tx.pure(poolConfig.tickSpacing),
          tx.pure(Math.sqrt(poolConfig.initialPrice)),
        ],
      });

      // Add initial liquidity
      const addLiquidityResult = tx.moveCall({
        target: `${CETUS_PROTOCOL.CLMM_POOL}::position::mint`,
        arguments: [
          createPoolResult,
          tx.object(coinsA[0].objectId),
          tx.object(coinsB[0].objectId),
          tx.pure(poolConfig.amountA),
          tx.pure(poolConfig.amountB),
          tx.pure(0), // min_amount_a
          tx.pure(0), // min_amount_b
        ],
      });

      // Transfer the position NFT to the user
      tx.transferObjects([addLiquidityResult], tx.pure(activeAddress));

      const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: keypair,
        options: {
          showEffects: true,
          showObjectChanges: true,
        }
      });

      if (result.effects?.status?.status !== 'success') {
        console.error(`❌ Failed to create pool ${poolConfig.name}:`, result.effects);
        continue;
      }

      console.log(`✅ Pool ${poolConfig.name} created successfully!`);
      console.log(`Transaction Digest: ${result.digest}`);

      // Find the created pool ID from object changes
      const poolChange = result.objectChanges?.find(
        (change: any) => change.type === 'created' && change.objectType?.includes('Pool')
      );
      const poolId = poolChange && 'objectId' in poolChange ? (poolChange as any).objectId : null;

      if (poolId) {
        console.log(`Pool ID: ${poolId}`);
      }

    } catch (error) {
      console.error(`❌ Failed to create pool ${poolConfig.name}:`, error);
    }
  }

  console.log('\n🎉 Pool creation process completed!');
}

async function getCoins(client: SuiClient, owner: string, coinType: string, minAmount: number) {
  const { data: coinObjects } = await client.getOwnedObjects({
    owner,
    filter: { MatchAll: [{ StructType: `0x2::coin::Coin<${coinType}>` }] },
    options: { showContent: true, showType: true }
  });

  const coins = [];
  let totalAmount = 0;

  for (const obj of coinObjects) {
    const content = obj.data?.content;
    if (content && 'fields' in content) {
      const balance = parseInt((content as any).fields?.balance || '0');
      if (balance > 0) {
        coins.push({
          objectId: obj.data?.objectId ?? '',
          version: obj.data?.version ?? '',
          digest: obj.data?.digest ?? '',
          balance: balance
        });
        totalAmount += balance;
      }
    }
  }

  if (totalAmount < minAmount) {
    console.log(`⚠️  Insufficient ${coinType} balance. Have: ${totalAmount}, Need: ${minAmount}`);
    return [];
  }

  return coins;
}

function fetchWithTimeout(url: RequestInfo | URL, options: RequestInit = {}, timeout = 120_000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url as any, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

main().catch((e) => { 
  console.error('Error:', e); 
  process.exit(1); 
});
