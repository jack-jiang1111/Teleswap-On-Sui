import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { fromB64 } from '@mysten/sui.js/utils';
import { PackageManager } from '../helper/package_manager';
import { hexToBytes,printEvents } from '../../tests/utils/utils';

// Network configuration
export enum Network {
  TESTNET = 'testnet',
  MAINNET = 'mainnet',
  DEVNET = 'devnet',
  LOCAL = 'local'
}

// Network URLs
const NETWORK_URLS = {
  [Network.TESTNET]: getFullnodeUrl('testnet'),
  [Network.MAINNET]: getFullnodeUrl('mainnet'),
  [Network.DEVNET]: getFullnodeUrl('devnet'),
  [Network.LOCAL]: 'http://localhost:9000'
};

// SDK Configuration
export interface SDKConfig {
  network: Network;
  privateKey?: string; // Base64 encoded private key
  keypair?: Ed25519Keypair; // Direct keypair instance
  packageManager?: PackageManager;
}

// Function call result
export interface FunctionCallResult {
  digest: string;
  success: boolean;
  error?: string;
  effects?: any;
}

// Burn proof data structure
export interface BurnProofData {
  txId: string;
  outputIndex: number;
  merkleProof: string[];
  blockHeader: string;
  blockHeight: number;
}

// Swap parameters
export interface SwapParams {
  inputCoinType: string;
  outputCoinType: string;
  inputAmount: string;
  minOutputAmount: string;
  slippageTolerance?: number; // in basis points (e.g., 300 = 3%)
}

// Wrap parameters
export interface WrapParams {
  inputCoinType: string;
  outputCoinType: string;
  amount: string;
  recipient?: string;
}

// Header data for BTC relay
export interface HeaderData {
  header: string;
  height: number;
  work: string;
}

// cc_transfer wrap parameters (matches tests/transfer.test.ts)
export interface WrapCcTransferParams {
  versionHex: string;
  vinHex: string;
  voutHex: string;
  locktimeHex: string;
  blockNumber: number;
  intermediateNodesHex: string;
  index: number;
  lockerLockingScriptHex: string;
}

export class TeleSwapSDK {
  private client: SuiClient;
  private keypair: Ed25519Keypair | null = null;
  private packageManager: PackageManager;
  private network: Network;

  constructor(config: SDKConfig) {
    this.network = config.network;
    this.client = new SuiClient({ url: NETWORK_URLS[config.network] });
    this.packageManager = config.packageManager || new PackageManager();
    
    if (config.keypair) {
      this.keypair = config.keypair;
    } else if (config.privateKey) {
      this.setKeypair(config.privateKey);
    }
  }

  /**
   * Set the keypair for signing transactions
   */
  setKeypair(privateKey: string): void {
    const keypairBytes = fromB64(privateKey);
    this.keypair = Ed25519Keypair.fromSecretKey(keypairBytes);
  }

