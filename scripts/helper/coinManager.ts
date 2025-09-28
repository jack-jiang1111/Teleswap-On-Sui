import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

export interface CoinManagementResult {
  swapCoinIds: string[];
  gasCoin: { objectId: string; version: string; digest: string };
}

export class CoinManager {
  private client: SuiClient;
  private keypair: Ed25519Keypair;

  constructor(client: SuiClient, keypair: Ed25519Keypair) {
    this.client = client;
    this.keypair = keypair;
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
  async getGasCoin(): Promise<{ objectId: string; version: string; digest: string }> {
    const suiCoins = await this.getCoinsSorted('0x2::sui::SUI');
    const gasCoin = suiCoins[0]; // Largest coin
    
    return {
      objectId: gasCoin.coinObjectId,
      version: gasCoin.version,
      digest: gasCoin.digest,
    };
  }

  /**
   * Get swap coins for a specific type, handling SUI gas coin splitting
   */
  async getSwapCoins(coinType: string, swapAmount: number): Promise<string[]> {
    const coins = await this.getCoinsSorted(coinType);
    
    if (coinType === '0x2::sui::SUI') {
      // For SUI, we need to handle gas coin splitting
      if (coins.length === 1) {
        // User has only one SUI coin - we need to split it
        const singleCoin = coins[0];
        const totalBalance = parseInt(singleCoin.balance);
        
        // Check if we have enough balance (including gas buffer)
        const gasBuffer = 100000000; // 0.1 SUI buffer for gas
        const requiredTotal = swapAmount + gasBuffer;
        
        if (totalBalance < requiredTotal) {
          throw new Error(`Insufficient SUI balance. Need ${requiredTotal} (${swapAmount} for swap + ${gasBuffer} for gas), have ${totalBalance}`);
        }
        
        // Return the single coin ID - it will be split in the transaction
        return [singleCoin.coinObjectId];
      } else {
        // User has multiple SUI coins - use all except the largest (which is reserved for gas)
        const swapCoins = coins.slice(1);
        
        if (swapCoins.length === 0) {
          throw new Error('No SUI coins available for swap (all reserved for gas)');
        }
        
        // Check if we have enough balance in swap coins
        const totalSwapBalance = swapCoins.reduce((sum, coin) => sum + parseInt(coin.balance), 0);
        if (totalSwapBalance < swapAmount) {
          throw new Error(`Insufficient SUI balance for swap. Need ${swapAmount}, have ${totalSwapBalance} in swap coins`);
        }
        
        return swapCoins.map(coin => coin.coinObjectId);
      }
    } else {
      // For non-SUI tokens, use all available coins
      const totalBalance = coins.reduce((sum, coin) => sum + parseInt(coin.balance), 0);
      if (totalBalance < swapAmount) {
        throw new Error(`Insufficient balance. Need ${swapAmount}, have ${totalBalance}`);
      }
      
      return coins.map(coin => coin.coinObjectId);
    }
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
  async splitCoin(coinId: string, amount: number): Promise<string> {
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

    const createdObjects = result.objectChanges?.filter(
      (change) => change.type === 'created'
    );
    
    if (createdObjects && createdObjects.length > 0) {
      return (createdObjects[0] as any).objectId;
    }
    
    throw new Error('Failed to split coin');
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
