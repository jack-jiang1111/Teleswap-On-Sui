#[allow(unused)]
module teleswap::btcrelay {
    
    // === Imports ===
    use sui::table::{Self, Table};
    use sui::event;
    use sui::package::{Self, UpgradeCap};
    use teleswap::bitcoin_helper::{Self as BitcoinHelper}; // Helper module for Bitcoin-specific operations
    use std::debug;
    use std::address::length;
    use teleswap::bitcoin_helper::hex_to_bytes;
    use teleswap::bitcoin_helper;
    use std::vector;
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::object::{Self, UID};

    // === Error Codes ===
    // Error codes for various validation and operation failures
    const EINVALID_HEADER: u64 = 0;        // Invalid Bitcoin block header format
    const EINVALID_CHAIN: u64 = 1;         // Invalid chain linkage between blocks
    const EINVALID_POW: u64 = 2;           // Invalid proof of work
    const EINVALID_TIMESTAMP: u64 = 3;     // Invalid block timestamp
    const EINVALID_ADMIN: u64 = 4;         // Invalid admin operation
    const EINVALID_PARAMETER: u64 = 5;     // Invalid parameter value
    const EOUTDATE_HEADER: u64 = 6;        // Header is too old to be submitted
    const EPAUSED: u64 = 7;                // Contract is paused
    const EINVALID_TXID_OR_NODE: u64 = 8;  // Invalid transaction ID or Merkle tree node
    const EEARLY_BLOCK: u64 = 9;           // Block hasn't reached finalization period
    const EOUTDATE_BLOCK: u64 = 10;        // Block is too old for verification
    const EUNEXPECTED_RETARGET: u64 = 11;  // Unexpected difficulty retarget
    const EDUPLICATE_HEADER: u64 = 12;     // Duplicate block header submission
    const ERETARGET_REQUIRED: u64 = 13;    // Need to call retarget function instead
    const EALREADY_INITIALIZED: u64 = 14;  // Contract already initialized
    const EINVALID_HASH: u64 = 15;         // Invalid hash value
    const DEBUG_LOG: u64 = 8888;           // Debug logging code

    // === Constants ===
    const ONE_HUNDRED_PERCENT: u64 = 10000;        // 100% in basis points
    const MAX_FINALIZATION_PARAMETER: u64 = 432;   // Maximum finalization period (roughly 3 days)
    const MAX_ALLOWED_GAP: u64 = 5400;             // Maximum allowed time gap (90 minutes in seconds)

    // === Structs ===

    /// Admin control structure for the contract
    /// Stores initialization state and owner address
    struct RELAY_ADMIN has key, store {
        id: sui::object::UID,
        initialized: bool,
        owner: address
    }

    /// Represents a Bitcoin block header with essential information
    /// Used for storing and verifying block headers
    struct BlockHeader has store, drop, copy {
        selfHash: vector<u8>,      // Hash of this block
        parentHash: vector<u8>,    // Hash of parent block
        merkleRoot: vector<u8>,    // Merkle root of transactions
        relayer: address,          // Address of the relayer who submitted this header
    }

    /// Main contract structure for Bitcoin relay
    /// Manages the relay of Bitcoin block headers to Sui
    struct BTCRelay has key {
        id: sui::object::UID,
        initialHeight: u64,                // Starting block height
        lastSubmittedHeight: u64,          // Most recent block height
        finalizationParameter: u64,        // Number of blocks required for finalization
        relayerPercentageFee: u64,         // Fee percentage for relayers
        submissionGasUsed: u64,            // Gas used for header submission
        epochLength: u64,                  // Length of an epoch in blocks
        baseQueries: u64,                  // Base number of queries per epoch
        currentEpochQueries: u64,          // Current epoch query count
        lastEpochQueries: u64,             // Previous epoch query count
        relayGenesisHash: vector<u8>,      // Genesis block hash
        paused: bool,                      // Contract pause state
        
        chain: Table<u64, vector<BlockHeader>>,           // Maps height to block headers
        previousBlock: Table<vector<u8>, vector<u8>>,     // Maps block hash to parent hash
        blockHeight: Table<vector<u8>, u64>,              // Maps block hash to height
    }

