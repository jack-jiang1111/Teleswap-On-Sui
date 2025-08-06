import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { TeleBTCFactory } from './test_factory/telebtc_factory';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { splitGasTokens } from './utils/move-helper';



async function checkBalance(client: SuiClient, address: string, packageId: string) {
    const balance = await client.getBalance({
        owner: address,
        coinType:  `${packageId}::telebtc::TELEBTC`
    });
    return Number(balance.totalBalance);
}

async function advanceEpoch(client: SuiClient, deployer: any) {
    const tx = new TransactionBlock();
    tx.moveCall({
        target: '0x2::sui_system::advance_epoch',
        arguments: []
    });
    tx.setGasBudget(500000000);
    let result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { 
            showEffects: true,
        }
    });
    console.log(result.effects);
    expect(result.effects?.status?.status).toBe('success');
}



describe('TeleBTC Tests', () => {
    let client: SuiClient;
    let deployer: any;
    let packageId: string;
    let upgradeCapId: string;
    let treasuryCapId: string;
    let capId: string;
    let adminId: string;
    let signer1: any;
    let signer2: any;

    beforeAll(async () => {
        client = new SuiClient({ url: getFullnodeUrl('localnet') });
        const factory = await TeleBTCFactory();
        deployer = factory.deployer;
        packageId = factory.packageId;
        upgradeCapId = factory.upgradeCapId;
        treasuryCapId = factory.treasuryCapId;
        capId = factory.capId;
        adminId = factory.adminId;
        // Create a new test address
        signer1 = new Ed25519Keypair();
        signer2 = new Ed25519Keypair();
        
        
        // Split some gas tokens to the test address
        await splitGasTokens(client, deployer, signer1.toSuiAddress(), 2000000000); // 1 SUI
        await new Promise(resolve => setTimeout(resolve, 1000));
        await splitGasTokens(client, deployer, signer2.toSuiAddress(), 2000000000); // 1 SUI
    });

    it('should successfully deploy the contract', async () => {
        expect(packageId).toBeTruthy();
        expect(upgradeCapId).toBeTruthy();
        expect(treasuryCapId).toBeTruthy();
        expect(capId).toBeTruthy();
        expect(adminId).toBeTruthy();
    });

    describe('Role Management', () => {
        it('should add and remove minter role', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            let tx = new TransactionBlock();
            const newMinter = deployer.toSuiAddress();

            tx.moveCall({
                target: `${packageId}::telebtc::add_minter`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(newMinter)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::is_minter`,
                arguments: [
                    tx.object(capId),
                    tx.pure(deployer.toSuiAddress())
                ]
            });

            result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer.toSuiAddress(),
            });

            expect(result.effects?.status?.status).toBe('success');
            let returnValues = result.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues[0]).toBe(1);

            await new Promise(resolve => setTimeout(resolve, 1000));
            tx = new TransactionBlock();
            const address = deployer.toSuiAddress();

            tx.moveCall({
                target: `${packageId}::telebtc::remove_minter`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::is_minter`,
                arguments: [
                    tx.object(capId),
                    tx.pure(address)
                ]
            });

            result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer.toSuiAddress(),
            });

            expect(result.effects?.status?.status).toBe('success');
            returnValues = result.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues[0]).toBe(0);
        });

        it('should add and remove burner role', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            let tx = new TransactionBlock();
            const address = deployer.toSuiAddress();

            // Add burner
            tx.moveCall({
                target: `${packageId}::telebtc::add_burner`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify burner was added
            const tx2 = new TransactionBlock();
            tx2.moveCall({
                target: `${packageId}::telebtc::is_burner`,
                arguments: [
                    tx2.object(capId),
                    tx2.pure(address)
                ]
            });

            const result2 = await client.devInspectTransactionBlock({
                transactionBlock: tx2,
                sender: deployer.toSuiAddress(),
            });

            expect(result2.effects?.status?.status).toBe('success');
            let returnValues = result2.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues[0]).toBe(1);
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Remove burner
            const tx3 = new TransactionBlock();
            tx3.moveCall({
                target: `${packageId}::telebtc::remove_burner`,
                arguments: [
                    tx3.object(capId),
                    tx3.object(adminId),
                    tx3.pure(address)
                ]
            });

            const result3 = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx3,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result3.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify burner role was removed
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::is_burner`,
                arguments: [
                    tx.object(capId),
                    tx.pure(address)
                ]
            });

            result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer.toSuiAddress(),
            });

            expect(result.effects?.status?.status).toBe('success');
            returnValues = result.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues[0]).toBe(0);
        });

        it('should add and remove blacklister role', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const address = deployer.toSuiAddress();

            // Add blacklister
            tx.moveCall({
                target: `${packageId}::telebtc::add_blacklister`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify blacklister was added
            const tx2 = new TransactionBlock();
            tx2.moveCall({
                target: `${packageId}::telebtc::is_blacklister`,
                arguments: [
                    tx2.object(capId),
                    tx2.pure(address)
                ]
            });

            const result2 = await client.devInspectTransactionBlock({
                transactionBlock: tx2,
                sender: deployer.toSuiAddress(),
            });

            expect(result2.effects?.status?.status).toBe('success');
            const returnValues = result2.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues[0]).toBe(1);
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Remove blacklister
            const tx3 = new TransactionBlock();
            tx3.moveCall({
                target: `${packageId}::telebtc::remove_blacklister`,
                arguments: [
                    tx3.object(capId),
                    tx3.object(adminId),
                    tx3.pure(address)
                ]
            });

            const result3 = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx3,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result3.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify blacklister was removed
            const tx4 = new TransactionBlock();
            tx4.moveCall({
                target: `${packageId}::telebtc::is_blacklister`,
                arguments: [
                    tx4.object(capId),
                    tx4.pure(address)
                ]
            });

            const result4 = await client.devInspectTransactionBlock({
                transactionBlock: tx4,
                sender: deployer.toSuiAddress(),
            });

            expect(result4.effects?.status?.status).toBe('success');
            const returnValues4 = result4.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues4[0]).toBe(0);
        });

        it('should not allow adding the same role twice', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const address = deployer.toSuiAddress();

            // Try to add minter role twice
            let tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::add_minter`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try to add minter role again
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::add_minter`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*6\)/) // EALREADY_HAS_ROLE
            });

            // Try to add burner role twice
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::add_burner`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try to add burner role again
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::add_burner`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*6\)/) // EALREADY_HAS_ROLE
            });

            // Try to add blacklister role twice
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::add_blacklister`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try to add blacklister role again
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::add_blacklister`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(address)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*6\)/) // EALREADY_HAS_ROLE
            });
        });

    });

    describe('Mint Operations', () => {
        it('should mint tokens', async () => {
            
            let tx = new TransactionBlock();
            const receiver = deployer.toSuiAddress();
            const amount = 1000;
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Call mint and get the returned coin
            const [mintedCoin] = tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(amount)
                ]
            });

            // Transfer the minted coin to the receiver
            tx.transferObjects([mintedCoin], tx.pure(receiver));

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            const balance = await checkBalance(client, receiver, packageId);
            expect(balance).toBe(amount);
        });

        it('should not allow non-minter to mint tokens', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const amount = 1000;

            // Call mint and get the returned coin
            const [mintedCoin] = tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(signer1.toSuiAddress()),
                    tx.pure(amount)
                ]
            });

            // Transfer the minted coin to the signer1
            tx.transferObjects([mintedCoin], tx.pure(signer1.toSuiAddress()));

            try{
                await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: signer1,
                    options: { showEffects: true, showEvents: true }
                });
            }
            catch(e){
                expect(e).toMatchObject({
                message: expect.stringMatching(/MoveAbort.*4\)/) // ENOT_MINTER
            });
            }

            // Verify balance remains unchanged
            const balance = await checkBalance(client, signer1.toSuiAddress(), packageId);
            expect(balance).toBe(0);
        });
    });

    describe('Burn Operations', () => {
        it('should not allow non-burner to burn tokens', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Mint tokens for deployer
            let tx = new TransactionBlock();
            const mintAmount = 1000;
            const [mintedCoin] = tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(deployer.toSuiAddress()),
                    tx.pure(mintAmount)
                ]
            });

            // Transfer the minted coin to deployer
            tx.transferObjects([mintedCoin], tx.pure(deployer.toSuiAddress()));

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));
            const balanceAfterMint = await checkBalance(client, deployer.toSuiAddress(), packageId);
            // Get the coin object
            const coins = await client.getCoins({
                owner: deployer.toSuiAddress(),
                coinType: `${packageId}::telebtc::TELEBTC`
            });

            // Try to burn tokens with signer1 (not a burner)
            tx = new TransactionBlock();
            const burnAmount = 500;
            const [coin] = tx.splitCoins(tx.object(coins.data[0].coinObjectId), [tx.pure(burnAmount)]);
            
            tx.moveCall({
                target: `${packageId}::telebtc::burn`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    coin
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer1,
                options: { showEffects: true, showEvents: true }
            })).rejects.toThrow();

            // Verify balance remains unchanged
            const balance = await checkBalance(client, deployer.toSuiAddress(), packageId);
            expect(balance).toBe(balanceAfterMint);
        });

        it('should allow burner to burn tokens', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const deployerAddress = deployer.toSuiAddress();

            // Get the coin object
            const coins = await client.getCoins({
                owner: deployerAddress,
                coinType: `${packageId}::telebtc::TELEBTC`
            });
            const balanceBeforeBurn = await checkBalance(client, deployerAddress, packageId);
            
            // Now deployer should be able to burn tokens
            let tx = new TransactionBlock();
            const burnAmount = 500;
            const [coin] = tx.splitCoins(tx.object(coins.data[0].coinObjectId), [tx.pure(burnAmount)]);
            
            tx.moveCall({
                target: `${packageId}::telebtc::burn`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    coin
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify balance after burning
            const balance = await checkBalance(client, deployerAddress, packageId);
            expect(balanceBeforeBurn - balance).toBe(burnAmount);
        });

        it('should not allow burning after burner role is removed', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const deployerAddress = deployer.toSuiAddress();

            // Remove burner role from deployer
            let tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::remove_burner`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(deployerAddress)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify burner role was removed
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::is_burner`,
                arguments: [
                    tx.object(capId),
                    tx.pure(deployerAddress)
                ]
            });

            result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer.toSuiAddress(),
            });

            expect(result.effects?.status?.status).toBe('success');
            let returnValues = result.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(returnValues[0]).toBe(0);

            const balanceBeforeBurn = await checkBalance(client, deployerAddress, packageId);
            // Get the coin object
            const coins = await client.getCoins({
                owner: deployerAddress,
                coinType: `${packageId}::telebtc::TELEBTC`
            });

            // Try to burn tokens again
            tx = new TransactionBlock();
            const burnAmount = 100;
            const [coin] = tx.splitCoins(tx.object(coins.data[0].coinObjectId), [tx.pure(burnAmount)]);
            
            tx.moveCall({
                target: `${packageId}::telebtc::burn`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    coin
                ]
            });
            try{
                let result = await client.signAndExecuteTransactionBlock({
                    transactionBlock: tx,
                    signer: deployer,
                    options: { showEffects: true, showEvents: true }
                });
                expect(result.effects?.status?.status).toBe('failure');
            }
            catch(e){
                expect(e).toMatchObject({
                    message: expect.stringMatching(/MoveAbort.*5\)/) // ENOT_BURNER
                });
            }

            // Verify balance remains unchanged
            const balance = await checkBalance(client, deployerAddress, packageId);
            expect(balance).toBe(balanceBeforeBurn);
        });
    },30000);

    describe('Admin Operations', () => {
        it('should not allow non-owner to change maximum mint limit', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const newLimit = 10;

            tx.moveCall({
                target: `${packageId}::telebtc::set_max_mint_limit`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(newLimit)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer1,
                options: { showEffects: true, showEvents: true }
            })).rejects.toThrow();
        });

        it('should allow owner to change maximum mint limit', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const newLimit = 10;

            tx.moveCall({
                target: `${packageId}::telebtc::set_max_mint_limit`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(newLimit)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify the new limit by reading the TeleBTCCap object
            const teleBTCCap = await client.getObject({
                id: capId,
                options: { showContent: true }
            });

            if (!teleBTCCap.data?.content || teleBTCCap.data.content.dataType !== 'moveObject') {
                throw new Error('No content in TeleBTCCap object or wrong data type');
            }

            const maxMintLimit = Number(teleBTCCap.data.content.fields.max_mint_limit);
            expect(maxMintLimit).toBe(newLimit);
        });

        it('should not allow non-owner to change epoch length', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const newEpochLength = 10;

            tx.moveCall({
                target: `${packageId}::telebtc::set_epoch_length`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(newEpochLength)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: signer1,
                options: { showEffects: true, showEvents: true }
            })).rejects.toThrow();
        });

        it('should not allow setting epoch length to zero', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const zeroEpochLength = 0;

            tx.moveCall({
                target: `${packageId}::telebtc::set_epoch_length`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(zeroEpochLength)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*8\)/) // EZERO_VALUE
            });
        });

        it('should allow owner to change epoch length', async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const newEpochLength = 10;

            tx.moveCall({
                target: `${packageId}::telebtc::set_epoch_length`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(newEpochLength)
                ]
            });

            const result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify the new epoch length by reading the TeleBTCCap object
            const teleBTCCap = await client.getObject({
                id: capId,
                options: { showContent: true }
            });

            if (!teleBTCCap.data?.content || teleBTCCap.data.content.dataType !== 'moveObject') {
                throw new Error('No content in TeleBTCCap object or wrong data type');
            }

            const epochLength = Number(teleBTCCap.data.content.fields.epoch_length);
            expect(epochLength).toBe(newEpochLength);
        });
    });
    // epoch related tests, have some issues setting up the test environment
    /* 
    describe('Mint Limit Operations', () => {
        const maxMintLimit = 100000000; // Example max mint limit
        const epochLength = 20000; // Example epoch length in milliseconds
        beforeAll(async () => {
            // add a minter role to deployer
            await new Promise(resolve => setTimeout(resolve, 1000));
            let tx = new TransactionBlock();
            const newMinter = deployer.toSuiAddress();

            tx.moveCall({
                target: `${packageId}::telebtc::add_minter`,
                arguments: [
                    tx.object(capId),
                    tx.object(adminId),
                    tx.pure(newMinter)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
        })
        it("can't mint more than maximum mint limit in one transaction", async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const tx = new TransactionBlock();
            const receiver = deployer.toSuiAddress();
            const amount = maxMintLimit * 2;

            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(amount)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*10\)/) // EMINT_LIMIT_EXCEEDED
            });
        });

        it("can't mint more than maximum mint limit in one epoch", async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            // First mint
            let tx = new TransactionBlock();
            const receiver = deployer.toSuiAddress();
            const firstAmount = maxMintLimit - 10;

            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(firstAmount)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Get and print last_epoch
            const teleBTCCap = await client.getObject({
                id: capId,
                options: { showContent: true }
            });

            if (!teleBTCCap.data?.content || teleBTCCap.data.content.dataType !== 'moveObject') {
                throw new Error('No content in TeleBTCCap object or wrong data type');
            }

            await new Promise(resolve => setTimeout(resolve, 1000));


            // Try to mint more than remaining limit
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(11)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*11\)/) // EEPOCH_MINT_LIMIT_REACHED
            });
        });

        it("after an epoch, mint rate limit will be reset", async () => {
            await new Promise(resolve => setTimeout(resolve, 60000));
            // First mint
            let tx = new TransactionBlock();
            const receiver = deployer.toSuiAddress();
            const firstAmount = maxMintLimit - 10;

            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(firstAmount)
                ]
            });

            let result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 60000));

            // Mint a small amount
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(5)
                ]
            });

            result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try to mint more than remaining limit
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(10)
                ]
            });

            await expect(client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            })).rejects.toMatchObject({
                message: expect.stringMatching(/MoveAbort.*11\)/) // EEPOCH_MINT_LIMIT_REACHED
            });

            // Advance epoch instead of waiting
            await advanceEpoch(client, deployer);
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try minting after epoch reset
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::mint`,
                arguments: [
                    tx.object(capId),
                    tx.object(treasuryCapId),
                    tx.pure(receiver),
                    tx.pure(10)
                ]
            });

            result = await client.signAndExecuteTransactionBlock({
                transactionBlock: tx,
                signer: deployer,
                options: { showEffects: true, showEvents: true }
            });

            expect(result.effects?.status?.status).toBe('success');
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Check remaining limit after reset
            tx = new TransactionBlock();
            tx.moveCall({
                target: `${packageId}::telebtc::get_remaining_mint_limit`,
                arguments: [tx.object(capId)]
            });

            result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: deployer.toSuiAddress(),
            });

            expect(result.effects?.status?.status).toBe('success');
            const returnValues = result.results?.[0]?.returnValues?.[0]?.[0] || [];
            expect(Number(returnValues[0])).toBe(maxMintLimit - 10);
        },150000);
    });
    */
});
