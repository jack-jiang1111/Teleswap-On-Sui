#[allow(lint(self_transfer),lint(share_owned),unused)]
module btcrelay::bitcoin_helper {
    // === Imports ===
    use sui::table::{Self, Table};
    use sui::event;
    use std::debug;
    use sui::event::emit;
    use std::address;

    // Constants
    const RETARGET_PERIOD_BLOCKS: u64 = 2016;
    const DIFF1_TARGET: u256 = 0x00000000FFFF0000000000000000000000000000000000000000000000000000;
    const HEADER_SIZE: u64 = 80;
    const RETARGET_PERIOD: u64 = 2 * 7 * 24 * 60 * 60;  // 2 weeks in seconds
    
    // Error codes
    const EINVALID_HEADER: u64 = 101;
    const EINVALID_MERKLE: u64 = 102;
    const EINVALID_POW: u64 = 103;  
    const EINVALID_VOUT: u64 = 104;
    const EINVALID_SCRIPT: u64 = 105;
    const EINVALID_COMPACT_INT: u64 = 106;
    const ENON_MINIMAL_COMPACT_INT: u64 = 107;
    const EINVALID_VOUT_LENGTH: u64 = 108;
    const EINVALID_OP_RETURN: u64 = 109;

    public struct DebugEvent has copy, drop {
        vec1: vector<u8>,
        vec2: vector<u8>,
        vec3: vector<u8>,
        num1: u256,
        num2: u256,
        num3: u256,
        addr1: address,
        addr2: address,
        addr3: address
    }

    public fun get_retarget_period_blocks(): u64 {
        RETARGET_PERIOD_BLOCKS
    }
    public fun index_compact_int(data: &vector<u8>, index: u64): u64 {
        let flag = *vector::borrow(data, index);
        
        if (flag <= 0xfc) {
            // For values <= 0xfc, the value is the flag itself
            flag as u64
        } else if (flag == 0xfd) {
            // For 0xfd, read next 2 bytes as little-endian
            let value = ((*vector::borrow(data, index + 1) as u64)) |
                       ((*vector::borrow(data, index + 2) as u64) << 8);
            // Verify minimal encoding
            assert!(compact_int_length(value) == 3, ENON_MINIMAL_COMPACT_INT);
            value
        } else if (flag == 0xfe) {
            // For 0xfe, read next 4 bytes as little-endian
            let value = ((*vector::borrow(data, index + 1) as u64)) |
                       ((*vector::borrow(data, index + 2) as u64) << 8) |
                       ((*vector::borrow(data, index + 3) as u64) << 16) |
                       ((*vector::borrow(data, index + 4) as u64) << 24);
            // Verify minimal encoding
            assert!(compact_int_length(value) == 5, ENON_MINIMAL_COMPACT_INT);
            value
        } else if (flag == 0xff) {
            // For 0xff, read next 8 bytes as little-endian
            let value = ((*vector::borrow(data, index + 1) as u64)) |
                       ((*vector::borrow(data, index + 2) as u64) << 8) |
                       ((*vector::borrow(data, index + 3) as u64) << 16) |
                       ((*vector::borrow(data, index + 4) as u64) << 24) |
                       ((*vector::borrow(data, index + 5) as u64) << 32) |
                       ((*vector::borrow(data, index + 6) as u64) << 40) |
                       ((*vector::borrow(data, index + 7) as u64) << 48) |
                       ((*vector::borrow(data, index + 8) as u64) << 56);
            // Verify minimal encoding
            assert!(compact_int_length(value) == 9, ENON_MINIMAL_COMPACT_INT);
            value
        } else {
            abort EINVALID_COMPACT_INT
        }
    }

    public fun compact_int_length(value: u64): u64 {
        if (value <= 0xfc) {
            1
        } else if (value <= 0xffff) {
            3
        } else if (value <= 0xffffffff) {
            5
        } else {
            9
        }
    }

