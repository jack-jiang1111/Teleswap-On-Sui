import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFullnodeUrl } from '@mysten/sui.js/client';
import { getActiveKeypair } from '../../scripts/sui.utils';

export type MoveArgument = {
    type: 'pure' | 'object';
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
        waitForConfirmation = true
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
        }
        // Handle raw values (treat as pure) or fallback
        return tx.pure(arg);
    }).filter(arg => arg !== undefined);

    // Add the Move call
    tx.moveCall({
        target: `${packageId}::${moduleName}::${functionName}`,
        arguments: convertedArgs,
        typeArguments,
    });

    // Execute the transaction
    const result = await suiClient.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: activeSigner,
        options: { showEffects: true, showEvents: true }
    });

    // Wait for confirmation if requested
    if (waitForConfirmation) {
        await suiClient.waitForTransactionBlock({
            digest: result.digest,
            options: { showEffects: true, showEvents: true }
        });
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
 * @param value - The object ID to wrap as an object argument
 * @returns MoveArgument object
 */
export function object(value: string): MoveArgument {
    return { type: 'object', value };
}
