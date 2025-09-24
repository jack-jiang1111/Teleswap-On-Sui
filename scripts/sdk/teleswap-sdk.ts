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
    coinType: string,
    amount: string,
    recipient?: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    const targetAddress = recipient || this.getActiveAddress();
    
    // Get the coin to unwrap
    const coin = tx.splitCoins(tx.gas, [tx.pure(amount)]);
    
    // Call unwrap function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::burn_router_logic::unwrap`,
      arguments: [
        tx.object(packageIds.initializedObjects.burnRouterId),
        coin,
        tx.pure(targetAddress)
      ],
      typeArguments: [coinType]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Swap and unwrap tokens
   */
  async swapAndUnwrap(
    swapParams: SwapParams,
    recipient?: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    const targetAddress = recipient || this.getActiveAddress();
    
    // Get input coin
    const inputCoin = tx.splitCoins(tx.gas, [tx.pure(swapParams.inputAmount)]);
    
    // Call swap_and_unwrap function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::burn_router_logic::swap_and_unwrap`,
      arguments: [
        tx.object(packageIds.initializedObjects.burnRouterId),
        inputCoin,
        tx.pure(swapParams.minOutputAmount),
        tx.pure(targetAddress)
      ],
      typeArguments: [swapParams.inputCoinType, swapParams.outputCoinType]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Burn proof verification and token minting
   */
  async burnProof(
    burnProofData: BurnProofData,
    recipient?: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    const targetAddress = recipient || this.getActiveAddress();
    
    // Call burn_proof function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::burn_router_logic::burn_proof`,
      arguments: [
        tx.object(packageIds.initializedObjects.burnRouterId),
        tx.object(packageIds.btcrelayRelayId),
        tx.pure(burnProofData.txId),
        tx.pure(burnProofData.outputIndex),
        tx.pure(burnProofData.merkleProof),
        tx.pure(burnProofData.blockHeader),
        tx.pure(burnProofData.blockHeight),
        tx.pure(targetAddress)
      ]
    });

    return this.executeTransaction(tx);
  }

  // ============================================================================
  // CC EXCHANGE FUNCTIONS
  // ============================================================================

  /**
   * Wrap tokens and perform swap
   */
  async wrapAndSwap(
    wrapParams: WrapParams,
    swapParams: SwapParams
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    const targetAddress = wrapParams.recipient || this.getActiveAddress();
    
    // Get input coin
    const inputCoin = tx.splitCoins(tx.gas, [tx.pure(wrapParams.amount)]);
    
    // Call wrap_and_swap function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::cc_exchange_logic::wrap_and_swap`,
      arguments: [
        tx.object(packageIds.initializedObjects.exchangeCapId),
        inputCoin,
        tx.pure(swapParams.minOutputAmount),
        tx.pure(targetAddress)
      ],
      typeArguments: [
        wrapParams.inputCoinType,
        wrapParams.outputCoinType,
        swapParams.inputCoinType,
        swapParams.outputCoinType
      ]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Refund by admin (admin only function)
   */
  async refundByAdmin(
    coinType: string,
    amount: string,
    recipient: string
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    // Get the coin to refund
    const coin = tx.splitCoins(tx.gas, [tx.pure(amount)]);
    
    // Call refund_by_admin function
    tx.moveCall({
      target: `${packageIds.mainPackageId}::cc_exchange_logic::refund_by_admin`,
      arguments: [
        tx.object(packageIds.adminCaps.exchangeAdminId),
        tx.object(packageIds.initializedObjects.exchangeCapId),
        coin,
        tx.pure(recipient)
      ],
      typeArguments: [coinType]
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
  // BTC RELAY FUNCTIONS
  // ============================================================================

  /**
   * Add headers with retarget to BTC relay
   */
  async addHeadersWithRetarget(
    headers: HeaderData[],
    retargetHeight: number
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    // Prepare header data
    const headerData = headers.map(h => [
      h.header,
      h.height,
      h.work
    ]);
    
    // Call addHeadersWithRetarget function
    tx.moveCall({
      target: `${packageIds.btcrelayPackageId}::btcrelay::addHeadersWithRetarget`,
      arguments: [
        tx.object(packageIds.btcrelayRelayId),
        tx.pure(headerData),
        tx.pure(retargetHeight)
      ]
    });

    return this.executeTransaction(tx);
  }

  /**
   * Add headers to BTC relay
   */
  async addHeaders(
    headers: HeaderData[]
  ): Promise<FunctionCallResult> {
    const packageIds = this.getPackageIds();
    const tx = new TransactionBlock();
    
    // Prepare header data
    const headerData = headers.map(h => [
      h.header,
      h.height,
      h.work
    ]);
    
    // Call addHeaders function
    tx.moveCall({
      target: `${packageIds.btcrelayPackageId}::btcrelay::addHeaders`,
      arguments: [
        tx.object(packageIds.btcrelayRelayId),
        tx.pure(headerData)
      ]
    });

    return this.executeTransaction(tx);
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
   * Switch network
   */
  switchNetwork(network: Network): void {
    this.network = network;
    this.client = new SuiClient({ url: NETWORK_URLS[network] });
  }
}


