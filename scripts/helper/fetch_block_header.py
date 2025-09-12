import requests

def fetch_block_header(block_height):
    # First get the block hash from height
    height_url = f"https://mempool.space/api/block-height/{block_height}"
    block_hash = requests.get(height_url).text.strip()
    block_hash_le = ''.join(reversed(block_hash))

    # Then get the block header using the hash
    header_url = f"https://mempool.space/api/block/{block_hash}/header"
    header_hex = requests.get(header_url).text.strip()
    
    print(f"Block Height: {block_height}")
    print(f"Block Hash: {block_hash_le}")
    print(f"Block Header (hex): {header_hex}")
    print(f"Header Length: {len(block_hash_le)} bytes")
    
    return header_hex

# Example usage
if __name__ == "__main__":
    
    fetch_block_header(897110)
    fetch_block_header(895104)



