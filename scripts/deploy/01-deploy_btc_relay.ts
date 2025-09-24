import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getNetwork } from '../helper/config';
import { getActiveKeypair } from '../helper/sui.utils';
import { verifyUpgradeCap } from '../../tests/utils/utils';
import { PackageManager } from '../helper/package_manager';
// run the file to deploy the package
// ts-node ./01-deploy_btc_relay.ts [network] [--real_relay]
// e.g. ts-node ./01-deploy_btc_relay.ts mainnet
// e.g. ts-node ./01-deploy_btc_relay.ts mainnet --real_relay

function resetBtcrelayToml(useRealRelay: boolean, networkName?: string) {
    const relayDir = useRealRelay ? 'btcrelay-package' : 'mock/mock_btcrelay';
    const tomlPath = path.join(__dirname, `../../${relayDir}/Move.toml`);
    try {
        if (fs.existsSync(tomlPath)) {
            const src = fs.readFileSync(tomlPath, 'utf8');
            let updated = updatePublishedAtInToml(src, '0x0');
            updated = updateBtcrelayAddressInToml(updated, '0x0');
            if (updated !== src) {
                fs.writeFileSync(tomlPath, updated);
                console.log(`Reset published-at and btcrelay address to 0x0 in ${relayDir}/Move.toml`);
            }
        }
    } catch (e) {
        console.warn(`Failed to reset Move.toml in ${relayDir}:`, (e as Error).message);
    }
    // also need to reset the teleswap package Move.toml according to network

    // check the toml file, if using relay, then use this line: 
    // btcrelay = { local = "../btcrelay-package" }
    // otherwise use this line:
    // btcrelay = { local = "../mock/mock_btcrelay" }

    const desired = useRealRelay ? '../btcrelay-package' : '../mock/mock_btcrelay';
    const targetToml = path.join(
        __dirname,
        networkName === 'mainnet' ? '../../teleswap-mainnet/Move.toml' : '../../teleswap-testnet/Move.toml'
    );
    try {
        if (fs.existsSync(targetToml)) {
            const src = fs.readFileSync(targetToml, 'utf8');
            const updated = updateBtcrelayDependencyInToml(src, desired);
            if (updated !== src) {
                fs.writeFileSync(targetToml, updated);
                console.log(`Updated btcrelay dependency to ${desired} in ${targetToml}`);
            }
        }
    } catch (e) {
        console.warn(`Failed to update btcrelay dependency in ${targetToml}:`, (e as Error).message);
    }
}

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const networkName = args[0];
    const useRealRelay = args.includes('--real_relay');
    
    const relayDir = useRealRelay ? 'btcrelay-package' : 'mock/mock_btcrelay';
    const relayType = useRealRelay ? 'real' : 'mock';
    
    console.log(`Deploying ${relayType} BTC relay from ${relayDir}/`);
    
    // Reset Move.toml to use 0x0 for published-at and btcrelay address before deployment
    console.log('Resetting Move.toml to use 0x0 for published-at and btcrelay address...');
    resetBtcrelayToml(useRealRelay, networkName);
    
    console.log('Building package...');
    execSync('sui move build', { cwd: path.join(__dirname, `../../${relayDir}`), stdio: 'inherit' });

    // Get network from command line args or use default
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
        Array.from(await getBuildedModule('bitcoin_helper', useRealRelay)),
        Array.from(await getBuildedModule('btcrelay', useRealRelay))
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

        // Update package_id.json using PackageManager
        const packageManager = new PackageManager();
        packageManager.setBtcrelay({
            packageId: packageId,
            upgradeCapId: upgradeCapId,
            adminId: relayAdminId
        });
        packageManager.save();

        // Update Move.toml published-at field and btcrelay address for the deployed package
        const btcrelayTomlPath = path.join(__dirname, `../../${relayDir}/Move.toml`);
        try {
            if (fs.existsSync(btcrelayTomlPath)) {
                const src = fs.readFileSync(btcrelayTomlPath, 'utf8');
                let updated = updatePublishedAtInToml(src, packageId);
                updated = updateBtcrelayAddressInToml(updated, packageId);
                if (updated !== src) {
                    fs.writeFileSync(btcrelayTomlPath, updated);
                    console.log(`Updated published-at and btcrelay address in ${btcrelayTomlPath}`);
                }
            }
        } catch (e) {
            console.warn(`Failed to update Move.toml at ${btcrelayTomlPath}:`, (e as Error).message);
        }

    } else {
        console.error('Deployment failed:', result.effects?.status);
    }
}

function updatePublishedAtInToml(toml: string, pkgId: string): string {
    // Replace a line like: published-at = "0x..." (or without quotes)
    const re = /(published-at\s*=\s*)("?)(0x[0-9a-fA-F]+)("?)/;
    if (re.test(toml)) {
        return toml.replace(re, `$1"${pkgId}"`);
    }
    // If not present, try to append under [package]
    if (toml.includes('[package]')) {
        return toml.replace(/\[package\][^\n]*\n/, (m) => m + `published-at = "${pkgId}"
`);
    }
    // Fallback: append at end
    return toml + `
[package]
published-at = "${pkgId}"
`;
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

function updateBtcrelayDependencyInToml(toml: string, localPath: string): string {
    // Normalize line endings and replace the btcrelay dependency local path
    // Match forms like: btcrelay = { local = "../btcrelay-package" }
    const re = /(btcrelay\s*=\s*\{\s*local\s*=\s*")[^"]+("\s*\})/;
    if (re.test(toml)) {
        return toml.replace(re, `$1${localPath}$2`);
    }
    // If dependency not present, append under [dependencies]
    if (toml.includes('[dependencies]')) {
        return toml.replace(/\[dependencies\][^\n]*\n/, (m) => m + `btcrelay = { local = "${localPath}" }
`);
    }
    // Fallback: append a dependencies section
    return toml + `
[dependencies]
btcrelay = { local = "${localPath}" }
`;
}

async function getBuildedModule(name: string, useRealRelay: boolean): Promise<Uint8Array> {
    const relayDir = useRealRelay ? 'btcrelay-package' : 'mock/mock_btcrelay';
    return fs.readFileSync(
        path.join(__dirname, `../../${relayDir}/build/btcrelay/bytecode_modules/${name}.mv`)
    );
}

main().catch(console.error);