import { createHash } from 'crypto';
import { hexToBytes } from '../../tests/utils/utils';

// Helper function to convert hex string to Uint8Array
function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

// Helper function to convert Uint8Array to hex string
function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper function to convert bytes to number (little-endian)
function bytesToNumber(bytes: Uint8Array, startIndex: number, length: number): number {
    let result = BigInt(0);
    for (let i = 0; i < length; i++) {
        result |= (BigInt(bytes[startIndex + i]) << BigInt(i * 8));
    }
    return Number(result);
}

// Helper function to convert number to bytes (big-endian)
function numberToBytes(value: number, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        bytes[i] = (value >> ((length - 1 - i) * 8)) & 0xFF;
    }
    return bytes;
}

// Helper function to convert hex string to Sui address string
function toSuiAddress(bytes: Uint8Array): string {
    return '0x' + toHex(bytes);
}

// Helper function to convert Sui address string to bytes
function fromSuiAddress(address: string): Uint8Array {
    const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
    return fromHex(cleanAddress);
}

// Helper function to generate random hex string
function generateRandomHex(length: number): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Helper function to generate random Bitcoin address (P2SH format)
function generateRandomBitcoinAddress(): string {
    return generateRandomHex(40); // 20 bytes = 40 hex chars
}

// Helper function to generate random Sui address
function generateRandomSuiAddress(): string {
    return '0x' + generateRandomHex(64); // 32 bytes = 64 hex chars
}

// Helper function to create compact int (VarInt) encoding
function createCompactInt(value: number): string {
    if (value <= 0xfc) {
        return value.toString(16).padStart(2, '0');
    } else if (value <= 0xffff) {
        return 'fd' + value.toString(16).padStart(4, '0');
    } else if (value <= 0xffffffff) {
        return 'fe' + value.toString(16).padStart(8, '0');
    } else {
        return 'ff' + value.toString(16).padStart(16, '0');
    }
}

// Helper function to create Bitcoin vout with proper structure
function createBitcoinVout(bitcoinAmount: number, opReturn: string): string {
    // Convert BTC to satoshis (1 BTC = 100,000,000 satoshis)
    const satoshis = bitcoinAmount * 100000000;
    
    // Create the vout structure according to Bitcoin protocol
    let vout = '';
    
    // 1. Number of outputs (VarInt)
    vout += createCompactInt(3); // 3 outputs: main output, OP_RETURN, change
    
    // 2. First output: Main payment (P2SH format) - using exact locker script from test
    // Convert to little-endian
    const satoshisHex = satoshis.toString(16).padStart(16, '0');
    const bytes = satoshisHex.match(/.{2}/g) || [];
    const littleEndianHex = bytes.reverse().join('');
    const mainAmountHex = littleEndianHex;
    
    const mainScript = 'a9144062c8aeed4f81c2d73ff854a2957021191e20b687'; // Script content only
    const mainScriptLength = createCompactInt(mainScript.length / 2); // 17 (23 bytes)
    vout += mainAmountHex + mainScriptLength + mainScript;
    
    // 3. Second output: OP_RETURN with our data
    const opReturnScript = '6a' + createCompactInt(opReturn.length / 2) + opReturn; // OP_RETURN + length + data
    const opReturnScriptLength = createCompactInt(opReturnScript.length / 2);
    vout += '0000000000000000' + opReturnScriptLength + opReturnScript; // 0 satoshis for OP_RETURN
    
    // 4. Third output: Change output (P2PKH format) - using exact rescue script from test
    const changeAmount = Math.floor(satoshis * 0.1); // 10% change
    const changeAmountHex = changeAmount.toString(16).padStart(16, '0');
    const changeScript = '1976a914' + '12ab8dc588ca9d5787dde7eb29569da63c3a238c' + '88ac'; // P2PKH script, exact rescue script from test
    const changeScriptLength = createCompactInt(changeScript.length / 2);
    vout += changeAmountHex + changeScriptLength + changeScript;
    
    return vout;
}

