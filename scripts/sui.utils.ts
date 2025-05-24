import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { fromB64 } from '@mysten/sui.js/utils';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export async function getActiveKeypair(): Promise<Ed25519Keypair> {
    // Get the active address's keypair from the Sui keystore
    const activeAddress = execSync('sui client active-address', { encoding: 'utf8' }).trim();
    console.log('Using active address:', activeAddress);
    
    // Get the keypair from your local keystore that matches the active address
    const userHome = process.env.HOME || process.env.USERPROFILE;
    if (!userHome) {
        throw new Error('Could not find user home directory');
    }
    const keystorePath = path.join(userHome, '.sui/sui_config/sui.keystore');
    const keystore = JSON.parse(fs.readFileSync(keystorePath).toString());
    
    let keypair: Ed25519Keypair | undefined;
    
    for (const key of keystore) {
        const privateKeyBytes = fromB64(key);
        
        try {
            const kp2 = Ed25519Keypair.fromSecretKey(privateKeyBytes.slice(1, 33));

            if (kp2.toSuiAddress() === activeAddress) {
                keypair = kp2;
                break;
            }
        } catch (e) {
            console.log('Error processing key:', e);
        }
    }
    
    if (!keypair) {
        throw new Error('Could not find matching keypair for active address');
    }
    
    return keypair;
}