    // === Events ===
    // Events emitted for important state changes and operations

    /// Emitted when a new block header is added to the relay
    struct BlockAdded has copy, drop {
        height: u64,
        self_hash: vector<u8>,
        parent_hash: vector<u8>,
        relayer: address
    }

    /// Emitted when a block header is finalized
    struct BlockFinalized has copy, drop {
        height: u64,
        self_hash: vector<u8>,
        parent_hash: vector<u8>,
        relayer: address,
    }

    /// Emitted when a new transaction verification query is made
    struct NewQuery has copy, drop {
        tx_id: vector<u8>,
        block_height: u64,
    }

    /// Emitted when finalization parameter is updated
    struct NewFinalizationParameter has copy, drop {
        oldFinalizationParameter: u64,
        newFinalizationParameter: u64
    }

    /// Emitted when relayer fee percentage is updated
    struct NewRelayerPercentageFee has copy, drop {
        oldRelayerPercentageFee: u64,
        newRelayerPercentageFee: u64
    }

    /// Emitted when epoch length is updated
    struct NewEpochLength has copy, drop {
        oldEpochLength: u64,
        newEpochLength: u64
    }

    /// Emitted when base queries parameter is updated
    struct NewBaseQueries has copy, drop {
        oldBaseQueries: u64,
        newBaseQueries: u64
    }

    /// Emitted when submission gas used parameter is updated
    struct NewSubmissionGasUsed has copy, drop {
        oldSubmissionGasUsed: u64,
        newSubmissionGasUsed: u64
    }

    /// Debug event for development and troubleshooting
    struct DebugEvent has copy, drop {
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

    // === Public Functions ===

    /// Adds Bitcoin block headers to the relay with difficulty retargeting
    /// @param old_period_start_header First header in the difficulty period being closed
    /// @param old_period_end_header Last header in the difficulty period being closed
    /// @param headers Tightly-packed list of 80-byte Bitcoin headers
    /// @return True if successfully written, error otherwise
    public entry fun addHeadersWithRetarget(
        relay: &mut BTCRelay,
        old_period_start_header: vector<u8>,
        old_period_end_header: vector<u8>,
        headers: vector<u8>,
        ctx: &mut TxContext
    ): bool {
        // Check if contract is not paused
        assert!(!relay.paused, EPAUSED);

        // Convert hex strings to bytes
        let old_period_start_header_bytes = BitcoinHelper::hex_to_bytes(&old_period_start_header);
        let old_period_end_header_bytes = BitcoinHelper::hex_to_bytes(&old_period_end_header);
        let headers_bytes = BitcoinHelper::hex_to_bytes(&headers);

        // Validate input sizes
        check_input_size_add_headers_with_retarget(
            &old_period_start_header_bytes,
            &old_period_end_header_bytes,
            &headers_bytes
        );

        // Add headers with retarget validation
        add_headers_with_retarget(
            relay,
            &old_period_start_header_bytes,
            &old_period_end_header_bytes,
            &headers_bytes,
            ctx
        )
    }

    /// Adds Bitcoin block headers to the relay without difficulty retargeting
    /// @param anchor The header immediately preceding the new chain, in hex format without 0x prefix
    /// @param headers Tightly-packed list of Bitcoin headers, in hex format without 0x prefix
    /// @return True if successfully written, error otherwise
    public fun addHeaders(
        relay: &mut BTCRelay,
        anchor: vector<u8>,
        headers: vector<u8>,
        ctx: &mut TxContext
    ): bool {
        // Check if contract is not paused
        assert!(!relay.paused, EPAUSED);

        // Convert hex strings to bytes
        let anchor_bytes = BitcoinHelper::hex_to_bytes(&anchor);
        let headers_bytes = BitcoinHelper::hex_to_bytes(&headers);

        // Validate input sizes
        check_input_size_add_headers(&headers_bytes, &anchor_bytes);

        // Add headers to the relay
        add_headers(relay, &anchor_bytes, &headers_bytes, false, ctx)
    }