// Helper function to create Bitcoin vout with P2PKH script type for main output
function createBitcoinVoutP2PKH(bitcoinAmount: number, opReturn: string): string {
    // Convert BTC to satoshis (1 BTC = 100,000,000 satoshis)
    const satoshis = bitcoinAmount * 100000000;
    
    // Create the vout structure according to Bitcoin protocol
    let vout = '';
    
    // 1. Number of outputs (VarInt)
    vout += createCompactInt(3); // 3 outputs: main output, OP_RETURN, change
    
    // 2. First output: Main payment (P2PKH format)
    // Convert to little-endian
    const satoshisHex = satoshis.toString(16).padStart(16, '0');
    const bytes = satoshisHex.match(/.{2}/g) || [];
    const littleEndianHex = bytes.reverse().join('');
    const mainAmountHex = littleEndianHex;
    
    // P2PKH script: OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
    // 1976a914<pubKeyHash>88ac
    const mainScript = '1976a914' + '4062c8aeed4f81c2d73ff854a2957021191e20b6' + '88ac';
    const mainScriptLength = createCompactInt(mainScript.length / 2); // 25 bytes
    vout += mainAmountHex + mainScriptLength + mainScript;
    
    // 3. Second output: OP_RETURN with our data
    const opReturnScript = '6a' + createCompactInt(opReturn.length / 2) + opReturn; // OP_RETURN + length + data
    const opReturnScriptLength = createCompactInt(opReturnScript.length / 2);
    vout += '0000000000000000' + opReturnScriptLength + opReturnScript; // 0 satoshis for OP_RETURN
    
    // 4. Third output: Change output (P2PKH format)
    const changeAmount = Math.floor(satoshis * 0.1); // 10% change
    const changeAmountHex = changeAmount.toString(16).padStart(16, '0');
    const changeScript = '1976a914' + '12ab8dc588ca9d5787dde7eb29569da63c3a238c' + '88ac'; // P2PKH script, exact rescue script from test
    const changeScriptLength = createCompactInt(changeScript.length / 2);
    vout += changeAmountHex + changeScriptLength + changeScript;
    
    return vout;
}

// Helper function to create Bitcoin vin with proper structure
function createBitcoinVin(): string {
    // Create a realistic vin structure
    const prevTxId = generateRandomHex(64); // Previous transaction hash
    const prevTxIndex = '00000000'; // Output index (little-endian)
    const scriptSig = '483045022100' + generateRandomHex(64) + '0220' + generateRandomHex(64) + '012102' + generateRandomHex(66); // Standard signature script
    const scriptSigLength = createCompactInt(scriptSig.length / 2);
    const sequence = 'feffffff'; // Sequence number
    
    return '01' + prevTxId + prevTxIndex + scriptSigLength + scriptSig + sequence;
}

// Helper function to calculate transaction ID (double SHA256)
function calculateTxId(version: string, vin: string, vout: string, locktime: string): string {
    // Remove 0x prefixes
    const cleanVersion = version.startsWith('0x') ? version.slice(2) : version;
    const cleanVin = vin.startsWith('0x') ? vin.slice(2) : vin;
    const cleanVout = vout.startsWith('0x') ? vout.slice(2) : vout;
    const cleanLocktime = locktime.startsWith('0x') ? locktime.slice(2) : locktime;
    
    // Concatenate transaction data
    const txData = cleanVersion + cleanVin + cleanVout + cleanLocktime;
    
    // Calculate double SHA256
    const firstHash = createHash('sha256').update(Buffer.from(txData, 'hex')).digest();
    const secondHash = createHash('sha256').update(firstHash).digest();
    
    // Reverse bytes for little-endian format
    return '0x' + Array.from(secondHash).reverse().map(b => b.toString(16).padStart(2, '0')).join('');
}

