import { SuiClient, SuiHTTPTransport } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { PackageManager } from '../helper/package_manager';

async function main() {

  const networkName = process.argv[2];
  const network = getNetwork(networkName);

  // Select package dir
  const pkgDir = path.join(
    __dirname,
    (network.name === 'testnet' || network.name === 'devnet' ) ? '../../teleswap-testnet' : '../../teleswap-mainnet'
  );

  // run $sui client publish --dependencies-are-root in the terminal (under testnet or mainnet folder)
  // first delete the Move.lock file in either testnet or mainnet folder based on the input network
  console.log(`Deleting Move.lock file in ${pkgDir}...`);
  try {
    if (fs.existsSync(path.join(pkgDir, 'Move.lock'))) {
      fs.unlinkSync(path.join(pkgDir, 'Move.lock'));
    }
  } catch (error) {
    console.log('Move.lock file not found or already deleted');
  }

  // need to update the Move.toml file if using a btcrelay mock
  
  // then run the publish command and capture output
  console.log(`Publishing package in ${pkgDir}...`);
  let publishOutput = '';
  try {
    publishOutput = execSync('sui client publish --dependencies-are-root', { 
      cwd: pkgDir, 
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (error: any) {
    // Even if the command fails, we might still get useful output
    publishOutput = error.stdout || error.stderr || error.message || '';
    console.log('Publish command failed, but captured output:');
  }

  console.log('Publish Output:');
  console.log(publishOutput);

  // Parse the output to extract transaction digest
  const txDigest = parseTransactionDigest(publishOutput);
  if (!txDigest) {
    throw new Error('Failed to extract transaction digest from publish output');
  }
  console.log('Extracted transaction digest:', txDigest);

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

  console.log('Getting transaction details from digest...');
  
  // Get transaction details using the digest
  const result = await client.getTransactionBlock({
    digest: txDigest,
    options: {
      showEffects: true,
      showInput: true,
      showObjectChanges: true,
      showBalanceChanges: true
    }
  });
  await new Promise(resolve => setTimeout(resolve, 1500)); // wait for 1.5s to make sure the transaction is executed
  let mainPackageId = '';
  let burnRouterAdminId = '';
  let exchangeAdminId = '';
  let ccTransferAdminId = '';
  let lockerAdminCapId = '';
  let telebtcAdminId = '';
  let telebtcCapId = '';
  let telebtcTreasuryCapId = '';
  let telebtcMetadataId = '';
  let upgradeCapId = '';
  if(result.effects?.status?.status !== 'success') {
    console.log('Transaction failed:', result.effects);
    throw new Error('Transaction failed');
  }

  // Process created objects from the transaction
  for (const obj of result.effects?.created || []) {
    const objectId = obj.reference.objectId;
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
      else if (type.includes('UpgradeCap')) upgradeCapId = objectId;
      else if (type.includes('CoinMetadata')) telebtcMetadataId = objectId;
      else if (type === 'package') mainPackageId = objectId;
    } catch (error) {
      console.log(`Error getting object ${objectId}:`, error);
    }
  }

  if (!mainPackageId) throw new Error('Failed to determine main packageId');

  console.log('PackageId:', mainPackageId);
  if (burnRouterAdminId) console.log('burnRouterAdminId:', burnRouterAdminId); else throw new Error('Missing BURN_ROUTER_ADMIN');
  if (exchangeAdminId) console.log('exchangeAdminId:', exchangeAdminId); else throw new Error('Missing ExchangeAdmin');
  if (ccTransferAdminId) console.log('ccTransferAdminId:', ccTransferAdminId); else throw new Error('Missing CC_TRANSFER_ADMIN');
  if (lockerAdminCapId) console.log('lockerAdminCapId:', lockerAdminCapId); else throw new Error('Missing LockerAdminCap');
  if (telebtcAdminId) console.log('telebtcAdminId:', telebtcAdminId); else throw new Error('Missing TELEBTC_ADMIN');
  if (telebtcCapId) console.log('telebtcCapId:', telebtcCapId); else throw new Error('Missing TeleBTCCap');
  if (telebtcTreasuryCapId) console.log('telebtcTreasuryCapId:', telebtcTreasuryCapId); else throw new Error('Missing TreasuryCap<TELEBTC>');
  if (telebtcMetadataId) console.log('telebtcMetadataId:', telebtcMetadataId); else throw new Error('Missing CoinMetadata<TELEBTC>');
  if (upgradeCapId) console.log('upgradeCapId:', upgradeCapId); else throw new Error('Missing UpgradeCap');
  // Update package_id.json using PackageManager
  const packageManager = new PackageManager();
  
  // Set main package ID based on network
  const networkType = process.argv[2] === 'testnet' ? 'testnet' : 'mainnet';
  packageManager.setMainPackage(networkType, mainPackageId);
  
  // Set admin caps
  packageManager.setAdminCaps({
    burnRouterAdminId: burnRouterAdminId,
    exchangeAdminId: exchangeAdminId,
    ccTransferAdminId: ccTransferAdminId,
    lockerAdminCapId: lockerAdminCapId,
    upgradeCapId: upgradeCapId
  });
  
  // Set telebtc data
  packageManager.setTelebtc({
    packageId: mainPackageId,
    adminId: telebtcAdminId,
    capId: telebtcCapId,
    treasuryCapId: telebtcTreasuryCapId,
    metadataId: telebtcMetadataId
  });
  
  packageManager.save();

  console.log('package published and IDs recorded.');

  // Update published-at in Move.toml
  const moveTomlPath = path.join(pkgDir, 'Move.toml');
  if (fs.existsSync(moveTomlPath)) {
    let moveTomlContent = fs.readFileSync(moveTomlPath, 'utf8');
    const publishedAtRegex = /published-at\s*=\s*"[^"]*"/;
    const newPublishedAt = `published-at = "${mainPackageId}"`;
    
    if (publishedAtRegex.test(moveTomlContent)) {
      moveTomlContent = moveTomlContent.replace(publishedAtRegex, newPublishedAt);
    } else {
      // If no published-at field exists, add it after the [package] section
      const packageSectionRegex = /(\[package\]\s*name\s*=\s*"[^"]*"\s*version\s*=\s*"[^"]*")/;
      if (packageSectionRegex.test(moveTomlContent)) {
        moveTomlContent = moveTomlContent.replace(packageSectionRegex, `$1\n${newPublishedAt}`);
      }
    }
    
    fs.writeFileSync(moveTomlPath, moveTomlContent);
    console.log(`Updated published-at in Move.toml to: ${mainPackageId}`);
  }
}

function parseTransactionDigest(output: string): string | null {
  // Split output into lines
  const lines = output.split('\n');
  
  // Look for transaction digest patterns
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Pattern 1: "Transaction Digest: <digest>"
    if (trimmedLine.startsWith('Transaction Digest:')) {
      const digest = trimmedLine.replace('Transaction Digest:', '').trim();
      if (digest && digest.length > 0) {
        return digest;
      }
    }
  }
  
  return null;
}

main().catch((e) => { console.error(e); process.exit(1); });
