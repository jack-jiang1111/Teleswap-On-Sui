import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';

// locker cap not found, burnrouter found twice
async function main() {
  const networkName = process.argv[2];
  const network = getNetwork(networkName);
  const client = new SuiClient({ url: network.url });
  const keypair = await getActiveKeypair();
  const activeAddress = keypair.toSuiAddress();

  // Load IDs from package_id.json in main directory
  const idsPath = path.join(__dirname, '../../package_id.json');
  if (!fs.existsSync(idsPath)) throw new Error('package_id.json not found. Run previous deploy scripts first.');
  const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));

  const packageId = network.name === 'testnet' ? ids.mainTestnetPackageId : ids.mainMainnetPackageId;
  if (!packageId) throw new Error('main packageId not found in package_id.json');

  // Admin and caps
  const burnRouterAdminId = ids.burnRouterAdminId;
  const ccTransferAdminId = ids.ccTransferAdminId;
  const lockerAdminCapId = ids.lockerAdminCapId;
  const telebtcAdminId = ids.telebtcAdminId;
  const telebtcCapId = ids.telebtcCapId;
  const telebtcTreasuryCapId = ids.telebtcTreasuryCapId;
  const btcrelayCapId = ids.btcrelayCapId; // preferred
  const btcrelayPackageId = ids.btcrelayPackageId; // fallback only if needed as ID placeholder
  const btcrelayIdForInputs = btcrelayCapId ?? btcrelayPackageId;
  if (!burnRouterAdminId || !ccTransferAdminId || !lockerAdminCapId || !telebtcAdminId || !telebtcCapId || !telebtcTreasuryCapId || !btcrelayIdForInputs) {
    throw new Error('Required admin/cap IDs missing in package_id.json');
  }

  // Align with tests (transfer.test.ts, burn.test.ts)
  // STARTING_BLOCK_NUMBER and APP_ID
  const STARTING_BLOCK_NUMBER = 1;
  const APP_ID = 1;
  // Fees and parameters (examples mirrored from tests usage names)
  const PROTOCOL_PERCENTAGE_FEE = 100; // adjust if needed
  const LOCKER_PERCENTAGE_FEE = 50; // adjust if needed
  const TRANSFER_DEADLINE = 1000; // adjust if needed
  const SLASHER_PERCENTAGE_REWARD = 100; // adjust if needed
  const BITCOIN_FEE = 100; // adjust if needed

  // Addresses from tests: TELEPORTER_ADDRESS, TREASURY, bitcoin_fee_oracle use deployer by default
  const TELEPORTER_ADDRESS = activeAddress;
  const TREASURY = activeAddress;
  const BITCOIN_FEE_ORACLE = activeAddress;

  let ccTransferRouterId = "";
  let burnRouterId = "";
  let lockerCapId = "";
  let exchangeCapId = "";
  // Initialize CC Transfer Router
  {
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
      target: `${packageId}::cc_transfer_router_logic::initialize`,
      arguments: [
        tx.pure(STARTING_BLOCK_NUMBER),
        tx.pure(APP_ID),
        tx.pure(PROTOCOL_PERCENTAGE_FEE),
        tx.pure(TELEPORTER_ADDRESS),
        tx.pure(TREASURY),
        tx.pure(LOCKER_PERCENTAGE_FEE),
        tx.pure(btcrelayIdForInputs), // ID
        tx.object(ccTransferAdminId),
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    if (res.effects?.status?.status !== 'success') {
      console.log('cc_transfer initialize failed');
      console.log(res.effects);
    }
    else{ // if success find the ccTransferRouterId
      console.log('cc_transfer initialize success');
      // find the ccTransferRouterId
      
      for (const obj of res.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';
        if (type.includes('CCTransferRouterCap')) {
          ccTransferRouterId = objectId;
          console.log('ccTransferRouterId:', ccTransferRouterId);
          break;
        }
      }
    }
    
  }

  // Initialize Burn Router
  {
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.moveCall({
      target: `${packageId}::burn_router_logic::initialize`,
      arguments: [
        tx.object(burnRouterAdminId),
        tx.pure(STARTING_BLOCK_NUMBER),
        tx.pure(TREASURY),
        tx.pure(TRANSFER_DEADLINE),
        tx.pure(PROTOCOL_PERCENTAGE_FEE),
        tx.pure(LOCKER_PERCENTAGE_FEE),
        tx.pure(SLASHER_PERCENTAGE_REWARD),
        tx.pure(BITCOIN_FEE),
        tx.pure(BITCOIN_FEE_ORACLE),
        tx.pure(btcrelayIdForInputs), // ID
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    if (res.effects?.status?.status !== 'success') {
      console.log('burn_router initialize failed');
      console.log(res.effects);
    }
    else{
      console.log('burn_router initialize success');
      // find the burnRouterId
      for (const obj of res.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';
        if (type.includes('BurnRouter')) {
          burnRouterId = objectId;
          console.log('burnRouterId:', burnRouterId);
          break;
        }
      }
    }
  }

  // Initialize Locker
  {
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    const inactivationDelay = 20;
    const collateralRatio = 20000;
    const penaltyRatio = 15000;
    const liquidationThreshold = 9500;
    tx.moveCall({
      target: `${packageId}::lockerstorage::initialize`,
      arguments: [
        tx.object(lockerAdminCapId),
        tx.pure(inactivationDelay),
        tx.pure(collateralRatio),
        tx.pure(penaltyRatio),
        tx.pure(liquidationThreshold),
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    if (res.effects?.status?.status !== 'success') {
      console.log('locker initialize failed');
      console.log(res.effects);
    }
    else{
      console.log('locker initialize success');
      // find the lockerId
      for (const obj of res.effects?.created || []) {
          const objectId = obj.reference.objectId;
          const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
          const type = objInfo.data?.type || '';
          if (type.includes('LockerCap')) {
            lockerCapId = objectId;
            console.log('lockerCapId:', lockerCapId);
            break;
          }
        }
      }
  }

  // Initialize Exchange (cc_exchange_storage)
  {
    const exchangeAdminId = ids.exchangeAdminId;
    if (!exchangeAdminId) throw new Error('exchangeAdminId missing in package_id.json');
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    const CHAIN_ID = 1; // example chain id
    const LOCKERS_ADDRESS = activeAddress; // reserved param; using deployer
    const THIRD_PARTY_ID = 1;
    const THIRD_PARTY_FEE = 0; // bps
    const THIRD_PARTY_ADDRESS = activeAddress;
    const REWARD_DISTRIBUTOR = activeAddress; // disabled
    const SPECIAL_TELEPORTER = activeAddress;
    tx.moveCall({
      target: `${packageId}::cc_exchange_storage::initialize`,
      arguments: [
        tx.object(exchangeAdminId),
        tx.pure(STARTING_BLOCK_NUMBER),
        tx.pure(PROTOCOL_PERCENTAGE_FEE),
        tx.pure(LOCKER_PERCENTAGE_FEE),
        tx.pure(CHAIN_ID),
        tx.pure(LOCKERS_ADDRESS),
        tx.pure(btcrelayIdForInputs), // ID
        tx.pure(TREASURY),
        tx.pure(THIRD_PARTY_ID),
        tx.pure(THIRD_PARTY_FEE),
        tx.pure(THIRD_PARTY_ADDRESS),
        tx.pure(REWARD_DISTRIBUTOR),
        tx.pure(SPECIAL_TELEPORTER),
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    if (res.effects?.status?.status !== 'success') {
      console.log('exchange initialize failed');
      console.log(res.effects);
    }
    else{
      console.log('exchange initialize success');
      // find the exchangeId
      for (const obj of res.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';
        if (type.includes('ExchangeCap')) {
          exchangeCapId = objectId;
          console.log('exchangeCapId:', exchangeCapId);
            break;
          }
      }
    }
  }

  console.log('Initialization completed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