interface SimpleTransferRequest {
    appId: number;             // 1 byte: max 256 apps
    recipientAddress: string;  // 32 bytes: Sui address
    networkFee: number;        // 4 bytes: network fee
    speed: number;             // 1 byte: {0,1}
    thirdParty: number;        // 1 byte: max 256 third parties, default is 0
}

interface BitcoinTransaction {
    txId: string;
    version: string;
    vin: string;
    vout: string;
    opReturn: string;
    locktime: string;
    blockNumber: number;
    intermediateNodes: string;
    index: number;
    bitcoinAmount: number;
    recipientAddress: string;
    teleporterFee: number;
    speed: number;
    desiredRecipient: string;
}

/**
 * Parse a 39-byte hex value into transfer request components
 * @param hexValue - 39-byte hex string (with or without 0x prefix)
 * @returns SimpleTransferRequest object with parsed components
 */
function parseRequest(hexValue: string): SimpleTransferRequest {
    // Remove 0x prefix if present
    const cleanHex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    
    // Validate length (39 bytes = 78 hex characters)
    if (cleanHex.length !== 78) {
        throw new Error(`Invalid hex length. Expected 78 characters (39 bytes), got ${cleanHex.length}`);
    }
    
    const bytes = fromHex(cleanHex);
    
    // Parse components according to the structure:
    // appId: 1 byte (index 0)
    // recipientAddress: 32 bytes (index 1-32)
    // networkFee: 4 bytes (index 33-36)
    // speed: 1 byte (index 37)
    // thirdParty: 1 byte (index 38)
    
    const appId = bytesToNumber(bytes, 0, 1);
    const recipientAddressBytes = bytes.slice(1, 33);
    const recipientAddress = toSuiAddress(recipientAddressBytes);
    const networkFee = bytesToNumber(bytes, 33, 4);
    const speed = bytesToNumber(bytes, 37, 1);
    const thirdParty = bytesToNumber(bytes, 38, 1);
    
    return {
        appId,
        recipientAddress,
        networkFee,
        speed,
        thirdParty
    };
}

/**
 * Create a 39-byte hex value from transfer request components
 * @param appId - Application ID (1 byte)
 * @param recipientAddress - Recipient Sui address (32 bytes)
 * @param networkFee - Network fee (4 bytes)
 * @param speed - Speed setting (1 byte)
 * @param thirdParty - Third party ID (1 byte)
 * @returns 39-byte hex string
 */
function createRequest(
    appId: number,
    recipientAddress: string,
    networkFee: number,
    speed: number,
    thirdParty: number
): string {
    // Validate inputs
    if (appId < 0 || appId > 255) {
        throw new Error('appId must be between 0 and 255');
    }
    if (networkFee < 0 || networkFee > 0xFFFFFFFF) {
        throw new Error('networkFee must be between 0 and 4294967295');
    }
    if (speed < 0 || speed > 1) {
        // throw new Error('speed must be 0 or 1');
    }
    if (thirdParty < 0 || thirdParty > 255) {
        throw new Error('thirdParty must be between 0 and 255');
    }
    
    // Create 39-byte array
    const bytes = new Uint8Array(39);
    
    // Set appId (1 byte)
    bytes[0] = appId;
    
    // Set recipientAddress (32 bytes)
    const addressBytes = fromSuiAddress(recipientAddress);
    if (addressBytes.length !== 32) {
        throw new Error('recipientAddress must be 32 bytes');
    }
    bytes.set(addressBytes, 1);
    
    // Set networkFee (4 bytes, big-endian)
    const feeBytes = numberToBytes(networkFee, 4);
    bytes.set(feeBytes, 33);
    
    // Set speed (1 byte)
    bytes[37] = speed;
    
    // Set thirdParty (1 byte)
    bytes[38] = thirdParty;
    
    return toHex(bytes);
}