    /// Verifies if a Bitcoin transaction is included and finalized in a block
    /// @param txid Transaction ID in little-endian format (hex format without 0x prefix)
    /// @param block_height Height of the block containing the transaction
    /// @param intermediate_nodes Merkle proof nodes from transaction to root (hex format without 0x prefix)
    /// @param index Position of transaction in the block
    /// @return True if transaction is confirmed on Bitcoin
    public fun checkTxProof(
            relay: &mut BTCRelay,
            txid: vector<u8>,
            block_height: u64,
            intermediate_nodes: vector<u8>,
            index: u64,
        ): bool {
            // Check if contract is not paused
            assert!(!relay.paused, EPAUSED);

            // Convert hex strings to bytes
            let txid_bytes = BitcoinHelper::hex_to_bytes(&txid);
            let intermediate_nodes_bytes = BitcoinHelper::hex_to_bytes(&intermediate_nodes);

            // Validate transaction ID
            assert!(!vector::is_empty(&txid_bytes), EINVALID_TXID_OR_NODE);
            assert!(!BitcoinHelper::equalzero(&txid_bytes), EINVALID_TXID_OR_NODE);
            assert!(vector::length(&txid_bytes) == 32, EINVALID_TXID_OR_NODE);
            assert!(vector::length(&intermediate_nodes_bytes) == 160, EINVALID_TXID_OR_NODE);

            // Validate block height and finalization
            assert!(block_height >= relay.initialHeight, EOUTDATE_BLOCK);
            assert!(
                block_height + relay.finalizationParameter < relay.lastSubmittedHeight + 1,
                EEARLY_BLOCK
            );

            // Get block header and merkle root
            let headers = table::borrow(&relay.chain, block_height);
            let block_header = vector::borrow(headers, 0);
            let merkle_root = block_header.merkleRoot;

            // Emit query event
            event::emit(NewQuery {
                tx_id: txid_bytes,
                block_height,
            });

            // Verify merkle proof
            BitcoinHelper::prove(txid_bytes, merkle_root, intermediate_nodes_bytes, index)
    }

    // === View Functions ===
    /// Returns the genesis block hash of the relay
    public fun relayGenesisHash(relay: &BTCRelay): vector<u8> { *&relay.relayGenesisHash }
    
    /// Returns the initial block height of the relay
    public fun initialHeight(relay: &BTCRelay): u64 { relay.initialHeight }
    
    /// Returns the most recently submitted block height
    public fun lastSubmittedHeight(relay: &BTCRelay): u64 { relay.lastSubmittedHeight }
    
    /// Returns the number of blocks required for finalization
    public fun finalizationParameter(relay: &BTCRelay): u64 { relay.finalizationParameter }
    
    /// Returns the percentage fee for relayers
    public fun relayerPercentageFee(relay: &BTCRelay): u64 { relay.relayerPercentageFee }
    
    /// Returns the length of an epoch in blocks
    public fun epochLength(relay: &BTCRelay): u64 { relay.epochLength }
    
    /// Returns the number of queries in the last epoch
    public fun lastEpochQueries(relay: &BTCRelay): u64 { relay.lastEpochQueries }
    
    /// Returns the current number of queries in this epoch
    public fun currentEpochQueries(relay: &BTCRelay): u64 { relay.currentEpochQueries }
    
    /// Returns the base number of queries per epoch
    public fun baseQueries(relay: &BTCRelay): u64 { relay.baseQueries }
    
    /// Returns the gas used for header submission
    public fun submissionGasUsed(relay: &BTCRelay): u64 { relay.submissionGasUsed }
    
    /// Returns the hash of a specific block header
    /// @param height Block height
    /// @param index Index of the header at that height
    /// @return Block header hash in little-endian format
    public fun getBlockHeaderHash(relay: &BTCRelay, height: u64, index: u64): vector<u8> {
        let headers = table::borrow(&relay.chain, height);
        // convert bytes to hex, reversing the order. So the zeros are at the beginning
        BitcoinHelper::reverse_bytes32(&vector::borrow(headers, index).selfHash)
    }
    
