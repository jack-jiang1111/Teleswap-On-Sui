import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { verifyUpgradeCap } from '../../tests/utils/utils';
// run the file to deploy the package
// ts-node ./01-deploy_btc_relay.ts [network]
// e.g. ts-node ./01-deploy_btc_relay.ts mainnet

function resetBtcrelayAddressInToml() {
    const tomlPath = path.join(__dirname, '../../btcrelay-package/Move.toml');
    try {
        if (fs.existsSync(tomlPath)) {
            const src = fs.readFileSync(tomlPath, 'utf8');
            const updated = updateBtcrelayAddressInToml(src, '0x0');
            if (updated !== src) {
                fs.writeFileSync(tomlPath, updated);
                console.log('Reset btcrelay address to 0x0 in Move.toml');
            }
        }
    } catch (e) {
        console.warn('Failed to reset Move.toml:', (e as Error).message);
    }
}

async function main() {
    // Reset Move.toml to use 0x0 for btcrelay address before deployment
    console.log('Resetting Move.toml to use 0x0 for btcrelay address...');
    resetBtcrelayAddressInToml();
    
    console.log('Building package...');
    execSync('sui move build', { cwd: path.join(__dirname, '../../btcrelay-package'), stdio: 'inherit' });

    // Get network from command line args or use default
    const networkName = process.argv[2];
    const network = getNetwork(networkName);
    console.log('Using network:', network.name);
    
    const client = new SuiClient({ url: network.url });
    
    const keypair = await getActiveKeypair();
    const activeAddress = keypair.toSuiAddress();
    
    console.log('Deploying package...');
    // Get gas coins with proper object references
    const { data: gasObjects } = await client.getOwnedObjects({
        owner: activeAddress,
        filter: { MatchAll: [{ StructType: '0x2::coin::Coin<0x2::sui::SUI>' }] },
        options: { showContent: true, showType: true }
    });
    
    if (!gasObjects.length) {
        throw new Error('No gas coins available');
    }

    const gasCoins = gasObjects.map(obj => ({
        objectId: obj.data?.objectId ?? '',
        version: obj.data?.version?? '',
        digest: obj.data?.digest?? ''
    }));
    
    // Create and configure transaction
    const tx = new TransactionBlock();
    tx.setGasBudget(500000000);
    tx.setGasPayment(gasCoins);

    const modules = [
        Array.from(await getBuildedModule('bitcoin_helper')),
        Array.from(await getBuildedModule('btcrelay'))
    ];

    const [upgradeCap] = tx.publish({
        modules,
        dependencies: ['0x1', '0x2', '0x3'],  // Add Sui Framework dependency
    });
    // Transfer the UpgradeCap to the deployer
    tx.transferObjects([upgradeCap], tx.pure(activeAddress));
    
    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: keypair,
        options: { showEffects: true }
    });

    let packageId = "";
    let upgradeCapId = "";
    let relayAdminId = "";
    await new Promise(resolve => setTimeout(resolve, 3000)); // wait for 3s to make sure the transaction is executed
    if(result.effects?.status?.status !== 'success') {
        console.log(result.effects);
        throw new Error('Transaction failed');
    }
    // Verify all created objects and find UpgradeCap and RELAY_ADMIN
    console.log('\nVerifying all created objects:');
    for (const obj of result.effects?.created || []) {
        const objectId = obj.reference.objectId;
        const objInfo = await client.getObject({ id: objectId, options: { showType: true } });
        const type = objInfo.data?.type || '';

        // There will be two objects created under deployer's address: UpgradeCap and RELAY_ADMIN
        // we have to identify which one is the UpgradeCap and which one is the RELAY_ADMIN
        if(type === "package") {
            // This is the package ID
            packageId = objectId;
        }
        else if (type.includes('RELAY_ADMIN')) {
            relayAdminId = objectId;
        }
        else if (type.includes('UpgradeCap')) {
            upgradeCapId = objectId;
        }
    }

    if (upgradeCapId=="") {
        throw new Error('No upgrade capability found in deployment result');
    }

    if (relayAdminId=="") {
        throw new Error('No RELAY_ADMIN object found in deployment result');
    }

    if (result.effects?.status.status === 'success') {
        console.log('Package deployed successfully!');
        console.log('Package ID:', packageId);
        console.log('Upgrade Cap ID:', upgradeCapId);
        console.log('RELAY_ADMIN ID:', relayAdminId);

        // Merge/append to package_id.json in main directory
        const outPath = path.join(__dirname, '../../package_id.json');
        let current: any = {};
        if (fs.existsSync(outPath)) {
            try { current = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
        }
        current.btcrelayPackageId = packageId;
        current.btcrelayUpgradeCapId = upgradeCapId;
        current.btcrelayAdminId = relayAdminId;
        fs.writeFileSync(outPath, JSON.stringify(current, null, 2));

        // Update Move.toml named address 'btcrelay' for btcrelay-package and both testnet and mainnet packages
        const tomlPaths = [
            path.join(__dirname, '../../btcrelay-package/Move.toml'),
            path.join(__dirname, '../../teleswap-testnet/Move.toml'),
            path.join(__dirname, '../../teleswap-mainnet/Move.toml'),
        ];
        for (const p of tomlPaths) {
            try {
                if (!fs.existsSync(p)) continue;
                const src = fs.readFileSync(p, 'utf8');
                const updated = updateBtcrelayAddressInToml(src, packageId);
                if (updated !== src) {
                    fs.writeFileSync(p, updated);
                    console.log(`Updated btcrelay address in ${p}`);
                }
            } catch (e) {
                console.warn(`Failed to update Move.toml at ${p}:`, (e as Error).message);
            }
        }
    } else {
        console.error('Deployment failed:', result.effects?.status);
    }
}

function updateBtcrelayAddressInToml(toml: string, pkgId: string): string {
    // Replace a line like: btcrelay = "0x..." (or without quotes)
    const re = /(btcrelay\s*=\s*)("?)(0x[0-9a-fA-F]+)("?)/;
    if (re.test(toml)) {
        return toml.replace(re, `$1"${pkgId}"`);
    }
    // If not present, try to append under [addresses]
    if (toml.includes('[addresses]')) {
        return toml.replace(/\[addresses\][^\n]*\n/, (m) => m + `btcrelay = "${pkgId}"
`);
    }
    // Fallback: append at end
    return toml + `
[addresses]
btcrelay = "${pkgId}"
`;
}

async function getBuildedModule(name: string): Promise<Uint8Array> {
    return fs.readFileSync(
        path.join(__dirname, `../../btcrelay-package/build/btcrelay/bytecode_modules/${name}.mv`)
    );
}

main().catch(console.error);