/**
 * Create a complete Bitcoin transaction JSON with the given transfer request parameters
 * @param name - Name for the transaction (e.g., "normalCCTransfer")
 * @param appId - Application ID (1 byte)
 * @param recipientAddress - Recipient Sui address (32 bytes)
 * @param networkFee or teleporterFee - Network fee (4 bytes)
 * @param speed - Speed setting (1 byte)
 * @param thirdParty - Third party ID (1 byte)
 * @returns JSON string representing the complete Bitcoin transaction
 */
function createBitcoinTransactionJson(
    name: string,
    appId: number,
    recipientAddress: string,
    teleporterFee: number,
    speed: number,
    thirdParty: number,
    noValue = false
): any {
    // Create the 39-byte transfer request hex
    const transferRequestHex = createRequest(appId, recipientAddress, teleporterFee, speed, thirdParty);
    
    // Create Bitcoin transaction components according to protocol
    const version = "0x02000000";
    const vin = "0x" + createBitcoinVin();
    const bitcoinAmount = noValue ? 0 : 10;
    const vout = "0x" + createBitcoinVoutP2PKH(bitcoinAmount, transferRequestHex);
    const opReturn = transferRequestHex;
    const locktime = "0x00000000";
    
    // Calculate transaction ID based on actual transaction data
    const txId = calculateTxId(version, vin, vout, locktime);
    
    // Other fields
    const blockNumber = 497;
    const intermediateNodes = '0x' + generateRandomHex(64);
    const index = 1;
    const desiredRecipient = generateRandomBitcoinAddress();
    
    // Create the transaction object
    const transaction: BitcoinTransaction = {
        txId,
        version,
        vin,
        vout,
        opReturn,
        locktime,
        blockNumber,
        intermediateNodes,
        index,
        bitcoinAmount,
        recipientAddress,
        teleporterFee,
        speed,
        desiredRecipient
    };
    
    // Return the transaction object directly
    return transaction;
}

/**
 * Converts byte array to hex string
 * @param bytes - The byte array
 * @returns The hex string
 */
