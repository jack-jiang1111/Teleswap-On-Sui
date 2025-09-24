import { SuiClient } from '@mysten/sui.js/client';
import { createHash } from 'crypto';

// Helper function to revert bytes32 string
export function revertBytes32(bytes32: string): string {
    return bytes32.match(/.{1,2}/g)?.reverse().join('') || '';
}

// Helper function to convert byte array to hex string
export function bytesToHex(bytes: number[]): string {
    // If the first byte is 32 (length indicator), skip it
    const startIndex = bytes[0] === 32 ? 1 : 0;
    const relevantBytes = bytes.slice(startIndex);
    // Convert to hex without reversing the order
    return relevantBytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper function to parse return values based on type
export function parseReturnValue(bytes: number[]): string | number {
    // If it's a byte array representing a hex string (like block hash)
    if (bytes.length === 32) {
        return bytesToHex(bytes);
    }
    
    // If it's a byte array representing a number
    // Convert little-endian bytes to number
    let result = 0;
    for (let i = 0; i < bytes.length; i++) {
        result += bytes[i] * Math.pow(256, i);
    }
    return result.toString();
}

// Helper function to convert hex string to bytes
export function hexToBytes(hex: string | number[]): number[] {
    // If input is already a byte array, return it
    if (Array.isArray(hex)) {
        return hex;
    }

    // Ensure hex is a string
    const hexStr = String(hex);
    
    // Remove '0x' prefix if present
    const cleanHex = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr;

    // Remove any carriage returns or newlines
    const sanitizedHex = cleanHex.replace(/[\r\n]/g, '');

    // Convert hex string to byte array
    const bytes = [];
    for (let i = 0; i < sanitizedHex.length; i += 2) {
        bytes.push(parseInt(sanitizedHex.substr(i, 2), 16));
    }
    //console.log('bytes:', bytes);
    return bytes;
}

// Helper function to print events, take in a result object returned from a transaction
export function printEvents(result: any): void {
    if (!result.events || result.events.length === 0) {
        console.log('No events found');
        return;
    }

    console.log('\n=== Events ===');
    result.events.forEach((event: any, index: number) => {
        console.log(`\nEvent ${index + 1}:`);
        
        // Extract event name from type (everything after last ::)
        const eventName = event.type.split('::').pop();
        console.log(`Event Name: ${eventName}`);
        
        if (event.parsedJson) {
            const parsed = event.parsedJson;
            
            // Print all fields
            Object.entries(parsed).forEach(([key, value]) => {
                if (Array.isArray(value)) {
                    // Check if it's a byte array (for addresses, scripts, etc.)
                    if (value.length > 0 && typeof value[0] === 'number' && value[0] <= 255) {
                        // It's likely a byte array, convert to hex
                        console.log(`${key}: ${Buffer.from(value).toString('hex')}`);
                    } else {
                        // It's a regular array of numbers, display as array
                        console.log(`${key}: [${value.join(', ')}]`);
                    }
                } else {
                    console.log(`${key}: ${value}`);
                }
            });
        }
    });
    console.log('\n=== End Events ===\n');
} 

// double sha256 hash a header
export function hash256(header: string): string {
    // First SHA-256
    const firstHash = createHash('sha256')
        .update(Buffer.from(header, 'hex'))
        .digest();
    
    // Second SHA-256
    const secondHash = createHash('sha256')
        .update(firstHash)
        .digest();
    
    return secondHash.toString('hex');
}

// Helper function to verify whether the object is an UpgradeCap
export async function verifyUpgradeCap(client: SuiClient, packageId: string): Promise<boolean> {
    const packageObj = await client.getObject({
        id: packageId,
        options: { showContent: true }
    });
    
    if (!packageObj.data) {
        console.log('No data in package object');
        return false;
    }

    if (packageObj?.data?.content?.dataType === 'moveObject' && 
        packageObj.data.content?.type === '0x2::package::UpgradeCap') {
        return true;
    } 
    return false;
}

// Helper function to remove 0x prefix if it exists
export function remove0xPrefix(hex: string): string {
    // Remove '0x' prefix if present
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    return cleanHex;
}

// Helper function to check if an event name is NOT contained in the events list
export function eventNotContain(result: any, eventName: string): boolean {
    if (!result.events || result.events.length === 0) {
        return true; // No events means the event is not contained
    }

    for (const event of result.events) {
        // Extract event name from type (everything after last ::)
        const currentEventName = event.type.split('::').pop();
        if (currentEventName === eventName) {
            return false; // Event found, so it IS contained
        }
    }
    
    return true; // Event not found, so it is NOT contained
}