    /// @notice Verifies the vout and validates its structure
    /// @param vout The vout data to verify
    /// @return true if vout is valid, false otherwise
    public fun try_as_vout(vout: &vector<u8>): bool {
        // Check if vout is empty
        if (vector::is_empty(vout)) {
            return false
        };

        // Get number of outputs
        let n_outs = index_compact_int(vout, 0);
        if (n_outs == 0) {
            return false
        };

        // Calculate initial offset after compact int
        let mut offset = compact_int_length(n_outs);
        let view_len = vector::length(vout);

        // Iterate through each output
        let mut i = 0;
        while (i < n_outs) {
            // Check if we've reached the end but still trying to read more
            if (offset >= view_len) {
                return false
            };

            // Get remaining bytes
            let mut remaining = vector::empty<u8>();
            let mut j = offset;
            while (j < view_len) {
                vector::push_back(&mut remaining, *vector::borrow(vout, j));
                j = j + 1;
            };

            // Add output length to offset
            offset = offset + output_length(&remaining);
            i = i + 1;
        };

        // Verify we've consumed exactly all bytes
        if (offset != view_len) {
            return false
        };

        true
    }

    /// @notice Calculates the length of a transaction output
    /// @param output The output data
    /// @return The length in bytes
    public fun output_length(output: &vector<u8>): u64 {
        // Value (8 bytes) + script length (compact int) + script
        let script_len = index_compact_int(output, 8);
        8 + compact_int_length(script_len) + script_len
    }

    public fun op_return_payload_big(spk: &vector<u8>): vector<u8> {
        vector::empty() // Placeholder
    }

    /// @notice Extracts the Op Return Payload
    /// @dev Structure of the input is: 1 byte op return + 1 bytes indicating the length of payload + max length for op return payload is 75 bytes
    /// @param spk The scriptPubkey
    /// @return The Op Return Payload (or empty vector if not a valid Op Return output)
    public fun op_return_payload_small(spk: &vector<u8>): vector<u8> {
        // Get total script length
        let body_length = index_compact_int(spk, 0);
        
        // Check if script is too long or too short
        if (body_length > 77 || body_length < 4) {
            return vector::empty<u8>()
        };

        // Check if first byte is OP_RETURN (0x6a)
        if (*vector::borrow(spk, 1) != 0x6a) {
            return vector::empty<u8>()
        };

        // Get payload length
        let payload_len = *vector::borrow(spk, 2) as u64;

        // Verify payload length matches script length
        if (payload_len != body_length - 2) {
            return vector::empty<u8>()
        };

        // Extract payload
        let mut payload = vector::empty<u8>();
        let mut i = 3;
        while (i < 3 + payload_len) {
            vector::push_back(&mut payload, *vector::borrow(spk, i));
            i = i + 1;
        };

        payload
    }

    public fun try_as_vin(vin: &vector<u8>): bool {
        false // Placeholder
    }

    public fun try_as_header(header: &vector<u8>): bool {
        vector::length(header) == 80
    }

    /// @notice         Index a header array.
    /// @dev            Errors on overruns
    /// @param arr      The header array
    /// @param index    The 0-indexed location of the header to get
    /// @return         the header at `index`
    public fun index_header_array(arr: &vector<u8>, index: u64): vector<u8> {
        // Verify that arr is a valid header array
        assert!(try_as_header_array(arr), EINVALID_HEADER);

        let start = index * HEADER_SIZE;
        let mut result = vector::empty<u8>();
        let mut i = 0;
        
        while (i < HEADER_SIZE) {
            vector::push_back(&mut result, *vector::borrow(arr, start + i));
            i = i + 1;
        };
        
        result
    }

    public fun try_as_header_array(arr: &vector<u8>): bool {
        vector::length(arr) % 80 == 0
    }

