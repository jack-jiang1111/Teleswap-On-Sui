require('dotenv').config({path:"../../.env"});

import { expect } from "chai";
import { deployments, ethers } from "hardhat";
import { Signer, BigNumber, BigNumberish, BytesLike } from "ethers";
import { deployMockContract, MockContract } from "@ethereum-waffle/mock-contract";
import { Contract } from "@ethersproject/contracts";
import { Address } from "hardhat-deploy/types";

import { LockersProxy__factory } from "../src/types/factories/LockersProxy__factory";

import { LockersLogic__factory } from "../src/types/factories/LockersLogic__factory";
import { LockersLogicLibraryAddresses } from "../src/types/factories/LockersLogic__factory";

import { LockersLib } from "../src/types/LockersLib";
import { LockersLib__factory } from "../src/types/factories/LockersLib__factory";

import { TeleBTC } from "../src/types/TeleBTC";
import { TeleBTC__factory } from "../src/types/factories/TeleBTC__factory";
import { ERC20 } from "../src/types/ERC20";
import { Erc20__factory } from "../src/types/factories/Erc20__factory";


import { advanceBlockWithTime, takeSnapshot, revertProvider } from "./block_utils";

describe("Lockers", async () => {

    let snapshotId: any;

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    let telePortTokenInitialSupply = BigNumber.from(10).pow(18).mul(10000);
    let minRequiredTDTLockedAmount = BigNumber.from(10).pow(18).mul(500);
    let minRequiredNativeTokenLockedAmount = BigNumber.from(10).pow(18).mul(5);
    let btcAmountToSlash = BigNumber.from(10).pow(8).mul(1)
    let collateralRatio = 20000;
    let liquidationRatio = 15000;
    const LOCKER_PERCENTAGE_FEE = 20; // Means %0.2
    const PRICE_WITH_DISCOUNT_RATIO = 9500; // Means %95
    const INACTIVATION_DELAY = 10000;

    // Bitcoin public key (32 bytes)
    let LOCKER1 = '0x03789ed0bb717d88f7d321a368d905e7430207ebbd82bd342cf11ae157a7ace5fd';
    let LOCKER1_PUBKEY__HASH = '0x4062c8aeed4f81c2d73ff854a2957021191e20b6';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 1; // P2PKH

    let REQUIRED_LOCKED_AMOUNT =  1000; // amount of required TDT

    // Accounts
    let proxyAdmin: Signer;
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let ccBurnSimulator: Signer;
    let proxyAdminAddress: Address;
    let deployerAddress: Address;
    let signer1Address: Address;
    let signer2Address: Address;
    let ccBurnSimulatorAddress: Address;

    // Contracts
    let lockersLib: LockersLib;
    let lockers: Contract;
    let lockers2: Contract;
    let lockersAsAdmin: Contract;
    let teleportDAOToken: ERC20;
    let teleBTC: TeleBTC;

    // Mock contracts
    let mockExchangeConnector: MockContract;
    let mockPriceOracle: MockContract;
    let mockCCBurnRouter: MockContract;

    before(async () => {
        // Sets accounts
        [proxyAdmin, deployer, signer1, signer2,ccBurnSimulator] = await ethers.getSigners();
        proxyAdminAddress = await proxyAdmin.getAddress()
        deployerAddress = await deployer.getAddress();
        signer1Address = await signer1.getAddress();
        signer2Address = await signer2.getAddress();
        ccBurnSimulatorAddress = await ccBurnSimulator.getAddress();

        teleportDAOToken = await deployTelePortDaoToken()

        // Mocks exchange router contract
        const exchangeConnectorContract = await deployments.getArtifact(
            "IExchangeConnector"
        );
        mockExchangeConnector = await deployMockContract(
            deployer,
            exchangeConnectorContract.abi
        );

        const priceOracleContract = await deployments.getArtifact(
            "IPriceOracle"
        );
        mockPriceOracle = await deployMockContract(
            deployer,
            priceOracleContract.abi
        );

        const ccBurnRouterContract = await deployments.getArtifact(
            "BurnRouterLogic"
        );
        mockCCBurnRouter = await deployMockContract(
            deployer,
            ccBurnRouterContract.abi
        );

        // Deploys lockers contract
        lockers = await deployLockers();
        lockers2 = await deployLockers();

        teleBTC = await deployTeleBTC()

        // Initializes lockers proxy
        await lockers.initialize(
            teleBTC.address,
            teleportDAOToken.address,
            mockExchangeConnector.address,
            mockPriceOracle.address,
            ccBurnSimulatorAddress,
            minRequiredTDTLockedAmount,
            minRequiredNativeTokenLockedAmount,
            collateralRatio,
            liquidationRatio,
            LOCKER_PERCENTAGE_FEE,
            PRICE_WITH_DISCOUNT_RATIO
        )

        // Sets ccBurnRouter address
        // await lockers.setCCBurnRouter(ccBurnSimulatorAddress)

        await teleBTC.addMinter(deployerAddress)

        await teleBTC.addMinter(lockers.address)
        await teleBTC.addBurner(lockers.address)

        // lockersAsAdmin = await lockers.connect(proxyAdmin)

        // await lockers.setTeleBTC(teleBTC.address)

    });

    beforeEach(async () => {
        // Takes snapshot
        snapshotId = await takeSnapshot(deployer.provider);
    });

    afterEach(async () => {
        // Reverts the state
        await revertProvider(deployer.provider, snapshotId);
    });

    async function getTimestamp(): Promise<number> {
        let lastBlockNumber = await ethers.provider.getBlockNumber();
        let lastBlock = await ethers.provider.getBlock(lastBlockNumber);
        return lastBlock.timestamp;
    }


    const deployTeleBTC = async (
        _signer?: Signer
    ): Promise<TeleBTC> => {
        const teleBTCFactory = new TeleBTC__factory(
            _signer || deployer
        );

        const wrappedToken = await teleBTCFactory.deploy(
            "TeleBTC",
            "TBTC",
            // ONE_ADDRESS,
            // ONE_ADDRESS,
            // ONE_ADDRESS
        );

        return wrappedToken;
    };

    const deployLockersLib = async (
        _signer?: Signer
    ): Promise<LockersLib> => {
        const LockersLibFactory = new LockersLib__factory(
            _signer || deployer
        );

        const lockersLib = await LockersLibFactory.deploy(
        );

        return lockersLib;
    };


    const deployLockers = async (
        _signer?: Signer
    ): Promise<Contract> => {

        lockersLib = await deployLockersLib()

        let linkLibraryAddresses: LockersLogicLibraryAddresses;

        linkLibraryAddresses = {
            "contracts/libraries/LockersLib.sol:LockersLib": lockersLib.address,
        };

        // Deploys lockers logic
        const lockersLogicFactory = new LockersLogic__factory(
            linkLibraryAddresses,
            _signer || deployer
        );

        const lockersLogic = await lockersLogicFactory.deploy();

        // Deploys lockers proxy
        const lockersProxyFactory = new LockersProxy__factory(
            _signer || deployer
        );
        const lockersProxy = await lockersProxyFactory.deploy(
            lockersLogic.address,
            proxyAdminAddress,
            "0x"
        )

        const lockers = await lockersLogic.attach(
            lockersProxy.address
        );

        return lockers;
    };


    describe("#liquidateLocker", async () => {

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("liquidate locker reverts when the target address is not locker", async function () {
            let lockerCCBurnSimulator = lockers.connect(ccBurnSimulator)

            await expect(
                lockerCCBurnSimulator.liquidateLocker(
                    signer1Address,
                    1000
                )
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("can't liquidate because it's above liquidation ratio", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await teleportDAOToken.transfer(signer1Address, minRequiredTDTLockedAmount)

            let teleportDAOTokenSigner1 = teleportDAOToken.connect(signer1)

            await teleportDAOTokenSigner1.approve(lockers.address, minRequiredTDTLockedAmount)

            let lockerSigner1 = lockers.connect(signer1)

            await lockerSigner1.requestToBecomeLocker(
                // LOCKER1,
                LOCKER1_PUBKEY__HASH,
                minRequiredTDTLockedAmount,
                minRequiredNativeTokenLockedAmount,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                {value: minRequiredNativeTokenLockedAmount}
            );

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, 5000000);

            await expect(
                lockerSigner2.liquidateLocker(signer1Address, 5000)
            ).to.be.revertedWith("Lockers: is healthy")

        });

        it("successfully liquidate the locker", async function () {

            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(8000);

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await teleportDAOToken.transfer(signer1Address, minRequiredTDTLockedAmount)

            let teleportDAOTokenSigner1 = teleportDAOToken.connect(signer1)

            await teleportDAOTokenSigner1.approve(lockers.address, minRequiredTDTLockedAmount)

            let lockerSigner1 = lockers.connect(signer1)

            await lockerSigner1.requestToBecomeLocker(
                // LOCKER1,
                LOCKER1_PUBKEY__HASH,
                minRequiredTDTLockedAmount,
                minRequiredNativeTokenLockedAmount,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                {value: minRequiredNativeTokenLockedAmount}
            );

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, 25000000);


            let teleBTCSigner2 = await teleBTC.connect(signer2);

            await teleBTCSigner2.approve(lockers.address, 13300000 + 1) // add 1 bcz of precision loss

            let signer2NativeTokenBalanceBefore = await teleBTC.provider.getBalance(signer2Address)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(7000000);

            await expect(
                await lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(2)
                )
            ).to.emit(lockerSigner2, "LockerLiquidated")
            

            let signer2NativeTokenBalanceAfter = await teleBTC.provider.getBalance(signer2Address)

            expect(
                signer2NativeTokenBalanceAfter.sub(signer2NativeTokenBalanceBefore)
            ).to.be.closeTo(BigNumber.from(10).pow(18).mul(2), BigNumber.from(10).pow(15).mul(1))


        });

    });


})