    /// Returns the number of block headers at a specific height
    /// @param height Block height to check
    /// @return Number of block headers at that height
    public fun getNumberOfSubmittedHeaders(relay: &BTCRelay, height: u64): u64 {
        let headers = table::borrow(&relay.chain, height);
        vector::length(headers)
    }

    /// Finds the height of a block header by its hash
    /// @param hash Block header hash in big-endian format
    /// @return Height of the block header
    public entry fun find_height(relay: &BTCRelay, hash: vector<u8>): u64 {
        assert!(table::contains(&relay.blockHeight, hash), EINVALID_HASH);
        *table::borrow(&relay.blockHeight, hash)
    }

    // === Admin Functions ===

    /// Updates the finalization parameter (number of blocks required for finalization)
    /// @param parameter New finalization parameter value
    public entry fun setFinalizationParameter(
        relay: &mut BTCRelay, 
        parameter: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate parameter is within allowed range
        assert!(
            parameter > 0 && parameter <= MAX_FINALIZATION_PARAMETER,
            EINVALID_PARAMETER
        );

        // Emit event for parameter change
        event::emit(NewFinalizationParameter {
            oldFinalizationParameter: relay.finalizationParameter,
            newFinalizationParameter: parameter
        });

        // Update parameter
        relay.finalizationParameter = parameter;
    }

    /// Updates the percentage fee for relayers
    /// @param fee New percentage fee (in basis points)
    public entry fun set_relayer_percentage_fee(
        relay: &mut BTCRelay, 
        fee: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate fee is not more than 100%
        assert!(fee <= ONE_HUNDRED_PERCENT, EINVALID_PARAMETER);

        // Emit event for fee change
        event::emit(NewRelayerPercentageFee {
            oldRelayerPercentageFee: relay.relayerPercentageFee,
            newRelayerPercentageFee: fee
        });

        // Update fee
        relay.relayerPercentageFee = fee;
    }

    /// Updates the length of an epoch in blocks
    /// @param length New epoch length
    public entry fun set_epoch_length(
        relay: &mut BTCRelay, 
        length: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate length is positive
        assert!(length > 0, EINVALID_PARAMETER);

        // Emit event for epoch length change
        event::emit(NewEpochLength {
            oldEpochLength: relay.epochLength,
            newEpochLength: length
        });

        // Update epoch length
        relay.epochLength = length;
    }
    
    /// Updates the base number of queries per epoch
    /// @param queries New base query count
    public entry fun set_base_queries(
        relay: &mut BTCRelay, 
        queries: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate queries is positive
        assert!(queries > 0, EINVALID_PARAMETER);

        // Emit event for base queries change
        event::emit(NewBaseQueries {
            oldBaseQueries: relay.baseQueries,
            newBaseQueries: queries
        });

        // Update base queries
        relay.baseQueries = queries;
    }
    
    /// Updates the gas used for header submission
    /// @param gas New gas amount
    public entry fun set_submission_gas_used(
        relay: &mut BTCRelay, 
        gas: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate gas is positive
        assert!(gas > 0, EINVALID_PARAMETER);

        // Emit event for gas change
        event::emit(NewSubmissionGasUsed {
            oldSubmissionGasUsed: relay.submissionGasUsed,
            newSubmissionGasUsed: gas
        });

        // Update gas
        relay.submissionGasUsed = gas;
    }

    /// Pauses the relay contract
    public entry fun pause_relay(
        relay: &mut BTCRelay, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        relay.paused = true;
    }

    /// Unpauses the relay contract
    public entry fun unpause_relay(
        relay: &mut BTCRelay, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        relay.paused = false;
    }

