const CC_BURN_REQUESTS = require('./test_fixtures/ccBurnRequests.json');
require('dotenv').config({path:"../../.env"});


describe("BurnRouter", async () => {
    let snapshotId: any;

    // Accounts
    let proxyAdmin: Signer;
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let signer1Address: Address;
    let deployerAddress: Address;
    let proxyAdminAddress: Address;

    // Contracts
    let teleBTC: TeleBTC;
    let inputToken: ERC20;
    let inputTokenSigner1: ERC20;
    let TeleBTCSigner1: TeleBTC;
    let burnRouterLib: BurnRouterLib;
    let burnRouter: Contract;
    let burnRouterSigner1: Contract;
    let burnRouterSigner2: Contract;

    // Mock contracts
    let mockBitcoinRelay: MockContract;
    let mockLockers: MockContract;
    let mockExchangeConnector: MockContract;

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    let oneHundred = BigNumber.from(10).pow(8).mul(100)
    /*
        This one is set so that:
        userRequestedAmount * (1 - lockerFee / 10000 - PROTOCOL_PERCENTAGE_FEE / 10000) - BITCOIN_FEE = 100000000
    */
    let userRequestedAmount = BigNumber.from(100060030);
    let TRANSFER_DEADLINE = 20
    let PROTOCOL_PERCENTAGE_FEE = 5 // means 0.05%
    let SLASHER_PERCENTAGE_REWARD = 5 // means 0.05%
    let BITCOIN_FEE = 10000 // estimation of Bitcoin transaction fee in Satoshi
    let TREASURY = "0x0000000000000000000000000000000000000002";

    let LOCKER_TARGET_ADDRESS = ONE_ADDRESS;
    let LOCKER1_LOCKING_SCRIPT = '0x76a914748284390f9e263a4b766a75d0633c50426eb87587ac';

    let USER_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let USER_SCRIPT_P2PKH_TYPE = 1; // P2PKH

    let USER_SCRIPT_P2WPKH = "0x751e76e8199196d454941c45d1b3a323f1433bd6";
    let USER_SCRIPT_P2WPKH_TYPE = 3; // P2WPKH





    describe("#ccExchangeAndBurn", async () => {

        let inputTokenAmount = 100;
        let lastSubmittedHeight = 100;
        let protocolFee = Math.floor(userRequestedAmount.toNumber() * PROTOCOL_PERCENTAGE_FEE / 10000);
        let _burntAmount = userRequestedAmount.toNumber() - protocolFee;
        let burntAmount = _burntAmount * (_burntAmount - BITCOIN_FEE) / _burntAmount; 
        // ^ burntAmount should be (burntAmount - lockerFee) but here we assumed lockerFee = 0

        beforeEach(async () => {
            // Sends teleBTC to burnRouter (since we mock swap)
            await TeleBTCSigner1.transfer(
                burnRouter.address,
                userRequestedAmount
            );

            // Sends some inputToken to signer1 then he gives allowance to burnRouter
            await inputToken.transfer(
                signer1Address,
                inputTokenAmount
            );
            await inputTokenSigner1.approve(
                burnRouter.address,
                inputTokenAmount
            );

            // Sets mock contracts outputs
            await setRelayLastSubmittedHeight(lastSubmittedHeight);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();
            await setLockersBurnReturn(_burntAmount); // Sets amount of teleBTC that user receives on Bitcoin

            snapshotId = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Exchanges input token for teleBTC then burns it", async function () {

            let prevBalanceSigner1 = await inputToken.balanceOf(signer1Address);

            await setSwap(true, [inputTokenAmount, userRequestedAmount.toNumber()])

            // Exchanges input token then burns teleBTC
            expect(
                await burnRouterSigner1.ccExchangeAndBurn(
                    mockExchangeConnector.address,
                    [inputTokenAmount, userRequestedAmount],
                    false, // output token amount is fixed
                    [inputToken.address, teleBTC.address], // exchange path
                    10000000000, // deadline
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.emit(burnRouter, "CCBurn").withArgs(
                signer1Address,
                USER_SCRIPT_P2PKH,
                USER_SCRIPT_P2PKH_TYPE,
                inputTokenAmount,
                inputToken.address,
                userRequestedAmount,
                burntAmount, 
                ONE_ADDRESS,
                0,
                lastSubmittedHeight + TRANSFER_DEADLINE
            );

            let newBalanceSigner1 = await inputToken.balanceOf(signer1Address);

            // Checks user's balance
            expect(
                await newBalanceSigner1
            ).to.equal(prevBalanceSigner1.sub(inputTokenAmount));

            // Checks that protocol fee has been received
            expect(
                await teleBTC.balanceOf(TREASURY)
            ).to.equal(protocolFee);

            // Gets the burn request that has been saved in the contract
            let theBurnRequest = await burnRouter.burnRequests(LOCKER_TARGET_ADDRESS, 0);

            expect(
                theBurnRequest.burntAmount
            ).to.equal(burntAmount);

        })

        it("Reverts since exchange path is invalid", async function () {
            await expect(
                burnRouterSigner1.ccExchangeAndBurn(
                    mockExchangeConnector.address,
                    [inputTokenAmount, userRequestedAmount],
                    false, // output token amount is fixed
                    [inputToken.address, inputToken.address], // exchange path
                    10000000000, // deadline
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: invalid path");
        })

        it("Reverts since amounts is wrong", async function () {
            await expect(
                burnRouterSigner1.ccExchangeAndBurn(
                    mockExchangeConnector.address,
                    [inputTokenAmount, userRequestedAmount, userRequestedAmount],
                    false, // output token amount is fixed
                    [inputToken.address, teleBTC.address], // exchange path
                    10000000000, // deadline
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: wrong amounts");
        })

        it("Reverts since exchange failed", async function () {
            await setSwap(false, [inputTokenAmount, userRequestedAmount.toNumber()])
            await expect(
                burnRouterSigner1.ccExchangeAndBurn(
                    mockExchangeConnector.address,
                    [inputTokenAmount, userRequestedAmount],
                    false, // output token amount is fixed
                    [inputToken.address, teleBTC.address], // exchange path
                    10000000000, // deadline
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: exchange failed");
        })

        it("Reverts since exchanged teleBTC is low", async function () {
            await setSwap(true, [inputTokenAmount, 2 * BITCOIN_FEE - 1])
            await expect(
                burnRouterSigner1.ccExchangeAndBurn(
                    mockExchangeConnector.address,
                    [inputTokenAmount, userRequestedAmount],
                    false, // output token amount is fixed
                    [inputToken.address, teleBTC.address], // exchange path
                    10000000000, // deadline
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: low amount");
        })

    });

    describe("#setters", async () => {

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Sets protocol percentage fee", async function () {
            await expect(
                burnRouter.setProtocolPercentageFee(100)
            ).to.emit(
                burnRouter, "NewProtocolPercentageFee"
            ).withArgs(PROTOCOL_PERCENTAGE_FEE, 100);

            expect(
                await burnRouter.protocolPercentageFee()
            ).to.equal(100);
        })

        it("Reverts since protocol percentage fee is greater than 10000", async function () {
            await expect(
                burnRouter.setProtocolPercentageFee(10001)
            ).to.revertedWith("BurnRouter: invalid fee");
        })

        it("Sets transfer deadline", async function () {

            await mockBitcoinRelay.mock.finalizationParameter.returns(10);

            await expect(
                burnRouter.setTransferDeadline(100)
            ).to.emit(
                burnRouter, "NewTransferDeadline"
            ).withArgs(TRANSFER_DEADLINE, 100);


            expect(
                await burnRouter.transferDeadline()
            ).to.equal(100);
        })

        it("Reverts since transfer deadline is smaller than relay finalizatio parameter", async function () {
            await mockBitcoinRelay.mock.finalizationParameter.returns(10);

            await expect(
                burnRouter.setTransferDeadline(9)
            ).to.revertedWith("BurnRouter: low deadline");

        })

        it("Reverts since transfer deadline is smaller than relay finalizatio parameter", async function () {
            await mockBitcoinRelay.mock.finalizationParameter.returns(10);

            await expect(
                burnRouter.setTransferDeadline(10)
            ).to.revertedWith("BurnRouter: low deadline");

        })

        it("Sets slasher reward", async function () {
            await expect(
                burnRouter.setSlasherPercentageReward(100)
            ).to.emit(
                burnRouter, "NewSlasherPercentageFee"
            ).withArgs(SLASHER_PERCENTAGE_REWARD, 100);

            expect(
                await burnRouter.slasherPercentageReward()
            ).to.equal(100);
        })

        it("Reverts since slasher reward is greater than 100", async function () {
            await expect(
                burnRouter.setSlasherPercentageReward(10001)
            ).to.revertedWith("BurnRouter: invalid reward");
        })

        it("Sets bitcoin fee", async function () {
            await expect(
                burnRouter.setBitcoinFee(100)
            ).to.emit(
                burnRouter, "NewBitcoinFee"
            ).withArgs(BITCOIN_FEE, 100);


            expect(
                await burnRouter.bitcoinFee()
            ).to.equal(100);
        })

    });

});