    /// @notice     verifies the merkle array and converts to a typed memory
    /// @dev        will return null in error cases
    /// @param arr  the merkle array
    /// @return     true if valid merkle array, false otherwise
    public fun tryAsMerkleArray(arr: &vector<u8>): bool {
        vector::length(arr) % 32 == 0
    }
    /// @notice         extracts the target from the header
    /// @param header   the header
    /// @return         the target
    public fun get_target(header: &vector<u8>): u256 {
        // Verify that arr is a valid header 
        assert!(try_as_header(header), EINVALID_HEADER);

        // Little-endian mantissa: header[72] + (header[73] << 8) + (header[74] << 16)
        let mantissa = (*vector::borrow(header, 72) as u256) |
                   ((*vector::borrow(header, 73) as u256) << 8) |
                   ((*vector::borrow(header, 74) as u256) << 16);
        
        let exponent = *vector::borrow(header, 75);
        assert!(exponent > 2, EINVALID_POW);  // Invalid target difficulty
        
       // 256 ** (exponent - 3)
        let base: u256 = 256;
        let power = exponent - 3;
        mantissa * u256_pow(base, power)
    }

    /// @notice         calculates the difficulty from a target
    /// @param target   the target
    /// @return         the difficulty
    public fun get_diff(header: &vector<u8>): u256 {
        assert!(try_as_header(header), EINVALID_HEADER);

        let target_int = get_target(header);
        assert!(target_int != 0, EINVALID_POW);  // Prevent division by zero
        DIFF1_TARGET / target_int
    }

    /// @notice         extracts the timestamp from the header
    /// @param header   the header
    /// @return         the timestamp
    public fun get_time(header: &vector<u8>): u64 {
        assert!(try_as_header(header), EINVALID_HEADER);
        // Timestamp is stored in bytes 68-71 in little-endian format
        ((*vector::borrow(header, 68) as u64)) |
        ((*vector::borrow(header, 69) as u64) << 8) |
        ((*vector::borrow(header, 70) as u64) << 16) |
        ((*vector::borrow(header, 71) as u64) << 24)
    }

    /// @notice Checks if the block header meets the difficulty target
    /// @param header The block header bytes
    /// @return True if the header hash is less than or equal to the target
    public fun check_pow(header: &vector<u8>): bool {
        assert!(try_as_header(header), EINVALID_HEADER);

        let hash = hash256(header);
        let target = get_target(header);
        
        // Convert big endian hash to little endian hash (leading zeros) u256 
        let hash_int = bytes_to_u256_reverse(&hash);
        hash_int <= target
    }

    // Helper function to convert bytes to u256, also reverse the order of the bytes
    // Convert bytes to little-endian format
    public fun bytes_to_u256_reverse(bytes: &vector<u8>): u256 {
        let mut result: u256 = 0;
        let len = vector::length(bytes);
        
        let mut i = len;
        while (i > 0) {
            i = i - 1;
            result = result << 8;
            result = result + (*vector::borrow(bytes, i) as u256);
        };
        
        result
    }

    /// @notice Computes the hash256 of a block header
    /// @param header The block header bytes
    /// @return The hash256 of the header
    public fun hash256(data: &vector<u8>): vector<u8> {
        let first_hash = std::hash::sha2_256(*data);
        std::hash::sha2_256(first_hash)
    }

    /// @notice Gets the parent hash from a block header
    /// @param header The block header bytes
    /// @return The parent hash (bytes 4-36 of the header)
    public fun get_parent(header: &vector<u8>): vector<u8> {
        assert!(try_as_header(header), EINVALID_HEADER);

        let mut result = vector::empty<u8>();
        let mut i = 4;
        while (i < 36) {
            vector::push_back(&mut result, *vector::borrow(header, i));
            i = i + 1;
        };
        result
    }

    /// @notice Gets the merkle root from a block header
    /// @param header The block header bytes
    /// @return The merkle root (bytes 36-68 of the header)
    public fun get_merkle_root(header: &vector<u8>): vector<u8> {
        assert!(try_as_header(header), EINVALID_HEADER);

        let mut result = vector::empty<u8>();
        let mut i = 36;
        while (i < 68) {
            vector::push_back(&mut result, *vector::borrow(header, i));
            i = i + 1;
        };
        result
    }