  /**
   * Get the current active address
   */
  getActiveAddress(): string {
    if (!this.keypair) {
      throw new Error('Keypair not set. Call setKeypair() first.');
    }
    return this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Get package IDs for the current network
   */
  private getPackageIds() {
    const mainPkg = this.packageManager.getMainPackage(
      this.network === Network.MAINNET ? 'mainnet' : 'testnet'
    );
    const btcrelay = this.packageManager.getBtcrelay();
    const mockTokens = this.packageManager.getMockTokens();
    const telebtc = this.packageManager.getTelebtc();
    const adminCaps = this.packageManager.getAdminCaps();
    const initializedObjects = this.packageManager.getInitializedObjects();

    return {
      mainPackageId: mainPkg.packageId,
      btcrelayPackageId: btcrelay.packageId,
      btcrelayRelayId: btcrelay.relayId,
      mockTokens,
      telebtc,
      adminCaps,
      initializedObjects,
    };
  }

  /**
   * Execute a transaction and return the result
   */
  private async executeTransaction(tx: TransactionBlock): Promise<FunctionCallResult> {
    if (!this.keypair) {
      throw new Error('Keypair not set. Call setKeypair() first.');
    }

    try {
      const result = await this.client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: this.keypair,
        options: {
          showEffects: true,
          showObjectChanges: true,
        }
      });

      return {
        digest: result.digest,
        success: result.effects?.status?.status === 'success',
        error: result.effects?.status?.error,
        effects: result.effects
      };
    } catch (error) {
      return {
        digest: '',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // ============================================================================
  // BURN ROUTER FUNCTIONS
  // ============================================================================

  /**
   * Unwrap tokens from wrapped state
   */
  async unwrap(
    coinObjectId: string,
    userScript: string,
    scriptType: number,
    lockerLockingScript: string,
    thirdParty: number = 0,
    recipient?: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    const targetAddress = recipient || this.getActiveAddress();
    
    // Call unwrap function with correct arguments
    tx.moveCall({
      target: `${packageIds.mainPackageId}::burn_router_logic::unwrap`,
      arguments: [
        tx.object(packageIds.initializedObjects.burnRouterId),
        tx.object(coinObjectId), // amount_coin (Coin<TELEBTC>)
        tx.pure(hexToBytes(userScript)), // user_script (vector<u8>)
        tx.pure(scriptType), // script_type (u8)
        tx.pure(hexToBytes(lockerLockingScript)), // locker_locking_script (vector<u8>)
        tx.pure(thirdParty), // third_party (u64)
        tx.object(packageIds.telebtc.capId), // &mut TeleBTCCap
        tx.object(packageIds.telebtc.treasuryCapId), // &mut TreasuryCap<TELEBTC>
        tx.object(packageIds.btcrelayRelayId), // &BTCRelay
        tx.object(packageIds.initializedObjects.lockerCapId) // &mut LockerCap
      ]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Swap and unwrap tokens
   */
  async swapAndUnwrap(
    amounts: number[],
    userScript: string,
    scriptType: number,
    lockerLockingScript: string,
    thirdParty: number = 0,
    inputCoinIds: {
      wbtc?: string[],
      sui?: string[],
      usdt?: string[],
      usdc?: string[]
    },
    recipient?: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    const targetAddress = recipient || this.getActiveAddress();
    
    // Get pool IDs from package manager
    const pools = this.packageManager.getCetusPools();
    const poolUsdcSui = pools['USDC-SUI'];
    const poolUsdcUsdt = pools['USDC-USDT'];
    const poolUsdcWbtc = pools['USDC-BTC'];
    const poolTelebtcWbtc = pools['TELEBTC-BTC'];
    
    if (!poolUsdcSui || !poolUsdcUsdt || !poolUsdcWbtc || !poolTelebtcWbtc) {
      throw new Error('Pool IDs not found in package manager');
    }
    
    const configId = "0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e";
    const clockId = "0x6";
    
    // Prepare coin objects
    const wbtcCoins = (inputCoinIds.wbtc || []).map(id => tx.object(id));
    const suiCoins = (inputCoinIds.sui || []).map(id => tx.object(id));
    const usdtCoins = (inputCoinIds.usdt || []).map(id => tx.object(id));
    const usdcCoins = (inputCoinIds.usdc || []).map(id => tx.object(id));
    
    // Call swap_and_unwrap function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::burn_router_logic::swap_and_unwrap`,
      arguments: [
        tx.object(packageIds.initializedObjects.burnRouterId),
        tx.pure(amounts), // amounts (vector<u64>)
        tx.pure(hexToBytes(userScript)), // user_script (vector<u8>)
        tx.pure(scriptType), // script_type (u8)
        tx.pure(hexToBytes(lockerLockingScript)), // locker_locking_script (vector<u8>)
        tx.pure(thirdParty), // third_party (u64)
        tx.object(configId), // config: &GlobalConfig
        tx.object(poolUsdcSui), // pool_usdc_sui: &mut Pool<USDC, SUI>
        tx.object(poolUsdcUsdt), // pool_usdc_usdt: &mut Pool<USDC, USDT>
        tx.object(poolUsdcWbtc), // pool_usdc_wbtc: &mut Pool<USDC, BTC>
        tx.object(poolTelebtcWbtc), // pool_telebtc_wbtc: &mut Pool<TELEBTC, BTC>
        tx.pure(wbtcCoins), // wbtc_coins: vector<Coin<BTC>>
        tx.pure(suiCoins), // sui_coins: vector<Coin<SUI>>
        tx.pure(usdtCoins), // usdt_coins: vector<Coin<USDT>>
        tx.pure(usdcCoins), // usdc_coins: vector<Coin<USDC>>
        tx.object(packageIds.telebtc.capId), // telebtc_cap: &mut TeleBTCCap
        tx.object(packageIds.telebtc.treasuryCapId), // treasury_cap: &mut TreasuryCap<TELEBTC>
        tx.object(packageIds.btcrelayRelayId), // btcrelay: &BTCRelay
        tx.object(packageIds.initializedObjects.lockerCapId), // locker_cap: &mut LockerCap
        tx.object(clockId) // clock: &Clock
      ]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Burn proof verification and token minting
   */
  async burnProof(
    version: string,
    vin: string,
    vout: string,
    locktime: string,
    blockNumber: number,
    intermediateNodes: string,
    index: number,
    lockerLockingScript: string,
    burnReqIndexes: number[],
    voutIndexes: number[]
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    // Call burn_proof function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::burn_router_logic::burn_proof`,
      arguments: [
        tx.object(packageIds.initializedObjects.burnRouterId),
        tx.object(packageIds.btcrelayRelayId),
        tx.pure(hexToBytes(version)), // version (vector<u8>)
        tx.pure(hexToBytes(vin)), // vin (vector<u8>)
        tx.pure(hexToBytes(vout)), // vout (vector<u8>)
        tx.pure(hexToBytes(locktime)), // locktime (vector<u8>)
        tx.pure(blockNumber), // block_number (u64)
        tx.pure(hexToBytes(intermediateNodes)), // intermediate_nodes (vector<u8>)
        tx.pure(index), // index (u64)
        tx.pure(hexToBytes(lockerLockingScript)), // locker_locking_script (vector<u8>)
        tx.pure(burnReqIndexes), // burn_req_indexes (vector<u64>)
        tx.pure(voutIndexes), // vout_indexes (vector<u64>)
        tx.object(packageIds.initializedObjects.lockerCapId) // locker_cap: &mut LockerCap
      ]
    });

    return this.executeTransaction(tx);
  }

  // ============================================================================
  // CC EXCHANGE FUNCTIONS
  // ============================================================================

  /**
   * Wrap-and-swap: builds TxAndProof and calls cc_exchange_logic::wrap_and_swap
   * Required params mirror wrap() plus locker locking script
   */
  async wrapAndSwap(
    params: WrapCcTransferParams
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    // 1) Build TxAndProof (same as wrap())
    const txAndProof = tx.moveCall({
      target: `${packageIds.mainPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
      arguments: [
        tx.pure(hexToBytes(params.versionHex)),
        tx.pure(hexToBytes(params.vinHex)),
        tx.pure(hexToBytes(params.voutHex)),
        tx.pure(hexToBytes(params.locktimeHex)),
        tx.pure(params.blockNumber),
        tx.pure(hexToBytes(params.intermediateNodesHex)),
        tx.pure(params.index),
      ],
      typeArguments: [],
    });

    // 2) Resolve required objects from PackageManager
    const pools = this.packageManager.getCetusPools();
    const poolUsdcSuiId = pools['USDC-SUI'];
    const poolUsdcUsdtId = pools['USDC-USDT'];
    const poolUsdcWbtcId = pools['USDC-BTC'];
    const poolTelebtcWbtcId = pools['BTC-TELEBTC'];

    if (!poolUsdcSuiId || !poolUsdcUsdtId || !poolUsdcWbtcId || !poolTelebtcWbtcId) {
      throw new Error('Missing Cetus pool object ids from PackageManager');
    }

    const exchangeCapId = packageIds.initializedObjects.exchangeCapId;
    const lockerCapId = packageIds.initializedObjects.lockerCapId;
    const btcrelayId = packageIds.btcrelayRelayId;
    const telebtcCapId = packageIds.telebtc.capId;
    const telebtcTreasuryCapId = packageIds.telebtc.treasuryCapId;

    // 3) Constants for config and clock (refer scripts/testnet/test_swap_clean.ts line 79-80)
    const configId = "0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e";
    const clockId = "0x6";

    // adjust based on the pair order, the pool is either BTC-TELEBTC or TELEBTC-BTC
    const btc_telebtc_pair = false;
    // 4) Call cc_exchange_logic::wrap_and_swap or cc_exchange_logic::wrap_and_swap_reverse
    if(btc_telebtc_pair) {
      tx.moveCall({
        target: `${packageIds.mainPackageId}::cc_exchange_logic::wrap_and_swap`,
        arguments: [
          tx.object(exchangeCapId),
          tx.object(configId),
          tx.object(poolUsdcSuiId),
          tx.object(poolUsdcUsdtId),
          tx.object(poolUsdcWbtcId),
          tx.object(poolTelebtcWbtcId),
          tx.object(txAndProof),
          tx.pure(hexToBytes(params.lockerLockingScriptHex)),
          tx.object(btcrelayId),
          tx.object(lockerCapId),
          tx.object(telebtcCapId),
          tx.object(telebtcTreasuryCapId),
          tx.object(clockId),
          //tx.pure(10)
        ],
        typeArguments: [],
      });
    }
    else{
      tx.moveCall({
        target: `${packageIds.mainPackageId}::cc_exchange_logic::wrap_and_swap_reverse`,
        arguments: [
          tx.object(exchangeCapId),
          tx.object(configId),
          tx.object(poolUsdcSuiId),
          tx.object(poolUsdcUsdtId),
          tx.object(poolUsdcWbtcId),
          tx.object(poolTelebtcWbtcId),
          tx.object(txAndProof),
          tx.pure(hexToBytes(params.lockerLockingScriptHex)),
          tx.object(btcrelayId),
          tx.object(lockerCapId),
          tx.object(telebtcCapId),
          tx.object(telebtcTreasuryCapId),
          tx.object(clockId),
          //tx.pure(10)
        ],
        typeArguments: [],
      });
    }

    return this.executeTransaction(tx);
  }

  /**
   * Refund by admin (admin only function)
   */
  async refundByAdmin(
    txId: string,
    scriptType: number,
    userScript: string,
    lockerLockingScript: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    // Call refund_by_admin function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::cc_exchange_logic::refund_by_admin`,
      arguments: [
        tx.object(packageIds.initializedObjects.exchangeCapId),
        tx.pure(hexToBytes(txId)),
        tx.pure(scriptType),
        tx.pure(hexToBytes(userScript)),
        tx.pure(hexToBytes(lockerLockingScript)),
        tx.object(packageIds.adminCaps.exchangeAdminId),
        tx.object(packageIds.initializedObjects.burnRouterId),
        tx.object(packageIds.telebtc.capId),
        tx.object(packageIds.telebtc.treasuryCapId),
        tx.object(packageIds.btcrelayRelayId),
        tx.object(packageIds.initializedObjects.lockerCapId)
      ],
      typeArguments: []
    });

    return this.executeTransaction(tx);
  }

  // ============================================================================
  // CC TRANSFER ROUTER FUNCTIONS
  // ============================================================================

  /**
   * Wrap (cc_transfer) - constructs TxAndProof then calls wrap, matching tests/transfer.test.ts
   */
  async wrap(
    params: WrapCcTransferParams
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();

    // Create TxAndProof object
    const txAndProof = tx.moveCall({
      target: `${packageIds.mainPackageId}::cc_transfer_router_storage::create_tx_and_proof`,
      arguments: [
        tx.pure(hexToBytes(params.versionHex)),
        tx.pure(hexToBytes(params.vinHex)),
        tx.pure(hexToBytes(params.voutHex)),
        tx.pure(hexToBytes(params.locktimeHex)),
        tx.pure(params.blockNumber),
        tx.pure(hexToBytes(params.intermediateNodesHex)),
        tx.pure(params.index),
      ],
      typeArguments: [],
    });

    // Resolve required object ids from PackageManager
    const ccTransferRouterId = packageIds.initializedObjects.ccTransferRouterId;
    const lockerCapabilityId = packageIds.initializedObjects.lockerCapId;
    // For btcrelay, some calls accept the relay/shared id or the package id as input
    const btcrelayId = packageIds.btcrelayRelayId;
    const telebtcCapId = packageIds.telebtc.capId;
    const telebtcTreasuryCapId = packageIds.telebtc.treasuryCapId;

    // Call wrap
    tx.moveCall({
      target: `${packageIds.mainPackageId}::cc_transfer_router_logic::wrap`,
      arguments: [
        tx.object(ccTransferRouterId),
        tx.object(txAndProof),
        tx.pure(hexToBytes(params.lockerLockingScriptHex)),
        tx.object(lockerCapabilityId),
        tx.object(btcrelayId),
        tx.object(telebtcCapId),
        tx.object(telebtcTreasuryCapId),
        tx.object('0x6')
      ],
      typeArguments: [],
    });

    return this.executeTransaction(tx);
  }

  /**
   * Request to become a locker.
   * The caller must provide a coin object id (e.g., WBTC coin object) and the locking scripts.
   */
  async requestToBecomeLocker(params: {
    // Request an exact amount by coin type; SDK will merge/split
    coinType: string;
    amount: string | bigint;
    lockerLockingScriptHashHex: string;
    lockerScriptType: number;
    lockerRescueScriptHex: string;
  }): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();

    // Build exact Coin<T> from coinType and amount
    const { coinArg } = await this.buildExactCoin(tx, {
      coinType: params.coinType,
      amount: params.amount,
    });

    tx.moveCall({
      target: `${packageIds.mainPackageId}::lockermanager::request_to_become_locker`,
      arguments: [
        tx.object(packageIds.initializedObjects.lockerCapId),
        tx.pure(hexToBytes(params.lockerLockingScriptHashHex)),
        coinArg,
        tx.pure(params.lockerScriptType),
        tx.pure(hexToBytes(params.lockerRescueScriptHex))
      ]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Add locker (admin function). Requires lockerAdminCap on the deployer address.
   */
  async addLocker(params: {
    newLockerAddress: string;
    reliabilityFactor: number;
  }): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();

    tx.moveCall({
      target: `${packageIds.mainPackageId}::lockermanager::add_locker`,
      arguments: [
        tx.object(packageIds.adminCaps.lockerAdminCapId),
        tx.object(packageIds.initializedObjects.lockerCapId),
        tx.pure(params.newLockerAddress),
        tx.pure(params.reliabilityFactor)
      ]
    });

    return this.executeTransaction(tx);
  }

  // ============================================================================
  // QUOTE AND SWAP FUNCTIONS
  // ============================================================================

  /**
   * Get quote for trading TELEBTC
   * Requires either inputToken or outputToken to contain "telebtc"
   * Returns [success: boolean, outputAmount: number]
   */
  async getQuote(
    inputToken: string,
    outputToken: string,
    inputAmount: string,
    minOutputAmount: string
  ): Promise<[boolean, number]> {
    // Validate that either input or output token contains "telebtc"
    const inputIsTelebtc = inputToken == 'TELEBTC';
    const outputIsTelebtc = outputToken == 'TELEBTC';
    
    if (!inputIsTelebtc && !outputIsTelebtc) {
      throw new Error('Either inputToken or outputToken must contain "telebtc"');
    }

    // Validate supported token pairs
    const supportedTokens = ['SUI', 'USDC', 'USDT', 'WBTC'];
    if (inputIsTelebtc) {
      const isSupportedOutput = supportedTokens.some(token => outputToken == token);
      if (!isSupportedOutput) {
        throw new Error('Unsupported output token. When input is TELEBTC, output must be SUI/USDC/USDT/WBTC');
      }
    } else if (outputIsTelebtc) {
      const isSupportedInput = supportedTokens.some(token => inputToken == token);
      if (!isSupportedInput) {
        throw new Error('Unsupported input token. When output is TELEBTC, input must be SUI/USDC/USDT/WBTC');
      }
    }

    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    tx.setGasBudget(100000000);

    // Get pool IDs from package manager
    const pools = this.packageManager.getCetusPools();
    const poolUsdcSui = pools['USDC-SUI'];
    const poolUsdcUsdt = pools['USDC-USDT'];
    const poolUsdcWbtc = pools['USDC-BTC'];
    const poolTelebtcWbtc = pools['BTC-TELEBTC'];

    if (!poolUsdcSui || !poolUsdcUsdt || !poolUsdcWbtc || !poolTelebtcWbtc) {
      throw new Error('Pool IDs not found in package manager');
    }


    // Get pool objects
    const poolUsdcSuiObj = tx.object(poolUsdcSui);
    const poolUsdcUsdtObj = tx.object(poolUsdcUsdt);
    const poolUsdcWbtcObj = tx.object(poolUsdcWbtc);
    const poolTelebtcWbtcObj = tx.object(poolTelebtcWbtc);


    // Determine the correct function to call based on token types
    let functionName: string;
    let typeArguments: string[];

    // Define supported token type arguments
    const WBTC_TYPE_ARG = `${packageIds.mockTokens.btc.packageId}::btc::BTC`;
    const USDC_TYPE_ARG = `${packageIds.mockTokens.usdc.packageId}::usdc::USDC`;
    const SUI_TYPE_ARG = `0x2::sui::SUI`;
    const USDT_TYPE_ARG = `${packageIds.mockTokens.usdt.packageId}::usdt::USDT`;

    if (inputIsTelebtc) {
      // Selling TELEBTC for outputToken
      functionName = 'getQuoteSellTelebtc_rev';
      // Determine correct type argument based on outputToken
      if (outputToken == 'WBTC') {
        typeArguments = [WBTC_TYPE_ARG];
      } else if (outputToken == 'USDC') {
        typeArguments = [USDC_TYPE_ARG];
      } else if (outputToken == 'SUI') {
        typeArguments = [SUI_TYPE_ARG];
      } else if (outputToken == 'USDT') {
        typeArguments = [USDT_TYPE_ARG];
      } else {
        throw new Error('Unsupported output token type for quote');
      }
    } else if (outputIsTelebtc) {
      // Buying TELEBTC with inputToken
      functionName = 'getQuoteBuyTelebtc_rev';
      // Determine correct type argument based on inputToken
      if (inputToken == 'WBTC') {
        typeArguments = [WBTC_TYPE_ARG];
      } else if (inputToken == 'USDC') {
        typeArguments = [USDC_TYPE_ARG];
      } else if (inputToken == 'SUI') {
        typeArguments = [SUI_TYPE_ARG];
      } else if (inputToken == 'USDT') {
        typeArguments = [USDT_TYPE_ARG];
      } else {
        throw new Error('Unsupported input token type for quote');
      }
    } else {
      throw new Error('Unsupported token pair for quote. Either inputToken or outputToken must contain "telebtc".');
    }

    // Call the quote function
    const [success, result] = tx.moveCall({
      target: `${packageIds.mainPackageId}::dexconnector::${functionName}`,
      typeArguments: typeArguments,
      arguments: [
        poolUsdcSuiObj,    // Pool<USDC, SUI>
        poolUsdcUsdtObj,   // Pool<USDC, USDT>
        poolUsdcWbtcObj,   // Pool<USDC, BTC>
        poolTelebtcWbtcObj, // Pool<TELEBTC, BTC>
        tx.pure.u64(inputAmount),
        tx.pure.u64(minOutputAmount),
      ],
    });

    try {
      const txResult = await this.client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: this.getActiveAddress(),
      });

      if (txResult?.effects?.status?.status === "success") {
        // Parse the return values from the Move function call
        const returnValues = txResult.results?.[0]?.returnValues;
        if (returnValues && returnValues.length >= 2) {
          // First return value: boolean (success) - format: [bytes, type]
          const successTuple = returnValues[0] as [number[], string];
          const successBytes = successTuple[0];
          const isSuccess = successBytes[0] === 1; // Convert byte array to boolean
          
          // Second return value: u64 (output amount) - format: [bytes, type]
          const outputAmountTuple = returnValues[1] as [number[], string];
          const outputAmountBytes = outputAmountTuple[0];
          // Convert little-endian byte array to BigInt, then to string
          const outputAmount = Buffer.from(outputAmountBytes).readBigUInt64LE(0).toString();
          
          return [isSuccess, parseInt(outputAmount)];
        } else {
          throw new Error('Failed to parse quote return values');
        }
      } else {
        throw new Error(txResult?.effects?.status?.error || 'Quote transaction failed');
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Unknown error during quote');
    }
  }


  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  /**
   * Get coin balance for a specific coin type
   */
  async getCoinBalance(coinType: string, address?: string): Promise<string> {
    const targetAddress = address || this.getActiveAddress();
    
    const coins = await this.client.getCoins({
      owner: targetAddress,
      coinType: coinType
    });

    return coins.data.reduce((total, coin) => {
      return total + parseInt(coin.balance);
    }, 0).toString();
  }

  /**
   * Get all coin balances for an address
   */
  async getAllCoinBalances(address?: string): Promise<Record<string, string>> {
    const targetAddress = address || this.getActiveAddress();
    const balances: Record<string, string> = {};
    
    const coins = await this.client.getCoins({
      owner: targetAddress
    });

    coins.data.forEach(coin => {
      const coinType = coin.coinType;
      if (!balances[coinType]) {
        balances[coinType] = '0';
      }
      balances[coinType] = (parseInt(balances[coinType]) + parseInt(coin.balance)).toString();
    });

    return balances;
  }

  /**
   * Get package information
   */
  getPackageInfo() {
    return this.getPackageIds();
  }

  /**
   * Get current network
   */
  getNetwork(): Network {
    return this.network;
  }

  /**
   * Get the SuiClient instance
   */
  getClient(): SuiClient {
    return this.client;
  }

  /**
   * Initialize the SDK (placeholder for future initialization logic)
   */
  async initialize(): Promise<void> {
    // SDK is already initialized in constructor
    // This method is kept for compatibility
    return Promise.resolve();
  }

  /**
   * Switch network
   */
  switchNetwork(network: Network): void {
    this.network = network;
    this.client = new SuiClient({ url: NETWORK_URLS[network] });
  }
  /**
   * Build an exact-amount Coin<T> for use inside a TransactionBlock.
   * - For non-SUI coin types: merges owned coins as needed, then splits out the exact amount.
   * - For SUI: splits from tx.gas directly.
   * Returns the TransactionArgument representing the Coin<T> of the requested amount.
   */
  async buildExactCoin(
    tx: TransactionBlock,
    params: { coinType: string; amount: string | bigint; ownerAddress?: string }
  ): Promise<{ coinArg: any }> {
    const amountBig = typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount);
    const owner = params.ownerAddress || this.getActiveAddress();

    // SUI case: split from gas directly
    if (params.coinType === '0x2::sui::SUI') {
      const coinArg = tx.splitCoins(tx.gas, [tx.pure(amountBig)]);
      return { coinArg };
    }

    // Non-SUI: fetch coins, select enough, merge then split
    const owned = await this.client.getCoins({ owner, coinType: params.coinType });
    if (!owned.data.length) {
      throw new Error(`No coins found for type ${params.coinType}`);
    }

    // Pick coins until we cover the amount
    const selected: { id: string; balance: bigint }[] = [];
    let total: bigint = BigInt(0);
    for (const c of owned.data) {
      const bal = BigInt(c.balance);
      selected.push({ id: c.coinObjectId, balance: bal });
      total += bal;
      if (total >= amountBig) break;
    }

    if (total < amountBig) {
      throw new Error(`Insufficient balance for ${params.coinType}. Have ${total}, need ${amountBig}`);
    }

    // Choose first as target, merge remaining into it
    const targetId = selected[0].id;
    const mergeIds = selected.slice(1).map(s => s.id);

    if (mergeIds.length > 0) {
      tx.mergeCoins(
        tx.object(targetId),
        mergeIds.map((id) => tx.object(id))
      );
    }

    // Split exact amount from the target
    const coinArg = tx.splitCoins(tx.object(targetId), [tx.pure(amountBig)]);
    return { coinArg };
  }
}