    /// Renounces admin ownership by transferring control to zero address
    public entry fun renounce_admin_ownership(
        admin: RELAY_ADMIN,
        upgrade_cap: UpgradeCap,
        ctx: &TxContext
    ) {
        // Verify caller is admin
        assert!(tx_context::sender(ctx) == admin.owner, EINVALID_ADMIN);
        
        // Transfer admin control to zero address
        transfer::public_transfer(admin, @0x0);
        
        // Transfer upgrade capability to zero address
        transfer::public_transfer(upgrade_cap, @0x0);
    }

    /// Admin-only version of addHeaders that works even when contract is paused
    /// Used for handling chain forks
    public entry fun ownerAddHeaders(
        relay: &mut BTCRelay,
        anchor: vector<u8>,
        headers: vector<u8>,
        admin: &RELAY_ADMIN,
        ctx: &mut TxContext
    ): bool {
        // Convert hex strings to bytes
        let anchor_bytes = BitcoinHelper::hex_to_bytes(&anchor);
        let headers_bytes = BitcoinHelper::hex_to_bytes(&headers);

        // Validate input sizes
        check_input_size_add_headers(&headers_bytes, &anchor_bytes);

        // Add headers to relay
        add_headers(relay, &anchor_bytes, &headers_bytes, false, ctx)
    }

    /// Admin-only version of addHeadersWithRetarget that works even when contract is paused
    /// Used for handling chain forks
    public entry fun ownerAddHeadersWithRetarget(
        relay: &mut BTCRelay,
        old_period_start_header: vector<u8>,
        old_period_end_header: vector<u8>,
        headers: vector<u8>,
        admin: &RELAY_ADMIN,
        ctx: &mut TxContext
    ): bool {
        // Convert hex strings to bytes
        let old_period_start_header_bytes = BitcoinHelper::hex_to_bytes(&old_period_start_header);
        let old_period_end_header_bytes = BitcoinHelper::hex_to_bytes(&old_period_end_header);
        let headers_bytes = BitcoinHelper::hex_to_bytes(&headers);

        // Validate input sizes
        check_input_size_add_headers_with_retarget(
            &old_period_start_header_bytes,
            &old_period_end_header_bytes,
            &headers_bytes
        );

        // Add headers with retarget validation
        add_headers_with_retarget(
            relay,
            &old_period_start_header_bytes,
            &old_period_end_header_bytes,
            &headers_bytes,
            ctx
        )
    }
    
    // === Package Functions ===

    /// Initializes the package when published
    /// Creates and transfers the RELAY_ADMIN object to the deployer
    fun init(ctx: &mut TxContext) {
        // Create and transfer the RELAY_ADMIN object to the sender
        transfer::transfer(RELAY_ADMIN { 
            id: object::new(ctx),
            initialized: false,
            owner: tx_context::sender(ctx)
        }, tx_context::sender(ctx));
    }
    