    /// @notice                     Checks validity of header chain
    /// @dev                        Compares current header parent to previous header's digest
    /// @param header              The raw bytes header
    /// @param prev_header_digest  The previous header's digest
    /// @return                    true if the connect is valid, false otherwise
    public fun check_parent(header: &vector<u8>, prev_header_digest: vector<u8>): bool {
        assert!(try_as_header(header), EINVALID_HEADER);

        let parent_hash = get_parent(header);
        parent_hash == prev_header_digest
    }

    // -----------------
    /// @notice                     Validates a tx inclusion in the block
    /// @dev                        `index` is not a reliable indicator of location within a block
    /// @param txid                The txid (LE)
    /// @param merkle_root         The merkle root
    /// @param intermediate_nodes  The proof's intermediate nodes (digests between leaf and root)
    /// @param index              The leaf's index in the tree (0-indexed)
    /// @return                    true if fully valid, false otherwise
    public fun prove(
        txid: vector<u8>,
        merkle_root: vector<u8>,
        intermediate_nodes: vector<u8>,
        index: u64
    ): bool {
        // First verify that intermediate_nodes is valid merkle array
        assert!(tryAsMerkleArray(&intermediate_nodes), EINVALID_MERKLE);

        // Shortcut the empty-block case
        if (txid == merkle_root && index == 0 && vector::length(&intermediate_nodes) == 0) {
            return true
        };

        // Check the merkle proof
        check_merkle(txid, &intermediate_nodes, merkle_root, index)
    }

    /// @notice                 performs the bitcoin difficulty retarget
    /// @dev                    implements the Bitcoin algorithm precisely
    /// @param previous_target  the target of the previous period
    /// @param first_timestamp  the timestamp of the first block in the difficulty period
    /// @param second_timestamp the timestamp of the last block in the difficulty period
    /// @return                 the new period's target threshold
    public fun retarget_algorithm(
        previous_target: u256,
        first_timestamp: u64,
        second_timestamp: u64
    ): u256 {
        let mut elapsed_time = second_timestamp - first_timestamp;

        // Normalize ratio to factor of 4 if very long or very short
        if (elapsed_time < RETARGET_PERIOD / 4) {
            elapsed_time = RETARGET_PERIOD / 4;
        };
        if (elapsed_time > RETARGET_PERIOD * 4) {
            elapsed_time = RETARGET_PERIOD * 4;
        };

        // Handle potential overflows by dividing and multiplying by 65536 (256^2)
        let adjusted = (previous_target / 65536) * (elapsed_time as u256);
        (adjusted / (RETARGET_PERIOD as u256)) * 65536
    }

    public fun equalzero(data: &vector<u8>): bool {
        let len = vector::length(data);
        let mut i = 0;
        while (i < len) {
            if (*vector::borrow(data, i) != 0) {
                return false
            };
            i = i + 1;
        };
        true
    }

    /// @notice Reverts a 32-byte input
    /// @param input 32-byte input that we want to revert
    /// @return Reverted bytes
    public fun reverse_bytes32(input: &vector<u8>): vector<u8> {
        assert!(vector::length(input) == 32, EINVALID_HEADER);
        
        let mut result = vector::empty<u8>();
        let mut i = 32;
        
        while (i > 0) {
            i = i - 1;
            vector::push_back(&mut result, *vector::borrow(input, i));
        };
        
        result
    }

    public fun hex_to_bytes(hex: &vector<u8>): vector<u8> {

        // Check if input length is a multiple of 160 (80 bytes per block header) or a period header hash
        //assert!(vector::length(hex) % 160 == 0 || vector::length(hex) % 64 == 0, 300); // EINVALID_HEADER_LENGTH
        
        let mut bytes = vector::empty<u8>();
        let mut i = 0;
        while (i < vector::length(hex)) {
            let high = hex_digit_to_val(*vector::borrow(hex, i));
            let low = hex_digit_to_val(*vector::borrow(hex, i + 1));
            vector::push_back(&mut bytes, (high << 4) | low);
            i = i + 2;
        };
        bytes
    }

