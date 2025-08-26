import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFullnodeUrl } from '@mysten/sui.js/client';
import { getActiveKeypair } from '../../scripts/sui.utils';

export type MoveArgument = {
    type: 'pure' | 'object' | 'objectRef' | 'sharedObjectRef';
    value: any;
};

export interface MoveCallOptions {
    packageId: string;
    moduleName: string;
    functionName: string;
    arguments: (MoveArgument | any)[]; // Can be MoveArgument objects or raw values (will be treated as pure)
    typeArguments?: string[];
    gasBudget?: number;
    signer?: Ed25519Keypair;
    client?: SuiClient;
    waitForConfirmation?: boolean;
    returnValue?: boolean;
    returnObject?: boolean; // New flag to handle returned objects
}

/**
 * Helper function to make Move function calls with automatic transaction confirmation
 * @param options - Configuration options for the Move call
 * @returns Promise with the transaction result
 */
export async function callMoveFunction(options: MoveCallOptions) {
    const {
        packageId,
        moduleName,
        functionName,
        arguments: args,
        typeArguments = [],
        gasBudget = 500000000,
        signer,
        client,
        waitForConfirmation = true,
        returnValue = false,
        returnObject = false
    } = options;

    // Get client and signer
    const suiClient = client || new SuiClient({ url: getFullnodeUrl('localnet') });
    const activeSigner = signer || await getActiveKeypair();

    // Create transaction block
    const tx = new TransactionBlock();
    tx.setGasBudget(gasBudget);

    // Convert arguments to proper Sui transaction arguments
    const convertedArgs = args.map(arg => {
        if (typeof arg === 'object' && arg !== null && 'type' in arg) {
            // Handle MoveArgument objects
            const moveArg = arg as MoveArgument;
            if (moveArg.type === 'pure') {
                return tx.pure(moveArg.value);
            } else if (moveArg.type === 'object') {
                return tx.object(moveArg.value);
            }
            else if (moveArg.type === 'objectRef') {
                return tx.objectRef({objectId: moveArg.value.objectId, version: moveArg.value.version, digest: moveArg.value.digest});
            }
            else if (moveArg.type === 'sharedObjectRef') {
                return tx.sharedObjectRef(moveArg.value);
            }
        }
        // Handle raw values (treat as pure) or fallback
        return tx.pure(arg);
    }).filter(arg => arg !== undefined);
    // Add the Move call
    const moveCallResult = tx.moveCall({
        target: `${packageId}::${moduleName}::${functionName}`,
        arguments: convertedArgs,
        typeArguments,
    });

    // If returnObject is true, we need to transfer the returned objects to the signer
    if (returnObject) {
        // Transfer all returned objects to the signer
        if (Array.isArray(moveCallResult)) {
            moveCallResult.forEach((returnValue, index) => {
                tx.transferObjects([returnValue], tx.pure(activeSigner.toSuiAddress()));
            });
        } else {
            tx.transferObjects([moveCallResult], tx.pure(activeSigner.toSuiAddress()));
        }
    }

    let result = null;
    if(returnValue) {
        result = await suiClient.devInspectTransactionBlock({
            transactionBlock: tx,
            sender: activeSigner.toSuiAddress(),
        });
    } else {
        result = await suiClient.signAndExecuteTransactionBlock({
            transactionBlock: tx,
            signer: activeSigner,
            options: { showEffects: true, showEvents: true }
        });
    }

    // Wait for confirmation if requested
    if (waitForConfirmation && !returnValue) {
        // Check if result has digest property (SuiTransactionBlockResponse)
        if ('digest' in result) {
            await suiClient.waitForTransactionBlock({
                digest: result.digest,
                options: { showEffects: true, showEvents: true }
            });
        }
    }

    return result;
}

/**
 * Convenience function for common Move calls with simplified parameters
 * @param packageId - The package ID
 * @param moduleName - The module name
 * @param functionName - The function name
 * @param args - Array of arguments (can be MoveArgument objects or raw values)
 * @param signer - Optional signer (will use default if not provided)
 * @returns Promise with the transaction result
 */
