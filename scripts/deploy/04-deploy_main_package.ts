import { SuiClient, SuiHTTPTransport } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';

async function main() {
  const networkName = process.argv[2];
  const network = getNetwork(networkName);
  if (network.name !== 'testnet' && network.name !== 'mainnet') {
    throw new Error('Network must be testnet or mainnet');
  }

  function fetchWithTimeout(url: RequestInfo | URL, options: RequestInit = {}, timeout = 120_000): Promise<Response> { // 120 seconds
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(url as any, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(id));
  }

  const transport = new SuiHTTPTransport({
      url: network.url,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetchWithTimeout(input, init || {}, 120_000), // 2 minutes
  });

  const client = new SuiClient({ transport });

  const keypair = await getActiveKeypair();
  const activeAddress = keypair.toSuiAddress();

  // Select package dir
  const pkgDir = path.join(
    __dirname,
    network.name === 'testnet' ? '../../teleswap-testnet' : '../../teleswap-mainnet'
  );

  console.log(`Building package at ${pkgDir} ...`);
  execSync('sui move build', { cwd: pkgDir, stdio: 'inherit' });

  // Load modules from build output
  const bytecodeDir = await findBytecodeModulesDir(pkgDir);
  const modules = fs.readdirSync(bytecodeDir)
    .filter((f) => f.endsWith('.mv'))
    .sort()
    .map((f) => Array.from(fs.readFileSync(path.join(bytecodeDir, f))));

  const gasCoins = await getGasCoins(client, activeAddress);

  console.log('Publishing main package ...');
  const tx = new TransactionBlock();
  tx.setGasBudget(500000000);
  tx.setGasPayment(gasCoins);
  
  // Load btcrelay package ID from package_id.json
  const packageIds = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package_id.json'), 'utf8'));
  const btcrelayPackageId = packageIds.btcrelayPackageId;
  const mockUsdtPackageId = packageIds.mockUsdtPackageId;
  const mockBtcPackageId = packageIds.mockBtcPackageId;
  const mockUsdcPackageId = packageIds.mockUsdcPackageId;
  if (!btcrelayPackageId) throw new Error('btcrelayPackageId not found in package_id.json');
  if (!mockUsdtPackageId) throw new Error('mockUsdtPackageId not found in package_id.json');
  if (!mockBtcPackageId) throw new Error('mockBtcPackageId not found in package_id.json');
  if (!mockUsdcPackageId) throw new Error('mockUsdcPackageId not found in package_id.json');
  // Core dependencies that are always available
  const dependencies = [
    '0x1', // MoveStdlib
    '0x2', // Sui Framework
    '0x3', // Sui System
    btcrelayPackageId, // Your deployed btcrelay package
  ];

  // Add network-specific dependencies provided in instructions
  const optionalDependencies = network.name === 'mainnet'
    ? [
      // mainnet addresses from instructions
      '0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40', // CetusClmm mainnet
      '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7', // USDC mainnet
      '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068', // USDT mainnet
      '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881', // WBTC mainnet
    ]
    : [
      // testnet addresses from instructions (Cetus testnet provided)
      '0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018', // CetusClmm testnet
      mockUsdtPackageId, // USDT testnet
      mockBtcPackageId, // BTC testnet
      mockUsdcPackageId, // USDC testnet
    ];

  // Try to verify each optional dependency exists before adding
  for (const dep of optionalDependencies) {
    try {
      //await client.getObject({ id: dep, options: { showType: true } });
      dependencies.push(dep);
      console.log(`Added dependency: ${dep}`);
    } catch (e) {
      console.log(`Skipping dependency ${dep} (not found on-chain)`);
    }
  }

  const [upgradeCap] = tx.publish({
    modules,
    dependencies,
  });
  tx.transferObjects([upgradeCap], tx.pure(activeAddress));

  const result = await client.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    signer: keypair,
  });

  

  let mainPackageId = '';
  let burnRouterAdminId = '';
  let exchangeAdminId = '';
  let ccTransferAdminId = '';
  let lockerAdminCapId = '';
  let telebtcAdminId = '';
  let telebtcCapId = '';
  let telebtcTreasuryCapId = '';

  if(result.effects?.status?.status !== 'success') {
    console.log(result.effects);
    throw new Error('Transaction failed');
  }
  for (const obj of result.effects?.created || []) {
    const objectId = obj.reference.objectId;
    // package id by owner=Immutable
    if (obj.owner === 'Immutable') {
      mainPackageId = objectId;
      continue;
    }
    // inspect type
    try {
      const info = await client.getObject({ id: objectId, options: { showType: true } });
      const type = info.data?.type || '';
      if (!type) continue;
      if (type.includes('BURN_ROUTER_ADMIN')) burnRouterAdminId = objectId;
      else if (type.includes('ExchangeAdmin')) exchangeAdminId = objectId;
      else if (type.includes('CC_TRANSFER_ADMIN')) ccTransferAdminId = objectId;
      else if (type.includes('LockerAdminCap')) lockerAdminCapId = objectId;
      else if (type.includes('TELEBTC_ADMIN')) telebtcAdminId = objectId;
      else if (type.includes('TeleBTCCap')) telebtcCapId = objectId;
      else if (type.includes('TreasuryCap') && type.includes('telebtc::TELEBTC')) telebtcTreasuryCapId = objectId;
    } catch {}
  }

  if (!mainPackageId) throw new Error('Failed to determine main packageId');

  console.log('mainPackageId:', mainPackageId);
  if (burnRouterAdminId) console.log('burnRouterAdminId:', burnRouterAdminId); else throw new Error('Missing BURN_ROUTER_ADMIN');
  if (exchangeAdminId) console.log('exchangeAdminId:', exchangeAdminId); else throw new Error('Missing ExchangeAdmin');
  if (ccTransferAdminId) console.log('ccTransferAdminId:', ccTransferAdminId); else throw new Error('Missing CC_TRANSFER_ADMIN');
  if (lockerAdminCapId) console.log('lockerAdminCapId:', lockerAdminCapId); else throw new Error('Missing LockerAdminCap');
  if (telebtcAdminId) console.log('telebtcAdminId:', telebtcAdminId); else throw new Error('Missing TELEBTC_ADMIN');
  if (telebtcCapId) console.log('telebtcCapId:', telebtcCapId); else throw new Error('Missing TeleBTCCap');
  if (telebtcTreasuryCapId) console.log('telebtcTreasuryCapId:', telebtcTreasuryCapId); else throw new Error('Missing TreasuryCap<TELEBTC>');

  // Append/overwrite to package_id.json in main directory
  const outPath = path.join(__dirname, '../../package_id.json');
  let current: any = {};
  if (fs.existsSync(outPath)) {
    try { current = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  }
  if (network.name === 'testnet') {
    current.mainTestnetPackageId = mainPackageId;
  } else {
    current.mainMainnetPackageId = mainPackageId;
  }
  // common keys captured regardless of network
  current.burnRouterAdminId = burnRouterAdminId || current.burnRouterAdminId;
  current.exchangeAdminId = exchangeAdminId || current.exchangeAdminId;
  current.ccTransferAdminId = ccTransferAdminId || current.ccTransferAdminId;
  current.lockerAdminCapId = lockerAdminCapId || current.lockerAdminCapId;
  current.telebtcAdminId = telebtcAdminId || current.telebtcAdminId;
  current.telebtcCapId = telebtcCapId || current.telebtcCapId;
  current.telebtcTreasuryCapId = telebtcTreasuryCapId || current.telebtcTreasuryCapId;

  fs.writeFileSync(outPath, JSON.stringify(current, null, 2));

  console.log('Main package published and IDs recorded.');
}

async function getGasCoins(client: SuiClient, owner: string) {
  const { data: gasObjects } = await client.getOwnedObjects({
    owner,
    filter: { MatchAll: [{ StructType: '0x2::coin::Coin<0x2::sui::SUI>' }] },
    options: { showContent: true, showType: true }
  });
  if (!gasObjects.length) throw new Error('No gas coins available');
  return gasObjects.map(obj => ({
    objectId: obj.data?.objectId ?? '',
    version: obj.data?.version ?? '',
    digest: obj.data?.digest ?? ''
  }));
}

async function findBytecodeModulesDir(pkgDir: string): Promise<string> {
  const buildDir = path.join(pkgDir, 'build');
  const subdirs = fs.readdirSync(buildDir).filter((f) => fs.statSync(path.join(buildDir, f)).isDirectory());
  for (const sd of subdirs) {
    const candidate = path.join(buildDir, sd, 'bytecode_modules');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`bytecode_modules not found under ${buildDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