    /// Initializes the Bitcoin relay with genesis block and parameters
    /// @param genesis_header_hex Genesis block header in hex format (big-endian)
    /// @param height Initial block height
    /// @param period_start_hash Start of difficulty period in hex format (little-endian) (hash value of the start of the period)
    /// @param finalization_parameter Number of blocks required for finalization
    public entry fun initialize(
        genesis_header_hex: vector<u8>,
        height: u64,
        period_start_hash: vector<u8>,
        finalization_parameter: u64,
        admin: &mut RELAY_ADMIN,
        ctx: &mut TxContext
    ) {
        // Check if already initialized
        assert!(!admin.initialized, EALREADY_INITIALIZED);
        
        // Mark as initialized
        admin.initialized = true;

        // Validate finalization parameter
        assert!(finalization_parameter > 0 && finalization_parameter <= MAX_FINALIZATION_PARAMETER, EINVALID_PARAMETER);
        
        // Convert hex strings to bytes
        let genesis_header = BitcoinHelper::hex_to_bytes(&genesis_header_hex);
        let period_start = BitcoinHelper::hex_to_bytes(&period_start_hash);
       
        // Validate genesis header size
        assert!(
            vector::length(&genesis_header) == 80,
            EINVALID_HEADER
        );

        // Get genesis hash and create initial block header
        let genesis_hash = BitcoinHelper::hash256(&genesis_header);
        let new_block_header = BlockHeader {
            selfHash: genesis_hash,
            parentHash: BitcoinHelper::get_parent(&genesis_header),
            merkleRoot: BitcoinHelper::get_merkle_root(&genesis_header),
            relayer: tx_context::sender(ctx),
        };

        // Initialize chain storage
        let chain = table::new<u64, vector<BlockHeader>>(ctx);
        let previous_block = table::new<vector<u8>, vector<u8>>(ctx);
        let block_height = table::new<vector<u8>, u64>(ctx);
        
        // Add genesis header to chain
        let headers = vector::empty<BlockHeader>();
        vector::push_back(&mut headers, new_block_header);
        table::add(&mut chain, height, headers);

        // Store block heights
        table::add(&mut block_height, genesis_hash, height);
        if(height % BitcoinHelper::get_retarget_period_blocks()!=0){
            // If genesis header is not a target header, add period start to table
            table::add(&mut block_height, period_start, height - (height % BitcoinHelper::get_retarget_period_blocks()));
        };
        
        // Create and share relay object
        let relay = BTCRelay {
            id: object::new(ctx),
            initialHeight: height,
            lastSubmittedHeight: height,
            finalizationParameter: finalization_parameter,
            relayerPercentageFee: 500,
            submissionGasUsed: 300000,
            epochLength: BitcoinHelper::get_retarget_period_blocks(),
            baseQueries: BitcoinHelper::get_retarget_period_blocks(),
            currentEpochQueries: 0,
            lastEpochQueries: BitcoinHelper::get_retarget_period_blocks(),
            relayGenesisHash: genesis_hash,
            paused: false,
            chain,
            previousBlock: previous_block,
            blockHeight: block_height,
        };

        // Share relay object
        transfer::share_object(relay);
    }

    // === Private Functions ===

    /// Internal function to add headers to the relay
    /// @param anchor Anchor block header
    /// @param headers Headers to add
    /// @param internal Whether this is an internal call
    fun add_headers(
        relay: &mut BTCRelay,
        anchor: &vector<u8>,
        headers: &vector<u8>,
        internal: bool,
        ctx: & TxContext
    ): bool {
        // Get basic info from anchor
        let previous_hash = BitcoinHelper::hash256(anchor);
        let anchor_height = find_height(relay, previous_hash);
        let target = BitcoinHelper::get_target(&BitcoinHelper::index_header_array(headers, 0));
        
        // Validate target matches anchor unless internal call
        assert!(
            internal || BitcoinHelper::get_target(anchor) == target,
            EUNEXPECTED_RETARGET
        );

        // Validate header is not too old
        assert!(
            anchor_height + 1 + relay.finalizationParameter > relay.lastSubmittedHeight,
            EOUTDATE_HEADER
        );

        /*
            1. check that the blockheader is not a replica
            2. check blocks are in the same epoch regarding difficulty
            3. check that headers are in a coherent chain (no retargets, hash links good)
            4. check that the header has sufficient work
            5. Store the block connection
            6. Store the height
            7. store the block in the chain
        */
        let height;
        let current_hash;
        let headers_len = vector::length(headers) / 80;
        let i = 0;
        
        while (i < headers_len) {
            let header = BitcoinHelper::index_header_array(headers, i);
            height = anchor_height + i + 1;
            current_hash = BitcoinHelper::hash256(&header);

            // Check for duplicate header
            assert!(
                !table::contains(&relay.previousBlock, current_hash),
                EDUPLICATE_HEADER
            );
            
            // Blocks that are multiplies of 2016 should be submitted using addHeadersWithRetarget
            assert!(
                internal || height % BitcoinHelper::get_retarget_period_blocks() != 0,
                ERETARGET_REQUIRED
            );

            // Validate timestamp
            let current_time_ms = tx_context::epoch_timestamp_ms(ctx);
            let current_time_seconds = current_time_ms / 1000;
            assert!(
                BitcoinHelper::get_time(&header) <= current_time_seconds + MAX_ALLOWED_GAP,
                EINVALID_TIMESTAMP
            );
            
            // Check target hasn't changed
            assert!(
                BitcoinHelper::get_target(&header) == target,
                EINVALID_POW
            );

            // Check parent hash matches
            assert!(
                BitcoinHelper::get_parent(&header) == previous_hash,
                EINVALID_CHAIN
            );

            // Validate proof of work
            assert!(
                BitcoinHelper::check_pow(&header),
                EINVALID_POW
            );

            // Store block connection and height
            table::add(&mut relay.previousBlock, current_hash, previous_hash);
            table::add(&mut relay.blockHeight, current_hash, height);

            // Emit block added event
            event::emit(BlockAdded {
                height,
                self_hash: current_hash,
                parent_hash: previous_hash,
                relayer: tx_context::sender(ctx)
            });
            
            // Add to chain
            add_to_chain(relay, &header, height, ctx);

            previous_hash = current_hash;
            i = i + 1;
        };

        true
    }

