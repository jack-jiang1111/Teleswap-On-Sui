import { SuiClient } from '@mysten/sui.js/client';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { PackageManager } from '../helper/package_manager';
import { TeleSwapSDK, Network } from './teleswap-sdk';

async function main() {
  const network = getNetwork('testnet');
  const client = new SuiClient({ url: network.url });

  // Use default CLI active address/keypair
  const keypair = await getActiveKeypair();
  const activeAddress = keypair.toSuiAddress();
  console.log('Active address:', activeAddress);
  console.log('Network:', network.name);

  // Load coin package ids from package_id.json via PackageManager
  const pm = new PackageManager();
  const mockTokens = pm.getMockTokens();

  // Build coin type strings
  const COIN_TYPES: Record<string, string> = {
    BTC: `${mockTokens.btc.packageId}::btc::BTC`,
    USDT: `${mockTokens.usdt.packageId}::usdt::USDT`,
    USDC: `${mockTokens.usdc.packageId}::usdc::USDC`,
    TELEBTC: `${pm.getTelebtc().packageId}::telebtc::TELEBTC`,
  };

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
      console.log(`${symbol} (${type}): ${bal.toString()}`);
    } catch (e) {
      console.log(`${symbol} (${type}): error ->`, (e as Error).message);
    }
  }


  // Bitcoin public key (32 bytes)
  let LOCKER1 = '0x03789ed0bb717d88f7d321a368d905e7430207ebbd82bd342cf11ae157a7ace5fd';
  
  // full lock script
  let LOCKER1_PUBKEY__HASH = '0x1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac';

  let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
  let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 4; // P2PKH
  
  // Initialize SDK with the CLI active keypair
  const sdk = new TeleSwapSDK({
    network: Network.TESTNET,
    // Use the CLI active keypair directly to avoid privateKey encoding issues
    keypair,
  });

  // 1) Request to become locker (exact amount mode)
  try {
    const reqRes = await sdk.requestToBecomeLocker({
      coinType: COIN_TYPES.BTC,
      amount: '100000000', // one full btc
      lockerLockingScriptHashHex: LOCKER1_PUBKEY__HASH,
      lockerScriptType: LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
      lockerRescueScriptHex: LOCKER_RESCUE_SCRIPT_P2PKH,
    });
    console.log('request_to_become_locker:', reqRes);
  } catch (e) {
    console.log('request_to_become_locker error:', (e as Error).message);
  }

  // 2) Add locker (admin only; Let deployer add itself as a locker)
  try {
    const addRes = await sdk.addLocker({
      newLockerAddress: activeAddress,
      reliabilityFactor: 1,
    });
    console.log('add_locker:', addRes);
  } catch (e) {
    console.log('add_locker error:', (e as Error).message);
  }

  // 3) Wrap (cc_transfer) with dummy types/amount
  try {
    const wrapRes = await sdk.wrap({
      versionHex: '0x02000000',
      vinHex: "0x01c25e69e28fcdfd55fc785605882564fd1837bd4f4511b7388af6435306be5186000000006c4830450221002529fcad507dc0b18eea08163af13aee575edb7e6614dcad26b3d32fe9a97b3f0220575e907409f6744d32de346de8cf05eeb7600ae522e843a21088133fc5fb23340121023ba4cb58bd9e0601213fa46cd992b827d46da84f6ff9c141f5f38a7ff463b0eae7feffffff",
      voutHex: '0x0300ca9a3b000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac0000000000000000296a2701878799c85d1bcbd9419b150d2e2dabb1cdc49f361944e9235d8204ee45871c2b000003e800000000000005f5e1001a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
      locktimeHex: '0x00000000',
      blockNumber: 497,
      intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
      index: 1,
      lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
    });
    console.log('wrap:', wrapRes);
  } catch (e) {
    console.log('wrap error:', (e as Error).message);
  }

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});