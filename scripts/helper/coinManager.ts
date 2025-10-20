import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

export interface CoinManagementResult {
  swapCoinIds: string[];
  gasCoin: { objectId: string; version: string; digest: string; balance: string };
}

export class CoinManager {
  private client: SuiClient;
  private keypair: Ed25519Keypair;

  constructor(client: SuiClient, keypair: Ed25519Keypair) {
    this.client = client;
    this.keypair = keypair;
  }

  /**
   * Prepare SUI coins for a swap ensuring a dedicated gas coin is available.
   * Algorithm:
   * 1) Sort SUI coins largest->smallest. Select coins until selectedSum >= swapAmount.
   * 2) Compute restSum from remaining coins.
   * 3) If restSum >= gasBudget -> use the largest remaining coin as gas coin.
   * 4) Else if total < swapAmount + gasBudget -> throw insufficient.
   * 5) Else pre-split: split gasBudget out of the largest coin into a dedicated gas coin (separate tx), then re-fetch and reselect swap coins excluding the gas coin.
   * Returns swap coin ids and gas coin descriptor (objectId/version/digest).
   */
  async prepareSuiForSwap(swapAmount: number, gasBudget: number): Promise<{ swapCoinIds: string[]; }> {
    const coins = await this.getCoinsSorted('0x2::sui::SUI');
    const total = coins.reduce((s, c) => s + parseInt(c.balance), 0);
    if (total < swapAmount + gasBudget*1.2) {
      throw new Error(`Insufficient SUI balance. Need ${swapAmount + gasBudget}, have ${total}`);
    }

    const selectSwapCoins = (coinList: any[]): { selected: string[]; remaining: any[]; selectedSum: number } => {
      const selected: string[] = [];
      let sum = 0;
      for (const c of coinList) {
        if (sum >= swapAmount) break;
        selected.push(c.coinObjectId);
        sum += parseInt(c.balance);
      }
      const remaining = coinList.filter((c: any) => !selected.includes(c.coinObjectId));
      return { selected, remaining, selectedSum: sum };
    };

    // Initial selection
    let { selected, remaining } = selectSwapCoins(coins);
    const restSum = remaining.reduce((s, c) => s + parseInt(c.balance), 0);

    if (restSum >= gasBudget*1.2) {
      return { swapCoinIds: selected };
    }

    // Need to pre-split a dedicated gas coin
    // Split out of the largest coin
    const largest = coins[0].coinObjectId;
    const success = await this.splitCoin(largest, gasBudget*1.2); // give a 20% buffer 
    if(!success) {
      throw new Error('Failed to split coin');
    }
    console.log('✅ Successfully split coin, preparing to swap again');
    // if sucess, we can recursively call the function
    return this.prepareSuiForSwap(swapAmount, gasBudget);
  }
  /**
   * Get coins for a specific type, sorted by balance (largest first)
   */
  async getCoinsSorted(coinType: string): Promise<any[]> {
    const coins = await this.client.getCoins({
      owner: this.keypair.toSuiAddress(),
      coinType: coinType,
    });
    
    if (coins.data.length === 0) {
      throw new Error(`No coins found for type ${coinType}`);
    }
    
    // Sort by balance (largest first)
    return coins.data.sort((a, b) => parseInt(b.balance) - parseInt(a.balance));
  }

  /**
   * Get the largest SUI coin for gas
   */
  async getGasCoin(): Promise<{ objectId: string; version: string; digest: string; balance: string }> {
    const suiCoins = await this.getCoinsSorted('0x2::sui::SUI');
    const gasCoin = suiCoins[0]; // Largest coin
    
    return {
      objectId: gasCoin.coinObjectId,
      version: gasCoin.version,
      digest: gasCoin.digest,
      balance: gasCoin.balance,
    };
  }

  /**
   * Get swap coins for a specific type
   * Returns string[] of coin IDs
   */
  async getSwapCoins(coinType: string, swapAmount: number): Promise<string[]> {
    const coins = await this.getCoinsSorted(coinType);
    return coins.map(coin => coin.coinObjectId);
  }