    public fun hex_digit_to_val(digit: u8): u8 {
        if (digit >= 48 && digit <= 57) {  // '0' to '9'
            return digit - 48
        } else if (digit >= 97 && digit <= 102) {  // 'a' to 'f'
            return digit - 87
        } else if (digit >= 65 && digit <= 70) {  // 'A' to 'F'
            return digit - 55
        };
        0
    }



    /// @notice         verifies a merkle proof
    /// @dev            leaf, proof, and root are in LE format
    /// @param leaf     the leaf
    /// @param proof    the proof nodes
    /// @param root     the merkle root
    /// @param index    the index
    /// @return         true if valid, false if otherwise
    fun check_merkle(
        leaf: vector<u8>,
        proof: &vector<u8>,
        root: vector<u8>,
        index: u64
    ): bool {
        let nodes = vector::length(proof) / 32;
        if (nodes == 0) {
            return leaf == root
        };

        let mut idx = index;
        let mut current = leaf;

        let mut i = 0;
        while (i < nodes) {
            let mut next = vector::empty<u8>();
            let mut j = 0;
            while (j < 32) {
                vector::push_back(&mut next, *vector::borrow(proof, i * 32 + j));
                j = j + 1;
            };
            
            if (idx % 2 == 1) {
                current = merkle_step(next, current);
            } else {
                current = merkle_step(current, next);
            };
            idx = idx >> 1;
            i = i + 1;
        };

        current == root
    }

    /// @notice          Concatenates and hashes two inputs for merkle proving
    /// @param a         The first hash
    /// @param b         The second hash
    /// @return          The double-sha256 of the concatenated hashes
    fun merkle_step(a: vector<u8>, b: vector<u8>): vector<u8> {
        // Concatenate a and b
        let mut combined = vector::empty<u8>();
        vector::append(&mut combined, a);
        vector::append(&mut combined, b);
        
        // Double SHA256
        let first_hash = std::hash::sha2_256(combined);
        std::hash::sha2_256(first_hash)
    }

    // Simple u256 exponentiation function
    fun u256_pow(base: u256, exp: u8): u256 {
        let mut result = 1;
        let mut i = 0;
        while (i < exp) {
            result = result * base;
            i = i + 1;
        };
        result
    }

    /// @notice Parses the BTC amount and the op_return of a transaction
    /// @dev Finds the BTC amount that has been sent to the locking script
    /// Assumes that payload size is less than 76 bytes
    /// @param vout The vout of a Bitcoin transaction
    /// @param locking_script Desired locking script
    /// @return (bitcoin_amount, arbitrary_data) Amount of BTC sent to the locking script and opreturn data
    public fun parse_value_and_data_having_locking_script_small_payload(
        vout: &vector<u8>,
        locking_script: &vector<u8>
    ): (u64, vector<u8>) {
        // Check that vout is valid
        assert!(try_as_vout(vout), EINVALID_VOUT);

        let mut bitcoin_amount = 0u64;
        let mut arbitrary_data = vector::empty<u8>();
        
        // Get number of outputs
        let number_of_outputs = index_compact_int(vout, 0);
        
        let mut i = 0;
        while (i < number_of_outputs) {
            let output = index_vout(vout, i);
            let script_pubkey = script_pubkey(&output);
            let script_pubkey_with_length = script_pubkey_with_length(&output);
            let op_return_data = op_return_payload_small(&script_pubkey_with_length);
            // Check if this is an op_return output
            if (vector::is_empty(&op_return_data)) {
                // Not an op_return, check if it matches our locking script
                if (script_pubkey == *locking_script) {
                    bitcoin_amount = value(&output);
                }
            } else {
                // This is an op_return output, store the data
                arbitrary_data = op_return_data;
            };
            i = i + 1;
        };

        (bitcoin_amount, arbitrary_data)
    }

