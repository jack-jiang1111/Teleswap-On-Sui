import { SuiClient, SuiHTTPTransport } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import CetusClmmSDK, { TickMath, initCetusSDK, d } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Ed25519Keypair as SuiEd25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 as suiFromB64 } from '@mysten/sui/utils';
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

// Cetus SDK will manage protocol addresses internally via env

// Coin type definitions (will be set from PackageManager)
const COIN_TYPES = {
  SUI: '0x2::sui::SUI',
  USDC: '', // Will be set from PackageManager
  USDT: '', // Will be set from PackageManager
  BTC: '',  // Will be set from PackageManager
  TELEBTC: '', // Will be set from PackageManager
};

// Global toggles for creating individual pools
// Set to false to skip creating that specific pool
export const CREATE_USDC_SUI = false;
export const CREATE_USDC_USDT = false;
export const CREATE_USDC_BTC = false;
export const CREATE_TELEBTC_BTC = true;

function isPoolEnabled(name: string): boolean {
  if (name === 'USDC-SUI') return CREATE_USDC_SUI;
  if (name === 'USDC-USDT') return CREATE_USDC_USDT;
  if (name === 'USDC-BTC') return CREATE_USDC_BTC;
  if (name === 'TELEBTC-BTC') return CREATE_TELEBTC_BTC;
  return true;
}

