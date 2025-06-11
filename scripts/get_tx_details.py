#!/usr/bin/env python3

import requests
import json
from typing import Dict, Any
import sys

def get_transaction_details(txid: str) -> Dict[str, Any]:
    """
    Fetch transaction details from mempool.space API.
    
    Args:
        txid (str): The transaction ID to look up
        
    Returns:
        Dict[str, Any]: Transaction details including version, locktime, vin, vout, etc.
        
    Raises:
        requests.exceptions.RequestException: If the API request fails
    """
    # API endpoint
    url = f"https://mempool.space/api/tx/{txid}/hex"
    
    try:
        # Make GET request
        response = requests.get(url)
        response.raise_for_status()  # Raise exception for bad status codes
        
        # Parse JSON response
        #tx_details = response.json()
        print(response.text)
        return response.text
        
    except requests.exceptions.RequestException as e:
        print(f"Error fetching transaction details: {e}")
        sys.exit(1)

def format_value(value: Any) -> str:
    """
    Format a value for display, converting bytes to hex if necessary.
    
    Args:
        value: The value to format
        
    Returns:
        str: Formatted value
    """
    if isinstance(value, str) and value.startswith('0x'):
        # Already in hex format
        return value
    elif isinstance(value, (bytes, bytearray)):
        # Convert bytes to hex
        return '0x' + value.hex()
    elif isinstance(value, dict):
        # Handle nested dictionaries
        return {k: format_value(v) for k, v in value.items()}
    elif isinstance(value, list):
        # Handle lists
        return [format_value(item) for item in value]
    else:
        return str(value)

def print_transaction_details(tx_details: Dict[str, Any]) -> None:
    """
    Print transaction details in a formatted way.
    
    Args:
        tx_details (Dict[str, Any]): Transaction details to print
    """
    print("\nTransaction Details:")
    print("-" * 50)
    print(f"Transaction ID: {tx_details['txid']}")
    print(f"Version: {format_value(tx_details['version'])}")
    print(f"Locktime: {format_value(tx_details['locktime'])}")
    print(f"Size: {tx_details['size']} bytes")
    print(f"Weight: {tx_details['weight']} WU")
    print(f"Fee: {tx_details['fee']} sats")
    
    # Print status if available
    if 'status' in tx_details:
        status = tx_details['status']
        print("\nStatus:")
        print(f"Confirmed: {status['confirmed']}")
        if status['confirmed']:
            print(f"Block Height: {status['block_height']}")
            print(f"Block Hash: {status['block_hash']}")
            print(f"Block Time: {status['block_time']}")
    
    # Print inputs
    print("\nInputs (vin):")
    for i, vin in enumerate(tx_details['vin'], 1):
        print(f"\nInput {i}:")
        for key, value in vin.items():
            print(f"  {key}: {format_value(value)}")
    
    # Print outputs
    print("\nOutputs (vout):")
    for i, vout in enumerate(tx_details['vout'], 1):
        print(f"\nOutput {i}:")
        for key, value in vout.items():
            print(f"  {key}: {format_value(value)}")

def main():
    
    txid = "68819d0610a659509653e41887f2e8c7096a26d9ecd26da0126def7c43667776"
    
    # Get transaction details
    tx_details = get_transaction_details(txid)
    
    # Print transaction details
    #print_transaction_details(tx_details)

if __name__ == "__main__":
    main() 

'''
0	_txAndProof.version	bytes4
0x02000000
0	_txAndProof.vin	bytes
0x01cb56b529a400837fc69be6962045ff28efba870a6219b07dc310c34265259cbc0000000000ffffffff
0	_txAndProof.vout	bytes
0x04dd2300000000000017a91472df0f82c4bcfe01a274bd521e5d4c66586b7a5b870000000000000000436a41008914d260fa17bb8e27deb77c826e1d5708589eca8da50003e800040d500b1d8e8ef31e21c99d1db9a6444d3adf1270000000000002185af35f4752e23200000033030000000000001600147a85598118e8afa0ca099917bf2ce7eb756e9c3a44a101000000000016001447862865a0a50a0784b8637b42d76090573b470f
0	_txAndProof.locktime	bytes4
0x00000000
0	_txAndProof.blockNumber	uint256
900185
0	_txAndProof.intermediateNodes	bytes
0x369734e11f37fbb4a84123b887e2af41ed70bb2b3d68560499bbdd3a366e5feed7e778349edb14411b1079c30f1516b048d8b10610f7e42ef4e2ecd235a7914593e3f49a3fcea2bbd81e16bfffb97036ff07639f56477938b575fdd46ccb0621b98dca22679447ec167e9ab059d41396f878c668af17bcfc234ed7017cbdef6644273766c1b2a30625e9af520651ea7e0fee0a6ecea7b5430feddb233ee194cd429aabe3ebd7efa9115dac33b828c04b889ce47fb803b589e730ca7e5c02b0c8f2f9388cc21cd6190ead6a81635b585046380fb45999abe5e8c28c4992cb750ab80dd9b8bfbc93a4e771307bf72633f961da7afa7238bf55977161ba4143f9c0162b6c8c83cb951ff1b4f684122046a86ebe0871d908558696036b7cb53fd0b8be0f6b0dac2e5a216d4b8cd8b7f1a2aaf630c77fc84e35b2058b2e2ed260c4f4bfe2866cd2ff87b3393f2cac9f2dd9435cd1df07c212607710ad46b7ef71a0e895d8882f46766f6a1a903b8b3a95925cca699050dd8bd3907443b741101228f8
0	_txAndProof.index	uint256
2441
2	_lockerLockingScript	bytes
0xa91472df0f82c4bcfe01a274bd521e5d4c66586b7a5b87
2	_path	address
0x3BF668Fe1ec79a84cA8481CEAD5dbb30d61cC685
3	_path	address
0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6
4	_path	address
0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
5	_path	address
0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270

'''