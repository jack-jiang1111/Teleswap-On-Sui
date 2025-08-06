import { expect } from 'vitest';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getActiveKeypair } from '../../scripts/sui.utils';
import * as fs from 'fs';
import * as path from 'path';
import { verifyUpgradeCap } from '../utils/utils';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { BtcRelayFactory } from './btcrelay_factory';
import { TeleBTCFactory } from './telebtc_factory';

// Function to update Move.toml with actual package IDs
function updateMoveToml(btcrelayPackageId: string) {
    // Update teleswap-main-package/Move.toml
    const TeleswapMainPackageMoveTomlPath = path.join(__dirname, '../../teleswap-main-package/Move.toml');
    let moveTomlContent = fs.readFileSync(TeleswapMainPackageMoveTomlPath, 'utf8');
    
    // Update addresses section - replace entire package ID values
    moveTomlContent = moveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "${btcrelayPackageId}"`
    );
    
    fs.writeFileSync(TeleswapMainPackageMoveTomlPath, moveTomlContent);
    console.log('Updated teleswap-main-package/Move.toml with actual package IDs');

    // Update btcrelay-package/Move.toml
    const btcrelayMoveTomlPath = path.join(__dirname, '../../btcrelay-package/Move.toml');
    let btcrelayMoveTomlContent = fs.readFileSync(btcrelayMoveTomlPath, 'utf8');
    
    // Update the btcrelay address from 0x0 to the deployed package ID
    btcrelayMoveTomlContent = btcrelayMoveTomlContent.replace(
        /btcrelay = "[^"]*"/,
        `btcrelay = "${btcrelayPackageId}"`
    );
    
    fs.writeFileSync(btcrelayMoveTomlPath, btcrelayMoveTomlContent);
    console.log('Updated btcrelay-package/Move.toml with actual package ID');
}

export async function CCBurnFactory() {
    const client = new SuiClient({ url: getFullnodeUrl('localnet') });
    const deployer = await getActiveKeypair();

    // 1. Deploy BTC Relay
    console.log('Deploying BTC Relay...');
    const genesisHeader = "00e05b2315d5244defc05310f45733be5d52dee66f0c0bb19f4802000000000000000000727e95f88f38dc43a55a2a24fa8697c6e682fcd22149b61ff3e958d0d22e90c3568c2868ed5c02179dcd6b73";
    const height = 897110;
    const periodStart = "5559430ef0abdfd1a35fc800b39ea8de6aba033246ef10000000000000000000";
    const finalizationParameter = 3;
    
    const btcrelayResult = await BtcRelayFactory(genesisHeader, height, periodStart, finalizationParameter, true); // set mock to true

    // 3. Update Move.toml with actual package IDs
    console.log('Updating Move.toml with actual package IDs...');
    updateMoveToml(btcrelayResult.packageId);

    // 4. Rebuild the package with updated dependencies
    console.log('Rebuilding package with updated dependencies...');
    const { execSync } = require('child_process');
    try {
        const teleswapMainPackagePath = path.join(__dirname, '../../teleswap-main-package');
        execSync('sui move build --skip-fetch-latest-git-deps', { 
            stdio: 'inherit',
            cwd: teleswapMainPackagePath
        });
        console.log('Package rebuilt successfully');
    } catch (error) {
        console.error('Failed to rebuild package:', error);
        throw error;
    }

    // 5. Deploy Burn Router
    console.log('Deploying Burn Router...');
    let telebtcCapId = "";
    let telebtcTreasuryCapId = "";
    let telebtcAdminId = "";

    let burnRouterPackageId = "";
    let burnRouterAdminId = "";
    
    let btcrelayPackageId = btcrelayResult.packageId;
    let btcrelayCapId = btcrelayResult.btcRelayId;
    let btcrelayAdminId = btcrelayResult.relayAdminId;

    let dummyLockerCapId = "";

    // Get modules bytecode (now from the rebuilt package)
    const burnRouterStorageModule = fs.readFileSync(
        path.join(__dirname, '../../teleswap-main-package/build/teleswap/bytecode_modules/burn_router_storage_mock.mv')
    );
    const burnRouterLogicModule = fs.readFileSync(
        path.join(__dirname, '../../teleswap-main-package/build/teleswap/bytecode_modules/burn_router_logic_mock.mv')
    );
    const burnRouterHelperModule = fs.readFileSync(
        path.join(__dirname, '../../teleswap-main-package/build/teleswap/bytecode_modules/burn_router_helper_mock.mv')
    );
    const dummyLockerModule = fs.readFileSync(
        path.join(__dirname, '../../teleswap-main-package/build/teleswap/bytecode_modules/dummy_locker.mv')
    );
    const bitcoinHelperModule = fs.readFileSync(
        path.join(__dirname, '../../btcrelay-package/build/btcrelay/bytecode_modules/bitcoin_helper.mv')
    );
    const telebtcModule = fs.readFileSync(
        path.join(__dirname, '../../teleswap-main-package/build/teleswap/bytecode_modules/telebtc_mock.mv')
    );

    let tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    const [upgradeCap] = tx.publish({
        modules: [
            Array.from(bitcoinHelperModule),
            Array.from(telebtcModule),
            Array.from(burnRouterStorageModule),
            Array.from(burnRouterLogicModule),
            Array.from(burnRouterHelperModule),
            Array.from(dummyLockerModule)
        ],
        dependencies: [
            '0x1', '0x2', '0x3',
            btcrelayPackageId
        ]
    });

    // Transfer the UpgradeCap to the deployer
    tx.transferObjects([upgradeCap], tx.pure(deployer.toSuiAddress()));
    await new Promise(resolve => setTimeout(resolve, 3000));
    let result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { showEffects: true, showEvents: true }
    });
    if(result.effects?.status?.status !== 'success') {
        console.log(result.effects);
        throw new Error('Transaction failed');
    }
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Identify created objects
    for (const obj of result.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';

        if(type === "package") {
            burnRouterPackageId = objectId;
        }
        else if (type.includes('BURN_ROUTER_ADMIN')) {
            burnRouterAdminId = objectId;
        }
        else if (type.includes('DummyLockerCap')) {
            dummyLockerCapId = objectId;
        }
        else if (type.includes('TreasuryCap')) {
            telebtcTreasuryCapId = objectId;
        } 
        else if (type.includes('TeleBTCCap')) {
            telebtcCapId = objectId;
        }
        else if (type.includes('TELEBTC_ADMIN')) {
            telebtcAdminId = objectId;
        }
    }

    console.log('\nSelected objects:');
    console.log('Burn Router Package ID:', burnRouterPackageId);
    console.log('Burn Router Admin ID:', burnRouterAdminId);
    console.log('TeleBTC Cap ID:', telebtcCapId);
    console.log('TeleBTC Treasury Cap ID:', telebtcTreasuryCapId);
    console.log('TeleBTC Admin ID:', telebtcAdminId);
    console.log('BTC Relay Package ID:', btcrelayPackageId);
    console.log('BTC Relay Cap ID:', btcrelayCapId);
    console.log('BTC Relay Admin ID:', btcrelayAdminId);
    console.log('Locker Capability ID:', dummyLockerCapId);

    // Return all the important variables
    return {
        // Burn Router
        burnRouterPackageId,
        burnRouterAdminId,
        
        // TeleBTC
        telebtcCapId,
        telebtcTreasuryCapId,
        telebtcAdminId,
        
        // BTC Relay
        btcrelayPackageId,
        btcrelayCapId,
        btcrelayAdminId,

        // Locker Capability
        dummyLockerCapId,
    };
}
