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
  const telebtc = pm.getTelebtc();

  // Build coin type strings
  const COIN_TYPES: Record<string, string> = {
    BTC: `${mockTokens.btc.packageId}::btc::BTC`,
    USDT: `${mockTokens.usdt.packageId}::usdt::USDT`,
    USDC: `${mockTokens.usdc.packageId}::usdc::USDC`,
    TELEBTC: `${telebtc.adminId}::telebtc::TELEBTC`,
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

  // // 1) Request to become locker (exact amount mode)
  // try {
  //   const reqRes = await sdk.requestToBecomeLocker({
  //     coinType: COIN_TYPES.BTC,
  //     amount: '100000000', // one full btc
  //     lockerLockingScriptHashHex: LOCKER1_PUBKEY__HASH,
  //     lockerScriptType: LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
  //     lockerRescueScriptHex: LOCKER_RESCUE_SCRIPT_P2PKH,
  //   });
  //   console.log('request_to_become_locker:', reqRes);
  // } catch (e) {
  //   console.log('request_to_become_locker error:', (e as Error).message);
  // }

  // // 2) Add locker (admin only; Let deployer add itself as a locker)
  // try {
  //   const addRes = await sdk.addLocker({
  //     newLockerAddress: activeAddress,
  //     reliabilityFactor: 1,
  //   });
  //   console.log('add_locker:', addRes);
  // } catch (e) {
  //   console.log('add_locker error:', (e as Error).message);
  // }

  //3) Wrap (cc_transfer) with dummy types/amount
  // try {
  //   const wrapRes = await sdk.wrap({
  //     versionHex: '0x02000000',
  //     vinHex: "0x018d12dd1c16daec0358b07e4bf0409069f15a15bcd41cfbd077371b0450aa9981000000006c4830450221002078f23415a61b13febaad61ca972caca8f1cd37150ccb47248147b75248c9af02202a10ea6df6840fea69adbf3f036b79f179a9252ad28c62db5f8c1448d55bc7d901210214ffa70136d1f9ac296af3f9f77b33445962a2cd07a2b941196c173c683b752487feffffff",
  //     voutHex: '0x0300e1f505000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac0000000000000000296a2701af5d13af48dd554f22b3e4b97b2e1770b56dba9c9551826be8524b78f99e4a14000003e8000000000000009896801a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
  //     locktimeHex: '0x00000000',
  //     blockNumber: 497,
  //     intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
  //     index: 1,
  //     lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
  //   });
  //   console.log('wrap:', wrapRes);
  // } catch (e) {
  //   console.log('wrap error:', (e as Error).message);
  // }

  // step 4, make pools in cetus, 
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});