// Pool configurations
const POOL_CONFIGS: PoolConfig[] = [
  {
    name: 'USDC-SUI',
    coinTypeA: '',
    coinTypeB: '',
    amountA: 10000 * 10**6, // 10,000 USDC (6 decimals)
    amountB: 1 * 10**9,     // 1 SUI (9 decimals)
    tickSpacing: 60,
    initialPrice: 0.0001, // 1 SUI = 10,000 USDC
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
    initialPrice: 0.0001, // 1 BTC = 10,000 USDC
  },
  {
    name: 'BTC-TELEBTC',
    coinTypeA: '',
    coinTypeB: '',
    amountA: 1 * 10**8, // 1 BTC (8 decimals)
    amountB: 1 * 10**8, // 1 TELEBTC (8 decimals)
    tickSpacing: 60,
    initialPrice: 1, // 1 BTC = 1 TELEBTC
  },
];
// usdc-sui pool: 0xe5f548d7dd8773f30a47900e26528e560ef2f151f174e520fc959ceeb811497c
// usdc-btc pool: 0xb1f4b000841cdad8739451cb736b021896ebd231303910c3a6e001f6ff219c62
// usdc-usdt pool: 0xf4efd39be47788fd7155ba9725a4def85a6d5e2a334ed2b3ebbb1e57cb4c5b28
// btc-telebtc pool: 0xfe30f04c850ba333dc263f10d3637d79d6b467d34c90fc90899b772f69e29198
async function main() {
  const override = process.argv.includes('--override');
  const networkName = 'testnet';
  const network = getNetwork(networkName);
  
  const transport = new SuiHTTPTransport({
    url: network.url,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetchWithTimeout(input, init || {}, 120_000),
  });

  const client = new SuiClient({ transport });
  const keypair = await getActiveKeypair();
  const activeAddress = keypair.toSuiAddress();
  const sdkSigner = await getSdkCompatibleKeypair(activeAddress);

  console.log('Creating Cetus pools...');
  console.log('Active Address:', activeAddress);
  console.log('Network:', network.name);
  console.log('Override:', override);

  // Load package IDs using PackageManager
  const packageManager = new PackageManager();
  const mockTokens = packageManager.getMockTokens();
  
  // Set coin types
  COIN_TYPES.USDC = `${mockTokens.usdc.packageId}::usdc::USDC`;
  COIN_TYPES.USDT = `${mockTokens.usdt.packageId}::usdt::USDT`;
  COIN_TYPES.BTC = `${mockTokens.btc.packageId}::btc::BTC`;
  COIN_TYPES.TELEBTC = `${packageManager.getTelebtc().packageId}::telebtc::TELEBTC`;

  console.log('Coin Types:');
  console.log('- SUI:', COIN_TYPES.SUI);
  console.log('- USDC:', COIN_TYPES.USDC);
  console.log('- USDT:', COIN_TYPES.USDT);
  console.log('- BTC:', COIN_TYPES.BTC);
  console.log('- TELEBTC:', COIN_TYPES.TELEBTC);

  // Helper to sum balance for a coin type
  const getBalance = async (coinType: string): Promise<bigint> => {
    const res = await client.getCoins({ owner: activeAddress, coinType });
    return res.data.reduce((acc, c) => acc + BigInt(c.balance), BigInt(0));
  };

  // Query and print balances only for the listed coin types
  for (const [symbol, type] of Object.entries(COIN_TYPES)) {
    if (!type.includes('::')) {
      console.log(`${symbol}: (coin type missing)`);
      continue;
    }
    try {
      const bal = await getBalance(type);
      console.log(`${symbol} (${type}) balance: ${bal.toString()}`);
    } catch (e) {
      console.log(`${symbol} (${type}): error ->`, (e as Error).message);
    }
  }

  // Update pool configurations with actual coin types
  POOL_CONFIGS[0].coinTypeA = COIN_TYPES.USDC;
  POOL_CONFIGS[0].coinTypeB = COIN_TYPES.SUI;
  POOL_CONFIGS[1].coinTypeA = COIN_TYPES.USDC;
  POOL_CONFIGS[1].coinTypeB = COIN_TYPES.USDT;
  POOL_CONFIGS[2].coinTypeA = COIN_TYPES.USDC;
  POOL_CONFIGS[2].coinTypeB = COIN_TYPES.BTC;
  POOL_CONFIGS[3].coinTypeA = COIN_TYPES.BTC;
  POOL_CONFIGS[3].coinTypeB = COIN_TYPES.TELEBTC;

  // Initialize Cetus SDK
  const sdk = initCetusSDK({ network: 'testnet', fullNodeUrl: network.url, wallet: activeAddress });

  // Use PackageManager to read/write persisted pool IDs (flat map, no per-network)

  // Create pools via Cetus SDK
  for (const poolConfig of POOL_CONFIGS) {
    console.log(`\nCreating pool: ${poolConfig.name}`);

    try {
      if (!isPoolEnabled(poolConfig.name)) {
        console.log(`ℹ️  Pool ${poolConfig.name} disabled via toggle. Skipping.`);
        continue;
      }
      // Skip if saved and not overriding
      const savedId = packageManager.getCetusPool(poolConfig.name);
      if (savedId && !override) {
        console.log(`ℹ️  Found saved pool for ${poolConfig.name}: ${savedId}. Skipping (use --override to recreate).`);
        continue;
      }

      // Ensure balances exist (simple guard to avoid failed txs)
      const coinsA = await getCoins(client, activeAddress, poolConfig.coinTypeA, poolConfig.amountA);
      const coinsB = await getCoins(client, activeAddress, poolConfig.coinTypeB, poolConfig.amountB);
      if (coinsA.length === 0 || coinsB.length === 0) {
        console.log(`❌ Missing required liquidity assets for ${poolConfig.name}.`);
        continue;
      }

      // Respect config order: front is A, later is B
      const coin_type_a = poolConfig.coinTypeA;
      const coin_type_b = poolConfig.coinTypeB;
      const metadata_a = await fetchCoinMetadataId(client, coin_type_a);
      const metadata_b = await fetchCoinMetadataId(client, coin_type_b);
      const amount_a = poolConfig.amountA;
      const amount_b = poolConfig.amountB;
      const coin_decimals_a = getDecimals(coin_type_a);
      const coin_decimals_b = getDecimals(coin_type_b);

      const tick_spacing = poolConfig.tickSpacing;
      // POOL_CONFIGS initialPrice semantics: 1 coin B = initialPrice coin A
      // TickMath expects price as coin_a/coin_b (coin A per coin B)
      const price_a_over_b = poolConfig.initialPrice;
      const sqrt_price_bn = TickMath.priceToSqrtPriceX64(
        d(String(price_a_over_b)),
        coin_decimals_a,
        coin_decimals_b
      );

      // Build initial tick range around current price
      const current_tick_index = TickMath.sqrtPriceX64ToTickIndex(sqrt_price_bn);
      const tick_lower = TickMath.getPrevInitializableTickIndex(current_tick_index, tick_spacing);
      const tick_upper = TickMath.getNextInitializableTickIndex(current_tick_index, tick_spacing);

      const tx = await sdk.Pool.createPoolTransactionPayload({
        coinTypeA: coin_type_a,
        coinTypeB: coin_type_b,
        tick_spacing,
        initialize_sqrt_price: sqrt_price_bn.toString(),
        uri: '',
        amount_a,
        amount_b,
        fix_amount_a: true,
        tick_lower,
        tick_upper,
        metadata_a: metadata_a,
        metadata_b: metadata_b,
        slippage: 0.05,
      });

      const result = await sdk.fullClient.sendTransaction(sdkSigner, tx);

      const status = (result as any)?.effects?.status?.status;
      if (status !== 'success') {
        console.error(`❌ Failed to create pool ${poolConfig.name}:`, (result as any)?.effects);
        continue;
      }

      console.log(`✅ Pool ${poolConfig.name} created successfully!`);
      console.log(`Transaction Digest: ${(result as any).digest}`);

      // Extract created pool ID and persist to package_id.json
      let poolId = '';
      for (const obj of (result as any).effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';
        if (type.includes('pool::Pool')) {
          poolId = objectId;
          console.log('poolId:', poolId);
          break;
        }
      }
      if (poolId!="") {
        packageManager.setCetusPool(poolConfig.name, poolId);
        packageManager.save();
        console.log(`Saved ${poolConfig.name} pool ID: ${poolId}`);
      } else {
        console.log('⚠️  Could not detect created Pool object in objectChanges.');
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

// Helpers
async function fetchCoinMetadataId(client: SuiClient, coinType: string): Promise<string> {
  // Try on-chain metadata first
  try {
    const meta = await client.getCoinMetadata({ coinType });
    if (meta && meta.id) return meta.id as string;
  } catch (_) {}

  // Fallback to local package_id.json via PackageManager if on-chain metadata is missing
  const pm = new PackageManager();
  const mock = pm.getMockTokens();
  const telebtc = pm.getTelebtc();

  if (coinType.includes('::btc::BTC') && mock.btc?.metadataId) return mock.btc.metadataId;
  if (coinType.includes('::usdc::USDC') && mock.usdc?.metadataId) return mock.usdc.metadataId;
  if (coinType.includes('::usdt::USDT') && mock.usdt?.metadataId) return mock.usdt.metadataId;
  if (coinType.includes('::telebtc::TELEBTC') && telebtc?.metadataId) return telebtc.metadataId;

  throw new Error(`No metadata found for ${coinType}`);
}

async function getSdkCompatibleKeypair(activeAddress: string): Promise<SuiEd25519Keypair> {
  const userHome = process.env.HOME || process.env.USERPROFILE || '';
  const keystorePath = path.join(userHome, '.sui/sui_config/sui.keystore');
  const keystore = JSON.parse(fs.readFileSync(keystorePath, 'utf8')) as string[];
  for (const key of keystore) {
    const privateKeyBytes = suiFromB64(key);
    if (!privateKeyBytes || privateKeyBytes.length < 33) continue;
    try {
      const kp = SuiEd25519Keypair.fromSecretKey(privateKeyBytes.slice(1, 33));
      if (kp.toSuiAddress() === activeAddress) return kp;
    } catch (_) {}
  }
  throw new Error('Failed to build SDK compatible keypair from keystore');
}

function loadPackageJson(filePath: string): any {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {} as any;
  }
}

function savePackageJson(filePath: string, data: any) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(filePath, serialized, 'utf8');
}

function getDecimals(coinType: string): number {
  if (coinType.endsWith('::sui::SUI')) return 9;
  if (coinType.includes('::usdc::USDC')) return 6;
  if (coinType.includes('::usdt::USDT')) return 6;
  if (coinType.includes('::btc::BTC')) return 8;
  if (coinType.includes('::telebtc::TELEBTC')) return 8;
  // Fallback
  return 9;
}