    /// Internal function to add headers with difficulty retargeting
    /// @param old_start First header in old difficulty period
    /// @param old_end Last header in old difficulty period
    /// @param headers New headers to add
    fun add_headers_with_retarget(
        relay: &mut BTCRelay,
        old_start: &vector<u8>,
        old_end: &vector<u8>,
        headers: &vector<u8>,
        ctx: & TxContext
    ): bool {
        // Get block heights
        let start_hash = BitcoinHelper::hash256(old_start);
        let end_hash = BitcoinHelper::hash256(old_end);
        event::emit(BlockAdded {
            height: 0,
            self_hash: start_hash,
            parent_hash: *old_start,
            relayer: tx_context::sender(ctx)
        });

        let start_height = find_height(relay, start_hash);
        let end_height = find_height(relay, end_hash);

        // Validate retarget intervals
        assert!(
            end_height % BitcoinHelper::get_retarget_period_blocks() == 2015,
            EINVALID_HEADER
        );
        assert!(
            end_height == start_height + 2015,
            EINVALID_HEADER
        );

        // Validate difficulty period
        assert!(
            BitcoinHelper::get_diff(old_start) == BitcoinHelper::get_diff(old_end),
            EINVALID_POW
        );

        // Calculate and validate new target
        let new_start = BitcoinHelper::index_header_array(headers, 0);
        let actual_target = BitcoinHelper::get_target(&new_start);
        let expected_target = BitcoinHelper::retarget_algorithm(
            BitcoinHelper::get_target(old_start),
            BitcoinHelper::get_time(old_start),
            BitcoinHelper::get_time(old_end)
        );

        // Verify target matches expected using bitwise AND
        assert!(
            (actual_target & expected_target) == actual_target,
            EINVALID_POW
        );

        // Add headers to chain
        add_headers(relay, old_end, headers, true, ctx)
    }

    /// Validates input sizes for addHeaders
    fun check_input_size_add_headers(headers_view: &vector<u8>, anchor_view: &vector<u8>) {
        assert!(
            !vector::is_empty(headers_view) && vector::length(headers_view) % 80 == 0 
                && !vector::is_empty(anchor_view) && vector::length(anchor_view) == 80,
            EINVALID_HEADER
        );
    }

    /// Validates input sizes for addHeadersWithRetarget
    fun check_input_size_add_headers_with_retarget(
        old_start_header: &vector<u8>,
        old_end_header: &vector<u8>,
        headers_view: &vector<u8>
    ) {
        assert!(
            !vector::is_empty(old_start_header) && vector::length(old_start_header) == 80 
         && !vector::is_empty(old_end_header) && vector::length(old_end_header) == 80
         && !vector::is_empty(headers_view) && vector::length(headers_view) % 80 == 0,
            EINVALID_HEADER
        );
    }