    /// @notice Gets the value from a Bitcoin transaction output
    /// @param output The transaction output
    /// @return The value in satoshis
    fun value(output: &vector<u8>): u64 {
        // Value is stored in the first 8 bytes in little-endian format
        ((*vector::borrow(output, 0) as u64)) |
        ((*vector::borrow(output, 1) as u64) << 8) |
        ((*vector::borrow(output, 2) as u64) << 16) |
        ((*vector::borrow(output, 3) as u64) << 24) |
        ((*vector::borrow(output, 4) as u64) << 32) |
        ((*vector::borrow(output, 5) as u64) << 40) |
        ((*vector::borrow(output, 6) as u64) << 48) |
        ((*vector::borrow(output, 7) as u64) << 56)
    }

    /// @notice Gets the script pubkey from a Bitcoin transaction output
    /// @param output The transaction output
    /// @return The script pubkey without length prefix
    fun script_pubkey(output: &vector<u8>): vector<u8> {
        let script_length = *vector::borrow(output, 8) as u64;
        let mut script = vector::empty<u8>();
        let mut i = 9;
        while (i < 9 + script_length) {
            vector::push_back(&mut script, *vector::borrow(output, i));
            i = i + 1;
        };
        script
    }

    /// @notice Gets the script pubkey with length prefix from a Bitcoin transaction output
    /// @param output The transaction output
    /// @return The script pubkey with length prefix
    fun script_pubkey_with_length(output: &vector<u8>): vector<u8> {
        let script_length = *vector::borrow(output, 8) as u64;
        let mut script = vector::empty<u8>();
        vector::push_back(&mut script, *vector::borrow(output, 8)); // Push length byte
        let mut i = 9;
        while (i < 9 + script_length) {
            vector::push_back(&mut script, *vector::borrow(output, i));
            i = i + 1;
        };
        script
    }

    /// @notice Gets a specific output from a vout array
    /// @param vout The vout array
    /// @param index The index of the output to get
    /// @return The output at the specified index
    fun index_vout(vout: &vector<u8>, index: u64): vector<u8> {
        let mut offset = compact_int_length(index_compact_int(vout, 0));
        let mut i = 0;
        while (i < index) {
            // Get the script length from the current position
            let script_len = index_compact_int(vout, offset + 8);
            // Add 8 bytes for value + script length bytes + script length
            offset = offset + 8 + compact_int_length(script_len) + script_len;
            i = i + 1;
        };
        // Get the script length for the target output
        let script_len = index_compact_int(vout, offset + 8);
        let output_len = 8 + compact_int_length(script_len) + script_len;
        let mut output = vector::empty<u8>();
        let mut j = 0;
        while (j < output_len) {
            vector::push_back(&mut output, *vector::borrow(vout, offset + j));
            j = j + 1;
        };
        output
    }

    /// @notice Calculates the required transaction Id from the transaction details
    /// @dev Calculates the hash of transaction details two consecutive times
    /// @param version Version of the transaction
    /// @param vin Inputs of the transaction
    /// @param vout Outputs of the transaction
    /// @param locktime Lock time of the transaction
    /// @return Transaction Id of the transaction (in LE form)
    public fun calculate_tx_id(
        version: vector<u8>,
        vin: vector<u8>,
        vout: vector<u8>,
        locktime: vector<u8>
    ): vector<u8> {
        // Concatenate all transaction components
        let mut tx_data = vector::empty<u8>();
        vector::append(&mut tx_data, version);
        vector::append(&mut tx_data, vin);
        vector::append(&mut tx_data, vout);
        vector::append(&mut tx_data, locktime);

        // First SHA-256 hash
        let hash1 = std::hash::sha2_256(tx_data);

        // Second SHA-256 hash
        std::hash::sha2_256(hash1)
    }

}