  /**
   * Get a coin ID for a specific coin type
   */
  async getCoinId(coinType: string): Promise<string> {
    const coins = await this.client.getCoins({
      owner: this.keypair.toSuiAddress(),
      coinType: coinType,
    });
    
    if (coins.data.length === 0) {
      throw new Error(`No coins found for type ${coinType}`);
    }
    
    return coins.data[0].coinObjectId;
  }

  /**
   * Split a coin to get a specific amount
   */
  async splitCoin(coinId: string, amount: number): Promise<boolean> {
    const txb = new TransactionBlock();
    
    const coin = txb.object(coinId);
    const splitCoin = txb.splitCoins(coin, [amount]);
    txb.transferObjects([splitCoin], this.keypair.toSuiAddress());
    
    const result = await this.client.signAndExecuteTransactionBlock({
      transactionBlock: txb,
      signer: this.keypair,
      options: {
        showEffects: true,
        showObjectChanges: true,
      },
    });

    // wait until the transaction is processed
    // Check if result has digest property (SuiTransactionBlockResponse)
    if ('digest' in result) {
      await this.client.waitForTransactionBlock({
          digest: result.digest,
          options: { showEffects: true, showEvents: true }
      });
    }
    return result.effects?.status?.status === "success";
  }

  /**
   * Merge multiple coins into one
   */
  async mergeCoins(coinIds: string[]): Promise<string> {
    if (coinIds.length <= 1) {
      return coinIds[0];
    }
    
    const txb = new TransactionBlock();
    txb.setGasBudget(100000000);
    
    // Get gas coins for this transaction
    const { data: gasObjects } = await this.client.getOwnedObjects({
      owner: this.keypair.toSuiAddress(),
      filter: { StructType: '0x2::coin::Coin<0x2::sui::SUI>' },
      options: { showContent: true },
    });
    
    if (gasObjects.length === 0) {
      throw new Error('No SUI coins found for gas');
    }
    
    txb.setGasPayment([{
      objectId: gasObjects[0].data!.objectId,
      version: gasObjects[0].data!.version,
      digest: gasObjects[0].data!.digest,
    }]);
    
    // Start with the first coin
    let mergedCoin = txb.object(coinIds[0]);
    
    // Merge all other coins into the first one
    for (let i = 1; i < coinIds.length; i++) {
      const coinToMerge = txb.object(coinIds[i]);
      mergedCoin = txb.mergeCoins(mergedCoin, [coinToMerge]);
    }
    
    // Transfer the merged coin back to sender
    txb.transferObjects([mergedCoin], this.keypair.toSuiAddress());
    
    const result = await this.client.signAndExecuteTransactionBlock({
      transactionBlock: txb,
      signer: this.keypair,
      options: {
        showEffects: true,
        showObjectChanges: true,
      },
    });
    
    // Find the merged coin object
    const createdObjects = result.objectChanges?.filter(
      (change) => change.type === 'created'
    );
    
    if (createdObjects && createdObjects.length > 0) {
      return (createdObjects[0] as any).objectId;
    }
    
    throw new Error('Failed to merge coins');
  }

  /**
   * Check if user has required coins
   */
  async checkRequiredCoins(requiredTypes: { type: string; name: string }[]): Promise<void> {
    console.log('🔍 Checking for required coins...');
    
    for (const { type, name } of requiredTypes) {
      const coins = await this.client.getCoins({
        owner: this.keypair.toSuiAddress(),
        coinType: type,
      });
      
      if (coins.data.length === 0) {
        console.log(`❌ No ${name} coins found. Please run the mint_mock_coins.ts script first.`);
        throw new Error(`Missing ${name} coins. Please mint some coins first.`);
      } else {
        const totalBalance = coins.data.reduce((sum, coin) => sum + parseInt(coin.balance), 0);
        console.log(`✅ Found ${name} coins: ${totalBalance} units`);
      }
    }
    
    console.log('✅ All required coins found!\n');
  }

}
