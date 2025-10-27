import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { PackageManager } from '../helper/package_manager';

// locker cap not found, burnrouter found twice
async function main() {
  const networkName = process.argv[2];
  const network = getNetwork(networkName);
  const client = new SuiClient({ url: network.url });
  const keypair = await getActiveKeypair();
  const activeAddress = keypair.toSuiAddress();

  // Load IDs using PackageManager
  const packageManager = new PackageManager();
  const mainPackage = packageManager.getMainPackage(network.name as 'testnet' | 'mainnet');
  const adminCaps = packageManager.getAdminCaps();
  const telebtc = packageManager.getTelebtc();
  const btcrelay = packageManager.getBtcrelay();

  const packageId = mainPackage.packageId;
  if (!packageId) throw new Error('main packageId not found in package_id.json');

  // Admin and caps
  const burnRouterAdminId = adminCaps.burnRouterAdminId;
  const ccTransferAdminId = adminCaps.ccTransferAdminId;
  const lockerAdminCapId = adminCaps.lockerAdminCapId;
  const telebtcAdminId = telebtc.adminId;
  const telebtcCapId = telebtc.capId;
  const telebtcTreasuryCapId = telebtc.treasuryCapId;
  const btcrelayIdForInputs = btcrelay.relayId || btcrelay.packageId;
  if (!burnRouterAdminId || !ccTransferAdminId || !lockerAdminCapId || !telebtcAdminId || !telebtcCapId || !telebtcTreasuryCapId || !btcrelayIdForInputs) {
    throw new Error('Required admin/cap IDs missing in package_id.json');
  }

  // Align with tests (transfer.test.ts, burn.test.ts)
  // STARTING_BLOCK_NUMBER and APP_ID
  const STARTING_BLOCK_NUMBER = 1;
  const APP_ID = 1;
  // Fees and parameters (examples mirrored from tests usage names)
  const PROTOCOL_PERCENTAGE_FEE = 100; // 1% goes to treasury
  const LOCKER_PERCENTAGE_FEE = 50; // 0.5% goes to locker
  const TRANSFER_DEADLINE = 1000; // how many blocks to wait for the burn request to be executed
  const SLASHER_PERCENTAGE_REWARD = 100; // 1% goes to slasher
  const BITCOIN_FEE = 0; // 0 goes to locker (bitcoin fee used for locker gas fee)

  // Rewarder configuration
  const REWARDER_ADDRESS = "0xe4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595"; // Use deployer as rewarder address
  const REWARDER_PERCENTAGE_FEE = 50; // 0.5% goes to rewarder

  // Addresses from tests: TELEPORTER_ADDRESS, TREASURY, bitcoin_fee_oracle use deployer by default
  const TELEPORTER_ADDRESS = activeAddress;
  const TREASURY = "0x23acf578af277fb597830522a110b36dc8da435cd6e7175fcffa4905fb796ce5";
  const BITCOIN_FEE_ORACLE = activeAddress;

  let ccTransferRouterId = "";
  let burnRouterId = "";
  let lockerCapId = "";
  let exchangeCapId = "";
  // Initialize CC Transfer Router
  {
    const tx = new TransactionBlock();
    tx.setGasBudget(100000000);
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
        tx.pure(REWARDER_ADDRESS),
        tx.pure(REWARDER_PERCENTAGE_FEE),
        tx.object(ccTransferAdminId),
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    await new Promise(resolve => setTimeout(resolve, 1500)); // wait for 1.5s to make sure the transaction is executed
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
    tx.setGasBudget(100000000);
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
        tx.pure(REWARDER_ADDRESS),
        tx.pure(REWARDER_PERCENTAGE_FEE),
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    await new Promise(resolve => setTimeout(resolve, 1500)); // wait for 1.5s to make sure the transaction is executed
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
    tx.setGasBudget(100000000);
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
    await new Promise(resolve => setTimeout(resolve, 1500)); // wait for 1.5s to make sure the transaction is executed
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
    const exchangeAdminId = adminCaps.exchangeAdminId;
    if (!exchangeAdminId) throw new Error('exchangeAdminId missing in package_id.json');
    const tx = new TransactionBlock();
    tx.setGasBudget(100000000);
    const LOCKERS_ADDRESS = activeAddress; // reserved param; using deployer
    const THIRD_PARTY_ID = 0;
    const THIRD_PARTY_FEE = 0; // bps
    const THIRD_PARTY_ADDRESS = activeAddress;
    const REWARD_DISTRIBUTOR = activeAddress; 
    const SPECIAL_TELEPORTER = activeAddress;
    tx.moveCall({
      target: `${packageId}::cc_exchange_storage::initialize`,
      arguments: [
        tx.object(exchangeAdminId),
        tx.pure(STARTING_BLOCK_NUMBER),
        tx.pure(PROTOCOL_PERCENTAGE_FEE),
        tx.pure(LOCKER_PERCENTAGE_FEE),
        tx.pure(LOCKERS_ADDRESS),
        tx.pure(btcrelayIdForInputs), // ID
        tx.pure(TREASURY),
        tx.pure(THIRD_PARTY_ID),
        tx.pure(THIRD_PARTY_FEE),
        tx.pure(THIRD_PARTY_ADDRESS),
        tx.pure(REWARD_DISTRIBUTOR),
        tx.pure(SPECIAL_TELEPORTER),
        tx.pure(REWARDER_ADDRESS),
        tx.pure(REWARDER_PERCENTAGE_FEE),
      ],
    });
    const res = await client.signAndExecuteTransactionBlock({ transactionBlock: tx, signer: keypair, options: { showEffects: true } });
    await new Promise(resolve => setTimeout(resolve, 1500)); // wait for 1.5s to make sure the transaction is executed
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

  // Save the initialized object IDs to package manager
  packageManager.setInitializedObjects({
    ccTransferRouterId: ccTransferRouterId,
    burnRouterId: burnRouterId,
    lockerCapId: lockerCapId,
    exchangeCapId: exchangeCapId
  });
  packageManager.save();

  console.log('Initialization completed.');
  console.log('Saved initialized object IDs:');
  console.log('- ccTransferRouterId:', ccTransferRouterId);
  console.log('- burnRouterId:', burnRouterId);
  console.log('- lockerCapId:', lockerCapId);
  console.log('- exchangeCapId:', exchangeCapId);
}

main().catch((e) => { console.error(e); process.exit(1); });