function bytesToHex(bytes: number[]): string {
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates Bitcoin transaction outputs (vout) structure
 * @param vout - The vout data as a hex string or byte array
 * @returns true if vout is valid, false otherwise
 */
function tryAsVout(vout: string | number[]): boolean {
    // Convert to byte array if it's a hex string
    const bytes = typeof vout === 'string' ? hexToBytes(vout) : vout;
    
    // Check if vout is empty
    if (bytes.length === 0) {
        console.log('Debug: vout is empty');
        return false;
    }

    // Get number of outputs using compact int parsing
    const nOuts = indexCompactInt(bytes, 0);
    if (nOuts === 0) {
        console.log('Debug: n_outs is 0');
        return false;
    }

    console.log('Debug: n_outs =', nOuts);
    console.log('Debug: vout hex =', bytesToHex(bytes));

    // Calculate initial offset after compact int
    let offset = compactIntLength(nOuts);
    const viewLen = bytes.length;

    console.log('Debug: initial offset =', offset, 'viewLen =', viewLen);

    // Iterate through each output
    for (let i = 0; i < nOuts; i++) {
        // Check if we've reached the end but still trying to read more
        if (offset >= viewLen) {
            console.log('Debug: offset >= viewLen', { offset, viewLen });
            return false;
        }

        // Get remaining bytes from current offset to end (like the original Solidity code)
        const remaining = bytes.slice(offset);
        console.log(`Debug: remaining bytes for output ${i}:`, bytesToHex(remaining));
        
        // Calculate the length of this specific output
        const outputLen = outputLength(remaining);
        console.log(`Debug: output ${i} length =`, outputLen);
        offset += outputLen;
    }

    // Verify we've consumed exactly all bytes
    if (offset !== viewLen) {
        console.log('Debug: offset !== viewLen', { offset, viewLen });
        return false;
    }

    console.log('Debug: vout validation successful');
    return true;
}

/**
 * Parses a compact integer from a byte array starting at the given index
 * @param data - The byte array
 * @param index - The starting index
 * @returns The parsed integer value
 */
function indexCompactInt(data: number[], index: number): number {
    // Check if we have enough bytes to read
    if (index >= data.length) {
        throw new Error('Index out of bounds');
    }
    
    const flag = data[index];
    console.log(`indexCompactInt: reading at index ${index}, flag = 0x${flag.toString(16)}`);
    
    if (flag <= 0xfc) {
        // For values <= 0xfc, the value is the flag itself
        console.log(`indexCompactInt: returning ${flag} (flag <= 0xfc)`);
        return flag;
    } else if (flag === 0xfd) {
        // For 0xfd, read next 2 bytes as little-endian
        if (index + 2 >= data.length) {
            throw new Error('Not enough bytes for 0xfd compact int');
        }
        const value = data[index + 1] | (data[index + 2] << 8);
        console.log(`indexCompactInt: returning ${value} (0xfd format)`);
        // Verify minimal encoding
        if (compactIntLength(value) !== 3) {
            throw new Error('Non-minimal compact int encoding');
        }
        return value;
    } else if (flag === 0xfe) {
        // For 0xfe, read next 4 bytes as little-endian
        if (index + 4 >= data.length) {
            throw new Error('Not enough bytes for 0xfe compact int');
        }
        const value = data[index + 1] | 
                     (data[index + 2] << 8) | 
                     (data[index + 3] << 16) | 
                     (data[index + 4] << 24);
        console.log(`indexCompactInt: returning ${value} (0xfe format)`);
        // Verify minimal encoding
        if (compactIntLength(value) !== 5) {
            throw new Error('Non-minimal compact int encoding');
        }
        return value;
    } else if (flag === 0xff) {
        // For 0xff, read next 8 bytes as little-endian
        if (index + 8 >= data.length) {
            throw new Error('Not enough bytes for 0xff compact int');
        }
        const value = data[index + 1] | 
                     (data[index + 2] << 8) | 
                     (data[index + 3] << 16) | 
                     (data[index + 4] << 24) |
                     (data[index + 5] << 32) |
                     (data[index + 6] << 40) |
                     (data[index + 7] << 48) |
                     (data[index + 8] << 56);
        console.log(`indexCompactInt: returning ${value} (0xff format)`);
        // Verify minimal encoding
        if (compactIntLength(value) !== 9) {
            throw new Error('Non-minimal compact int encoding');
        }
        return value;
    } else {
        throw new Error('Invalid compact int flag');
    }
}

/**
 * Calculates the length of a compact integer encoding
 * @param value - The integer value
 * @returns The length in bytes
 */
function compactIntLength(value: number): number {
    if (value <= 0xfc) {
        return 1;
    } else if (value <= 0xffff) {
        return 3;
    } else if (value <= 0xffffffff) {
        return 5;
    } else {
        return 9;
    }
}

/**
 * Calculates the length of a transaction output
 * @param output - The output data as byte array
 * @returns The length in bytes
 */
function outputLength(output: number[]): number {
    console.log('outputLength input:', bytesToHex(output));
    
    // Value is 8 bytes
    const valueBytes = output.slice(0, 8);
    console.log('value bytes:', bytesToHex(valueBytes));
    
    // Script length is a compact int starting at byte 8
    const scriptLen = indexCompactInt(output, 8);
    console.log('script length:', scriptLen);
    
    const compactIntLen = compactIntLength(scriptLen);
    console.log('compact int length:', compactIntLen);
    
    const totalLength = 8 + compactIntLen + scriptLen;
    console.log('total output length:', totalLength);
    
    return totalLength;
}

export { parseRequest, createRequest, createBitcoinTransactionJson, SimpleTransferRequest, BitcoinTransaction, tryAsVout, indexCompactInt, compactIntLength, outputLength, createBitcoinVout }; 