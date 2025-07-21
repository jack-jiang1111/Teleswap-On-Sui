import { SuiClient } from '@mysten/sui.js/client';
import { getFullnodeUrl } from '@mysten/sui.js/client';
import { beforeAll, describe, expect, test } from "vitest";
import { CCBurnFactory } from "./test_factory/cc_burn_factory";
import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { getActiveKeypair } from "../scripts/sui.utils";

// Shared variables and setup

describe('BurnRouter Test Suite', () => {
    // Declare variables to store the factory results
    let burnRouterPackageId: string;
    let burnRouterAdminId: string;
    let telebtcCapId: string;
    let telebtcTreasuryCapId: string;
    let telebtcAdminId: string;
    let btcrelayPackageId: string;
    let btcrelayCapId: string;
    let btcrelayAdminId: string;
    let lockerCapabilityId: string;
    let deployer: Ed25519Keypair;
    let deployerAddress: string;

    beforeAll(async () => {
        // Receive all the values from CCBurnFactory
        const factory = await CCBurnFactory();
        ({
            burnRouterPackageId,
            burnRouterAdminId,
            telebtcCapId,
            telebtcTreasuryCapId,
            telebtcAdminId,
            btcrelayPackageId,
            btcrelayCapId,
            btcrelayAdminId,
            lockerCapabilityId
        } = factory);

        deployer = await getActiveKeypair();
        deployerAddress = deployer.getPublicKey().toSuiAddress();
    }, 60000); // Set timeout to 60 seconds

    test('Factory should deploy and return all important IDs', async () => {
        expect(burnRouterPackageId).toBeTruthy();
        expect(burnRouterAdminId).toBeTruthy();
        expect(telebtcCapId).toBeTruthy();
        expect(telebtcTreasuryCapId).toBeTruthy();
        expect(telebtcAdminId).toBeTruthy();
        expect(btcrelayPackageId).toBeTruthy();
        expect(btcrelayCapId).toBeTruthy();
        expect(btcrelayAdminId).toBeTruthy();
        expect(lockerCapabilityId).toBeTruthy();
    });
}); 