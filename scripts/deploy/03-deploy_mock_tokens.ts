import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';

async function main() {
  const networkName = process.argv[2];
  const network = getNetwork(networkName);
  if (network.name !== 'testnet') {
    console.log('Mock token deployment is only for testnet. Skipping.');
    process.exit(0);
  }
  const client = new SuiClient({ url: network.url });
  const keypair = await getActiveKeypair();
  const activeAddress = keypair.toSuiAddress();

  // Token package directories
  const tokenDirs = [
    path.join(__dirname, '../../mock/mock_coins/btc'),
    path.join(__dirname, '../../mock/mock_coins/usdt'),
    path.join(__dirname, '../../mock/mock_coins/usdc'),
  ];
  const resultKeys = ['mockBtcPackageId', 'mockUsdtPackageId', 'mockUsdcPackageId'] as const;

  const outPath = path.join(__dirname, '../../package_id.json');
  let current: any = {};
  if (fs.existsSync(outPath)) {
    try { current = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  }

  for (let i = 0; i < tokenDirs.length; i++) {
    const dir = tokenDirs[i];
    const key = resultKeys[i];
    console.log(`\nBuilding token package at ${dir} ...`);
    execSync('sui move build', { cwd: dir, stdio: 'inherit' });

    // Load modules from build output
    const bytecodeDir = await findBytecodeModulesDir(dir);
    const modules = fs.readdirSync(bytecodeDir)
      .filter((f) => f.endsWith('.mv'))
      .sort()
      .map((f) => Array.from(fs.readFileSync(path.join(bytecodeDir, f))));

    console.log(`Publishing token package ${path.basename(dir)} ...`);
    const gasCoins = await getGasCoins(client, activeAddress);

    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.setGasPayment(gasCoins);

    const [upgradeCap] = tx.publish({
      modules,
      dependencies: ['0x1', '0x2', '0x3'],
    });
    tx.transferObjects([upgradeCap], tx.pure(activeAddress));

    const result = await client.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      signer: keypair,
      options: { showEffects: true }
    });

    let packageId = '';
    for (const obj of result.effects?.created || []) {
      if (obj.owner === 'Immutable') {
        packageId = obj.reference.objectId;
        break;
      }
    }
    if (!packageId) {
      throw new Error(`Failed to determine packageId for ${dir}`);
    }
    console.log(`${key}: ${packageId}`);
    current[key] = packageId; // append/overwrite
    fs.writeFileSync(outPath, JSON.stringify(current, null, 2));

    // wait 1s between deployments
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\nMock tokens deployed and recorded into package_id.json');
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
  // Find the first subdir under build/*/bytecode_modules
  const buildDir = path.join(pkgDir, 'build');
  const subdirs = fs.readdirSync(buildDir).filter((f) => fs.statSync(path.join(buildDir, f)).isDirectory());
  for (const sd of subdirs) {
    const candidate = path.join(buildDir, sd, 'bytecode_modules');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`bytecode_modules not found under ${buildDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