export async function simpleMoveCall(
    packageId: string,
    moduleName: string,
    functionName: string,
    args: (MoveArgument | any)[],
    signer?: Ed25519Keypair
) {
    return callMoveFunction({
        packageId,
        moduleName,
        functionName,
        arguments: args,
        signer
    });
}

/**
 * Helper function to create pure arguments
 * @param value - The value to wrap as a pure argument
 * @returns MoveArgument object
 */
export function pure(value: any): MoveArgument {
    return { type: 'pure', value };
}

/**
 * Helper function to create object arguments
 * @param value - The object ID (string)
 * @returns MoveArgument object
 */
export function object(value: string): MoveArgument {
    return { type: 'object', value };
}

/**
 * Helper function to create object reference arguments
 * @param objectId - The object ID
 * @param version - The object version
 * @param digest - The object digest
 * @returns MoveArgument object with object reference
 */
export function objectRef(objectId: string, version: string, digest: string): MoveArgument {
    return { 
        type: 'objectRef', 
        value: { objectId, version, digest } 
    };
}

/**
 * Helper function to create shared object reference arguments
 * @param objectId - The object ID
 * @param initialSharedVersion - The initial shared version
 * @param mutable - Whether the object is mutable
 * @returns MoveArgument object with shared object reference
 */
export function sharedObjectRef(objectId: string, initialSharedVersion: string, mutable: boolean): MoveArgument {
    return { 
        type: 'sharedObjectRef', 
        value: { 
            objectId, 
            mutable: mutable,
            initialSharedVersion: initialSharedVersion,
        } 
    };
}

/**
 * Helper function to get latest object references with version information
 * @param client - The Sui client
 * @param objectId - The object ID to fetch
 * @returns Object reference with objectId, version, digest, and initialSharedVersion
 */
export async function getLatestObjectRef(client: SuiClient, objectId: string) {
    try {
        const object = await client.getObject({
            id: objectId,
            options: { showContent: true, showOwner: true }
        });
        if (object.data) {
            // Check if this is a shared object and get its initial shared version
            let initialSharedVersion = object.data.version; // Default to current version
            
            if (object.data.owner && typeof object.data.owner === 'object' && 'Shared' in object.data.owner) {
                const sharedOwner = object.data.owner as any;
                initialSharedVersion = sharedOwner.Shared.initial_shared_version || object.data.version;
            }
            
            return {
                objectId: object.data.objectId,
                version: object.data.version,
                digest: object.data.digest,
                initialSharedVersion: initialSharedVersion
            };
        }
        throw new Error(`Object ${objectId} not found`);
    } catch (error) {
        console.error(`Failed to get latest reference for object ${objectId}:`, error);
        throw error;
    }
}



/**
 * Helper function to check coin balance for a given address
 * @param client - The Sui client
 * @param packageId - The package ID
 * @param address - The address to check balance for
 * @param coinType - The coin type (e.g., "telebtc_mock::TELEBTC_MOCK")
 * @returns The coin balance as a number
 */
export async function getCoinBalance(client: SuiClient, packageId: string, address: string, coinType: string): Promise<number> {
    try {
        // Get current balances
        const balance = await client.getBalance({
            owner: address,
            coinType: `${packageId}::${coinType}`
        });
        
        return Number(balance.totalBalance);
    } catch (error) {
        console.error(`Failed to get coin balance for address ${address} and coin ${packageId}::${coinType}:`, error);
        throw error;
    }
}

export async function splitGasTokens(client: SuiClient, deployer: any, recipient: string, amount: number) {
    const tx = new TransactionBlock();
    
    // Get the gas object from the deployer
    const [coin] = tx.splitCoins(tx.gas, [tx.pure(amount)]);
    
    // Transfer the split coin to the recipient
    tx.transferObjects([coin], tx.pure(recipient));

    const result = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: deployer,
        options: { 
            showEffects: true,
            showEvents: true
        }
    });

    console.log(`Transferred ${amount} gas tokens to ${recipient}`);
    return result;
}