    /// Adds a header to the chain and handles finalization
    /// @param header New block header
    /// @param height Block height
    fun add_to_chain(relay: &mut BTCRelay, header: &vector<u8>, height: u64, ctx: &TxContext) {
        // Validate header is not too old
        assert!(
            height + relay.finalizationParameter > relay.lastSubmittedHeight,
            EOUTDATE_HEADER
        );

        // Create new block header
        let new_block_header = BlockHeader {
            selfHash: BitcoinHelper::hash256(header),
            parentHash: BitcoinHelper::get_parent(header),
            merkleRoot: BitcoinHelper::get_merkle_root(header),
            relayer: tx_context::sender(ctx),
        };

        // Add header to chain
        if (table::contains(&relay.chain, height)) {
            let headers = table::borrow_mut(&mut relay.chain, height);
            vector::push_back(headers, new_block_header);
        } else {
            let headers = vector::empty<BlockHeader>();
            vector::push_back(&mut headers, new_block_header);
            table::add(&mut relay.chain, height, headers);
        };

        // Update state and handle finalization
        if (height > relay.lastSubmittedHeight) {
            relay.lastSubmittedHeight = relay.lastSubmittedHeight + 1;
            update_fee(relay);
            prune_chain(relay);
        };
    }

    /// Updates fee parameters at epoch boundaries
    fun update_fee(relay: &mut BTCRelay) {
        if (relay.lastSubmittedHeight % relay.epochLength == 0) {
            relay.lastEpochQueries = if (relay.currentEpochQueries < relay.baseQueries) { 
                relay.baseQueries 
            } else { 
                relay.currentEpochQueries 
            };
            relay.currentEpochQueries = 0;
        }
    }

    /// Finalizes blocks and prunes the chain
    /// Removes all headers except the finalized one at each height
    fun prune_chain(relay: &mut BTCRelay) {
        // Ensure minimum chain length for finalization
        if ((relay.lastSubmittedHeight - relay.initialHeight) >= relay.finalizationParameter) {
            let idx = relay.finalizationParameter;
            let current_height = relay.lastSubmittedHeight;
            let stable_idx = 0;
            
            // Find the stable idx
            while (idx > 0) {
                let headers = table::borrow(&relay.chain, current_height);
                let parent_header_hash = vector::borrow(headers, stable_idx).parentHash;
                stable_idx = find_index(relay, parent_header_hash, current_height - 1);
                idx = idx - 1;
                current_height = current_height - 1;
            };

            // Keep only the finalized header
            let headers = table::borrow_mut(&mut relay.chain, current_height);
            let finalized_header = *vector::borrow(headers, stable_idx);
            
            if (vector::length(headers) > 1) {
                // prune height, remove all headers
                while (vector::length(headers) > 0) {
                    let removed_header = vector::pop_back(headers);
                    if(removed_header.selfHash != finalized_header.selfHash) {
                        // Remove the extra headers from previousBlock and blockHeight hashtables
                        table::remove(&mut relay.previousBlock, removed_header.selfHash);
                        table::remove(&mut relay.blockHeight, removed_header.selfHash);
                    };
                };
                // Add the finalized header back to the empty vector
                vector::push_back(headers, finalized_header);
            };

            // Emit finalization event
            event::emit(BlockFinalized {
                height: current_height,
                self_hash: finalized_header.selfHash,
                parent_hash: finalized_header.parentHash,
                relayer: finalized_header.relayer
            });
        }
    }

    /// Finds the index of a block header in a specific height
    /// @param header_hash Block header hash
    /// @param height Block height to search
    /// @return Index of the block header
    fun find_index(relay: &BTCRelay, header_hash: vector<u8>, height: u64): u64 {
        let headers = table::borrow(&relay.chain, height);
        let len = vector::length(headers);
        let i = 0;
        while (i < len) {
            if (vector::borrow(headers, i).selfHash == header_hash) {
                return i
            };
            i = i + 1;
        };
        0 // Return 0 if not found
    } 
}

/*
    event::emit(DebugEvent {
        vec1: vector::empty<u8>(), // Not using vectors for this debug
        vec2: vector::empty<u8>(),
        vec3: vector::empty<u8>(),
        num1: 1,
        num2: 2,
        num3: 3,
        addr1: @0x0, // Not using addresses for this debug
        addr2: @0x0,
        addr3: @0x0
    });
    return true;
*/
