#!/usr/bin/env python3

import requests
import struct
from typing import Dict, Any, List, Tuple
import sys

def get_tx_hex(txid: str) -> str:
    """
    Fetch transaction hex from mempool.space API.
    
    Args:
        txid (str): The transaction ID to look up
        
    Returns:
        str: Raw transaction hex
    """
    url = f"https://mempool.space/api/tx/{txid}/hex"
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.text.strip()
    except requests.exceptions.RequestException as e:
        print(f"Error fetching transaction hex: {e}")
        sys.exit(1)

def parse_varint(data: bytes, offset: int) -> Tuple[int, int]:
    """
    Parse a variable length integer from the transaction data.
    
    Args:
        data (bytes): Raw transaction data
        offset (int): Current position in data
        
    Returns:
        Tuple[int, int]: (value, new_offset)
    """
    first_byte = data[offset]
    if first_byte < 0xfd:
        return first_byte, offset + 1
    elif first_byte == 0xfd:
        return int.from_bytes(data[offset+1:offset+3], 'little'), offset + 3
    elif first_byte == 0xfe:
        return int.from_bytes(data[offset+1:offset+5], 'little'), offset + 5
    else:  # 0xff
        return int.from_bytes(data[offset+1:offset+9], 'little'), offset + 9

def parse_tx_hex(tx_hex: str) -> Dict[str, Any]:
    """
    Parse raw transaction hex into structured data.
    
    Args:
        tx_hex (str): Raw transaction hex
        
    Returns:
        Dict[str, Any]: Parsed transaction data
    """
    data = bytes.fromhex(tx_hex)
    offset = 0
    
    # Parse version (4 bytes, little-endian)
    version = int.from_bytes(data[offset:offset+4], 'little')
    offset += 4
    
    # Parse input count (varint)
    input_count, offset = parse_varint(data, offset)
    
    # Parse inputs
    inputs = []
    for _ in range(input_count):
        # Previous txid (32 bytes, little-endian)
        prev_txid = data[offset:offset+32][::-1].hex()  # Reverse for big-endian display
        offset += 32
        
        # Previous vout (4 bytes, little-endian)
        prev_vout = int.from_bytes(data[offset:offset+4], 'little')
        offset += 4
        
        # Script length (varint)
        script_len, offset = parse_varint(data, offset)
        
        # Script
        script = data[offset:offset+script_len].hex()
        offset += script_len
        
        # Sequence (4 bytes, little-endian)
        sequence = int.from_bytes(data[offset:offset+4], 'little')
        offset += 4
        
        inputs.append({
            'txid': prev_txid,
            'vout': prev_vout,
            'script': script,
            'sequence': sequence
        })
    
    # Parse output count (varint)
    output_count, offset = parse_varint(data, offset)
    
    # Parse outputs
    outputs = []
    for _ in range(output_count):
        # Value (8 bytes, little-endian)
        value = int.from_bytes(data[offset:offset+8], 'little')
        offset += 8
        
        # Script length (varint)
        script_len, offset = parse_varint(data, offset)
        
        # Script
        script = data[offset:offset+script_len].hex()
        offset += script_len
        
        outputs.append({
            'value': value,
            'script': script
        })
    
    # Parse locktime (4 bytes, little-endian)
    locktime = int.from_bytes(data[offset:offset+4], 'little')
    
    return {
        'version': version,
        'inputs': inputs,
        'outputs': outputs,
        'locktime': locktime
    }

def print_parsed_tx(tx_data: Dict[str, Any]) -> None:
    """
    Print parsed transaction data in a readable format.
    
    Args:
        tx_data (Dict[str, Any]): Parsed transaction data
    """
    print("\nParsed Transaction:")
    print("-" * 50)
    print(f"Version: 0x{tx_data['version']:08x}")
    
    print("\nInputs:")
    for i, inp in enumerate(tx_data['inputs'], 1):
        print(f"\nInput {i}:")
        print(f"  Previous TXID: {inp['txid']}")
        print(f"  Previous Vout: {inp['vout']}")
        print(f"  Script: 0x{inp['script']}")
        print(f"  Sequence: 0x{inp['sequence']:08x}")
    
    print("\nOutputs:")
    for i, out in enumerate(tx_data['outputs'], 1):
        print(f"\nOutput {i}:")
        print(f"  Value: {out['value']} satoshis")
        print(f"  Script: 0x{out['script']}")
    
    print(f"\nLocktime: 0x{tx_data['locktime']:08x}")

def main():
    if len(sys.argv) != 2:
        print("Usage: python parse_tx_hex.py <transaction_id>")
        sys.exit(1)
    
    txid = sys.argv[1]
    
    # Get transaction hex
    tx_hex = get_tx_hex(txid)
    
    # Parse transaction hex
    tx_data = parse_tx_hex(tx_hex)
    
    # Print parsed transaction
    print_parsed_tx(tx_data)

if __name__ == "__main__":
    main() 