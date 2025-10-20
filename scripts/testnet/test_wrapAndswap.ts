import { SuiClient } from '@mysten/sui.js/client';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { PackageManager } from '../helper/package_manager';
import { TeleSwapSDK, Network } from '../sdk/teleswap-sdk';

async function main() {
    const testwrapAndSwap = false;
    const testEdgeCases = true;
    const network = getNetwork('testnet');
    const client = new SuiClient({ url: network.url });
    const keypair = await getActiveKeypair();
    const activeAddress = keypair.toSuiAddress();
    
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

    if(testwrapAndSwap) {
        // Test wrap and swap
        // 1. 0.05 btc to wbtc
        try {
            const wrapAndSwapRes = await sdk.wrapAndSwap({
            versionHex: '0x02000000',
            vinHex: "0x01c25e69e28fcdfd55fc785605882564fd1837bd4f4511b7388af6435306be5186000000006c4830450221002529fcad507dc0b18eea08163af13aee575edb7e6614dcad26b3d32fe9a97b3f0220575e907409f6744d32de346de8cf05eeb7600ae522e843a21088133fc5fb23340121023ba4cb58bd9e0601213fa46cd992b827d46da84f6ff9c141f5f38a7ff463b0eae7feffffff",
            voutHex: '0x03404b4c00000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac00000000000000003c6a3a01e4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595000003e8000100000000000000000000000000000000000000000000000007a1201a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
            locktimeHex: '0x00000000',
            blockNumber: 497,
            intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
            index: 1,
            lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
            });
            console.log('wrap and swap:', wrapAndSwapRes);
        } catch (e) {
            console.log('wrap and swap error:', (e as Error).message);
        }

        // 2. 0.05 btc to usdc
        try {
            const wrapAndSwapRes = await sdk.wrapAndSwap({
            versionHex: '0x02000000',
            vinHex: "0x01c25e69e28fcdfd55fc785605882564fd1837bd4f4511b7388af6435306be5186000000006c4830450221002529fcad507dc0b18eea08163af13aee575edb7e6614dcad26b3d32fe9a97b3f0220575e907409f6744d32de346de8cf05eeb7600ae522e843a21088133fc5fb23340121023ba4cb58bd9e0601213fa46cd992b827d46da84f6ff9c141f5f38a7ff463b0eae7feffffff",
            voutHex: '0x03404b4c00000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac00000000000000003c6a3a01e4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595000003e8000101000000000000000000000000000000000000000000000007a1201a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
            locktimeHex: '0x00000000',
            blockNumber: 497,
            intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
            index: 1,
            lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
            });
            console.log('wrap and swap:', wrapAndSwapRes);
        } catch (e) {
            console.log('wrap and swap error:', (e as Error).message);
        }

        // 3. 0.05 btc to usdt
        try {
            const wrapAndSwapRes = await sdk.wrapAndSwap({
            versionHex: '0x02000000',
            vinHex: "0x01c25e69e28fcdfd55fc785605882564fd1837bd4f4511b7388af6435306be5186000000006c4830450221002529fcad507dc0b18eea08163af13aee575edb7e6614dcad26b3d32fe9a97b3f0220575e907409f6744d32de346de8cf05eeb7600ae522e843a21088133fc5fb23340121023ba4cb58bd9e0601213fa46cd992b827d46da84f6ff9c141f5f38a7ff463b0eae7feffffff",
            voutHex: '0x03404b4c00000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac00000000000000003c6a3a01e4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595000003e8000102000000000000000000000000000000000000000000000007a1201a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
            locktimeHex: '0x00000000',
            blockNumber: 497,
            intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
            index: 1,
            lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
            });
            console.log('wrap and swap:', wrapAndSwapRes);
        } catch (e) {
            console.log('wrap and swap error:', (e as Error).message);
        }

        // 4. 0.05 btc to sui
        try {
            const wrapAndSwapRes = await sdk.wrapAndSwap({
            versionHex: '0x02000000',
            vinHex: "0x01c25e69e28fcdfd55fc785605882564fd1837bd4f4511b7388af6435306be5186000000006c4830450221002529fcad507dc0b18eea08163af13aee575edb7e6614dcad26b3d32fe9a97b3f0220575e907409f6744d32de346de8cf05eeb7600ae522e843a21088133fc5fb23340121023ba4cb58bd9e0601213fa46cd992b827d46da84f6ff9c141f5f38a7ff463b0eae7feffffff",
            voutHex: '0x03404b4c00000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac00000000000000003c6a3a01e4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595000003e8000103000000000000000000000000000000000000000000000007a1201a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
            locktimeHex: '0x00000000',
            blockNumber: 497,
            intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
            index: 1,
            lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
            });
            console.log('wrap and swap:', wrapAndSwapRes);
        } catch (e) {
            console.log('wrap and swap error:', (e as Error).message);
        }
    }
    if(testEdgeCases) { 
        // 1. 0.05 btc to wbtc, but a higher min output amount (will fail)
        try {
            const wrapAndSwapRes = await sdk.wrapAndSwap({
            versionHex: '0x02000000',
            vinHex: "0x01c6d23a84ea2fc69877b1f2c7c0ec55e8ef420e138848af59beae9262fe749c6d000000006c4830450221001e8dae063bad5ae4a687653e937d270463c5e28455c9e2151978310cd64863730220a008f379f9487f119b2a510146e741f8856b0b351f7b79f95dc6484955dfda3b0121021242c1eb3250b85de0c323d32dea22e38e9769ebc62041a976ae4531125deb415bfeffffff",
            voutHex: '0x03404b4c00000000001a1976a9144062c8aeed4f81c2d73ff854a2957021191e20b688ac00000000000000003c6a3a01e4e1bf5689c6bb8ad58cab8e4852ca197a146f933a267b9aba5f908322f69595000003e8000100968000989680009896800098968000000000000000000007a1201a1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac',
            locktimeHex: '0x00000000',
            blockNumber: 497,
            intermediateNodesHex: '0x5ff6a258853ed3a4dd9fff062df80397ee4f8c7082c534ade5645741da01a848',
            index: 1,
            lockerLockingScriptHex: LOCKER1_PUBKEY__HASH,
            });
            console.log('wrap and swap:', wrapAndSwapRes);
        } catch (e) {
            console.log('wrap and swap error:', (e as Error).message);
        }

        // the tx id is in little-endian bytes from the wrap and swap debug event
        let txId = "0x91dde7bfaaf56f42184f191f20b7f28a017b9d27ac5af872181874d64ec8c5a5";
        // then call refund by admin
        try {
            const refundByAdminRes = await sdk.refundByAdmin(
                txId,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                LOCKER1_PUBKEY__HASH
            );
            console.log('refund by admin:', refundByAdminRes);
        } catch (e) {
            console.log('refund by admin error:', (e as Error).message);
        }
    }

}

main().catch((e) => {
    console.error(e);
    process.exit(1);
  });