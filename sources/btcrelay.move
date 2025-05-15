#[allow(unused)]
module teleswap::btcrelay {
    
    // === Imports ===
    use sui::table::{Self, Table};
    use sui::event;
    use sui::package::{Self, UpgradeCap};
    use teleswap::bitcoin_helper::{Self as BitcoinHelper}; // Add this line

    // === Errors ===
    const EINVALID_HEADER: u64 = 0;
    const EINVALID_CHAIN: u64 = 1;
    const EINVALID_POW: u64 = 2;
    const EINVALID_TIMESTAMP: u64 = 3;
    const EINVALID_ADMIN: u64 = 4;
    const EINVALID_PARAMETER: u64 = 5;
    const EOUTDATE_HEADER: u64 = 6;
    const EPAUSED: u64 = 7;
    const EINVALID_TXID: u64 = 8; // txid == 0
    const EEARLY_BLOCK: u64 = 9; // the block hasn't finalized yet
    const EOUTDATE_BLOCK: u64 = 10; // the block is too old
    const EUNEXPECTED_RETARGET: u64 = 11; // BitcoinRelay: unexpected retarget on external call
    const EDUPLICATE_HEADER: u64 = 12; // txid == 0
    const ERETARGET_REQUIRED: u64 = 13; // BitcoinRelay: retarget required on external call
    const EALREADY_INITIALIZED: u64 = 14;

    // === Constants ===
    const ONE_HUNDRED_PERCENT: u64 = 10000;
    const MAX_FINALIZATION_PARAMETER: u64 = 432; // roughly 3 days
    const MAX_ALLOWED_GAP: u64 = 5400; // 90 minutes in seconds

    // === Structs ===

    // This struct is used to track the admin of the contract
    public struct RELAY_ADMIN has key, store {
        id: UID,
        initialized: bool,
        owner: address
    }

    public struct BlockHeader has store, drop, copy {
        selfHash: vector<u8>,
        parentHash: vector<u8>,
        merkleRoot: vector<u8>,
        relayer: address,
    }

    public struct BTCRelay has key {
        id: UID,
        initialHeight: u64,
        lastSubmittedHeight: u64,
        finalizationParameter: u64,
        relayerPercentageFee: u64,
        submissionGasUsed: u64,
        epochLength: u64,
        baseQueries: u64,
        currentEpochQueries: u64,
        lastEpochQueries: u64,
        relayGenesisHash: vector<u8>, // byte32
        paused: bool,
        
        chain: Table<u64, vector<BlockHeader>>, // height => list of block headers
        previousBlock: Table<vector<u8>, vector<u8>>, // block header hash => parent header hash
        blockHeight: Table<vector<u8>, u64>, // block header hash => block height
    }

    // === Events ===
    public struct BlockAdded has copy, drop {
        height: u64,
        self_hash: vector<u8>,
        parent_hash: vector<u8>,
        relayer: address
    }

    public struct BlockFinalized has copy, drop {
        height: u64,
        self_hash: vector<u8>,
        parent_hash: vector<u8>,
        relayer: address,
    }

    public struct NewQuery has copy, drop {
        tx_id: vector<u8>,
        block_height: u64,
    }

    public struct NewFinalizationParameter has copy, drop {
        oldFinalizationParameter: u64,
        newFinalizationParameter: u64
    }

    public struct NewRelayerPercentageFee has copy, drop {
        oldRelayerPercentageFee: u64,
        newRelayerPercentageFee: u64
    }

    public struct NewEpochLength has copy, drop {
        oldEpochLength: u64,
        newEpochLength: u64
    }

    public struct NewBaseQueries has copy, drop {
        oldBaseQueries: u64,
        newBaseQueries: u64
    }

    public struct NewSubmissionGasUsed has copy, drop {
        oldSubmissionGasUsed: u64,
        newSubmissionGasUsed: u64
    }
    

    // === Public Functions ===

    /// @dev Checks the retarget, the heights, and the linkage
    /// @param old_period_start_header The first header in the difficulty period being closed
    /// @param old_period_end_header The last header in the difficulty period being closed (anchor of new headers)
    /// @param headers A tightly-packed list of 80-byte Bitcoin headers
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

        // Check input sizes
        check_input_size_add_headers_with_retarget(
            &old_period_start_header,
            &old_period_end_header,
            &headers
        );

        // Call internal function to add headers with retarget
        add_headers_with_retarget(
            relay,
            &old_period_start_header,
            &old_period_end_header,
            &headers,
            ctx
        )
    }

    /// @notice Adds headers to storage after validating
    /// @dev Checks integrity and consistency of the header chain
    /// @param anchor The header immediately preceeding the new chain
    /// @param headers A tightly-packed list of 80-byte Bitcoin headers
    /// @return True if successfully written, error otherwise
    public fun addHeaders(
        relay: &mut BTCRelay,
        anchor: vector<u8>,
        headers: vector<u8>,
        ctx: &mut TxContext
    ): bool {
        // Check if contract is not paused
        assert!(!relay.paused, EPAUSED);

        // Check input sizes
        check_input_size_add_headers(&headers, &anchor);

        // Call internal function to add headers
        add_headers(relay, &anchor, &headers, false,ctx)
    }

    /// @notice Checks if a tx is included and finalized on Bitcoin
    /// @dev Checks if the block is finalized, and Merkle proof is valid
    /// @param _txid Desired tx Id in LE form
    /// @param _blockHeight of the desired tx
    /// @param _intermediateNodes Part of the Merkle tree from the tx to the root in LE form (called Merkle proof)
    /// @param _index of the tx in Merkle tree
    /// @return True if the provided tx is confirmed on Bitcoin
    public fun checkTxProof(
            relay: &mut BTCRelay,
            txid: vector<u8>,
            block_height: u64,
            intermediate_nodes: vector<u8>,
            index: u64,
        ): bool {
            // Check if contract is not paused
            assert!(!relay.paused, EPAUSED);

            // Check that txid is not empty and not all zeros
            assert!(!vector::is_empty(&txid), EINVALID_TXID);

            // Check that txid is not all zeros
            assert!(!BitcoinHelper::equalzero(&txid), EINVALID_TXID);

            // Check if block is finalized
            assert!(
                block_height + relay.finalizationParameter < relay.lastSubmittedHeight + 1,
                EEARLY_BLOCK
            );

            // Check if block exists on relay
            assert!(
                block_height >= relay.initialHeight,
                EOUTDATE_BLOCK
            );

            // Get the block header at the specified height
            let headers = table::borrow(&relay.chain, block_height);
            let block_header = vector::borrow(headers, 0);

            // Get merkle root from the block header
            let merkle_root = block_header.merkleRoot;

            // Emit new query event
            event::emit(NewQuery {
                tx_id: txid,
                block_height,
            });

            // Verify the merkle proof
            BitcoinHelper::prove(txid, merkle_root, intermediate_nodes, index)
    }

    // === View Functions ===
    public fun relayGenesisHash(relay: &BTCRelay): vector<u8> { *&relay.relayGenesisHash }
    
    public fun initialHeight(relay: &BTCRelay): u64 { relay.initialHeight }
    
    public fun lastSubmittedHeight(relay: &BTCRelay): u64 { relay.lastSubmittedHeight }
    
    public fun finalizationParameter(relay: &BTCRelay): u64 { relay.finalizationParameter }
    
    public fun relayerPercentageFee(relay: &BTCRelay): u64 { relay.relayerPercentageFee }
    
    public fun epochLength(relay: &BTCRelay): u64 { relay.epochLength }
    
    public fun lastEpochQueries(relay: &BTCRelay): u64 { relay.lastEpochQueries }
    
    public fun currentEpochQueries(relay: &BTCRelay): u64 { relay.currentEpochQueries }
    
    public fun baseQueries(relay: &BTCRelay): u64 { relay.baseQueries }
    
    public fun submissionGasUsed(relay: &BTCRelay): u64 { relay.submissionGasUsed }
    
    /// @notice Getter for a specific block header's hash in the stored chain
    /// @param  _height of the desired block header
    /// @param  _index of the desired block header in that height
    /// @return Block header's hash
    public fun getBlockHeaderHash(relay: &BTCRelay, height: u64, index: u64): vector<u8> {
        let headers = table::borrow(&relay.chain, height);
        vector::borrow(headers, index).selfHash
    }
    
    /// @notice Getter for the number of submitted block headers in a height
    /// @dev This shows the number of temporary forks in that specific height
    /// @param  _height The desired height of the blockchain
    /// @return Number of block headers stored in a height
    public fun getNumberOfSubmittedHeaders(relay: &BTCRelay, height: u64): u64 {
        let headers = table::borrow(&relay.chain, height);
        vector::length(headers)
    }

    
    // === Admin Functions ===
    ///  @notice setter for finalizationParameter Owner only
    ///  @param parameter The new finalization parameter
    public entry fun setFinalizationParameter(
        relay: &mut BTCRelay, 
        parameter: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate parameter
        assert!(
            parameter > 0 && parameter <= MAX_FINALIZATION_PARAMETER,
            EINVALID_PARAMETER
        );

        // Emit event
        event::emit(NewFinalizationParameter {
            oldFinalizationParameter: relay.finalizationParameter,
            newFinalizationParameter: parameter
        });

        // Update state
        relay.finalizationParameter = parameter;
    }

    /// @notice Setter for relayerPercentageFee
    /// @dev A percentage of the submission gas used goes to Relayers as reward
    /// @param fee New percentage fee
    public entry fun set_relayer_percentage_fee(
        relay: &mut BTCRelay, 
        fee: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate fee
        assert!(fee <= ONE_HUNDRED_PERCENT, EINVALID_PARAMETER);

        // Emit event
        event::emit(NewRelayerPercentageFee {
            oldRelayerPercentageFee: relay.relayerPercentageFee,
            newRelayerPercentageFee: fee
        });

        // Update state
        relay.relayerPercentageFee = fee;
    }

    ///  @notice Setter for epochLength Owner only
    ///  @param length The new epoch length
    public entry fun set_epoch_length(
        relay: &mut BTCRelay, 
        length: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate length
        assert!(length > 0, EINVALID_PARAMETER);

        // Emit event
        event::emit(NewEpochLength {
            oldEpochLength: relay.epochLength,
            newEpochLength: length
        });

        // Update state
        relay.epochLength = length;
    }
    
    /// @notice External setter for baseQueries Owner only
    /// @param _baseQueries The base number of queries we assume in each epoch
    /// This prevents query fee to grow significantly
    public entry fun set_base_queries(
        relay: &mut BTCRelay, 
        queries: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate queries
        assert!(queries > 0, EINVALID_PARAMETER);

        // Emit event
        event::emit(NewBaseQueries {
            oldBaseQueries: relay.baseQueries,
            newBaseQueries: queries
        });

        // Update state
        relay.baseQueries = queries;
    }
    
    /// @notice Setter for submissionGasUsed
    /// @param gas: The gas used by Relayers for submitting a block header
    public entry fun set_submission_gas_used(
        relay: &mut BTCRelay, 
        gas: u64, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        // Validate gas
        assert!(gas > 0, EINVALID_PARAMETER);

        // Emit event
        event::emit(NewSubmissionGasUsed {
            oldSubmissionGasUsed: relay.submissionGasUsed,
            newSubmissionGasUsed: gas
        });

        // Update state
        relay.submissionGasUsed = gas;
    }

    public entry fun pause_relay(
        relay: &mut BTCRelay, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        relay.paused = true;
    }

    public entry fun unpause_relay(
        relay: &mut BTCRelay, 
        admin: &RELAY_ADMIN,
        ctx: &TxContext
    ) {
        relay.paused = false;
    }

    public entry fun renounce_admin_ownership(
        admin: RELAY_ADMIN,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == admin.owner, EINVALID_ADMIN);
        // Transfer the RELAY_ADMIN object to zero address
        transfer::public_transfer(admin, @0x0);
    }

    /// @notice Same as addHeaders, but can only be called by owner even if contract is paused
    /// It will be used if a fork happened
    public entry fun ownerAddHeaders(
        relay: &mut BTCRelay,
        anchor: vector<u8>,
        headers: vector<u8>,
        admin: &RELAY_ADMIN,
        ctx: &mut TxContext
    ): bool {
        // Check input sizes
        check_input_size_add_headers(&headers, &anchor);

        // Call internal function to add headers
        add_headers(relay, &anchor, &headers, false, ctx)
    }

    /// @notice Same as addHeadersWithRetarget, but can only be called by owner even if contract is paused
    /// It will be used if a fork happened
    public entry fun ownerAddHeadersWithRetarget(
        relay: &mut BTCRelay,
        old_period_start_header: vector<u8>,
        old_period_end_header: vector<u8>,
        headers: vector<u8>,
        admin: &RELAY_ADMIN,
        ctx: &mut TxContext
    ): bool {
        // Check input sizes
        check_input_size_add_headers_with_retarget(
            &old_period_start_header,
            &old_period_end_header,
            &headers
        );

        // Call internal function to add headers with retarget
        add_headers_with_retarget(
            relay,
            &old_period_start_header,
            &old_period_end_header,
            &headers,
            ctx
        )
    }
    
    // === Package Functions ===
    
    
    
    fun init(ctx: &mut TxContext) {
        // Create and transfer the RELAY_ADMIN object to the sender
        transfer::transfer(RELAY_ADMIN { 
            id: object::new(ctx),
            initialized: false,
            owner: tx_context::sender(ctx)
        }, tx_context::sender(ctx));
    }
    
    public entry fun initialize(
        genesis_header_hex: vector<u8>,
        height: u64,
        period_start: vector<u8>,
        finalization_parameter: u64,
        admin: &mut RELAY_ADMIN,
        ctx: &mut TxContext
    ) {
        // Check if already initialized
        assert!(!admin.initialized, EALREADY_INITIALIZED);
        
        // Mark as initialized
        admin.initialized = true;

        // Validate parameters
        assert!(finalization_parameter > 0 && finalization_parameter <= MAX_FINALIZATION_PARAMETER, EINVALID_PARAMETER);
        
        let genesis_header = BitcoinHelper::hex_to_bytes(&genesis_header_hex);
        
        // Validate genesis header
        assert!(
            vector::length(&genesis_header) == 80,
            EINVALID_HEADER
        );
        
        // Get genesis hash
        let genesis_hash = BitcoinHelper::hash256(&genesis_header);
        
        // Create initial block header
        let new_block_header = BlockHeader {
            selfHash: genesis_hash,
            parentHash: BitcoinHelper::get_parent(&genesis_header),
            merkleRoot: BitcoinHelper::get_merkle_root(&genesis_header),
            relayer: tx_context::sender(ctx),
        };

        // Create chain tables
        let mut chain = table::new<u64, vector<BlockHeader>>(ctx);
        let previous_block = table::new<vector<u8>, vector<u8>>(ctx);
        let mut block_height = table::new<vector<u8>, u64>(ctx);
        
        // Add initial header to chain
        let mut headers = vector::empty<BlockHeader>();
        vector::push_back(&mut headers, new_block_header);
        table::add(&mut chain, height, headers);
        
        // Store block heights
        table::add(&mut block_height, genesis_hash, height);
        table::add(&mut block_height, period_start, 
            height - (height % BitcoinHelper::get_retarget_period_blocks()));

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

        // Share relay
        transfer::share_object(relay);
    }

    // === Private Functions ===

    // Internal functions to add headers
    fun add_headers(
        relay: &mut BTCRelay,
        anchor: &vector<u8>,
        headers: &vector<u8>,
        internal: bool,
        ctx: & TxContext
    ): bool {
        // Extract basic info
        let mut previous_hash = BitcoinHelper::hash256(anchor);
        let anchor_height = find_height(relay, previous_hash);
        let target = BitcoinHelper::get_target(&BitcoinHelper::index_header_array(headers, 0));

        // When calling addHeaders, no retargetting should happen
        assert!(
            internal || BitcoinHelper::get_target(anchor) == target,
            EUNEXPECTED_RETARGET
        );

        // Check the height on top of the anchor is not finalized
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
        let mut height;
        let mut current_hash;
        let headers_len = vector::length(headers) / 80;
        let mut i = 0;
        
        while (i < headers_len) {
            let header = BitcoinHelper::index_header_array(headers, i);
            height = anchor_height + i + 1;
            current_hash = BitcoinHelper::hash256(&header);

            // Check that the block header is not a replica
            assert!(
                table::contains(&relay.previousBlock, current_hash)
            &&  !BitcoinHelper::equalzero(table::borrow(&relay.previousBlock, current_hash)),
                EDUPLICATE_HEADER
            );

            // Blocks that are multiplies of 2016 should be submitted using addHeadersWithRetarget
            assert!(
                height % BitcoinHelper::get_retarget_period_blocks() != 0,
                ERETARGET_REQUIRED
            );

            // Check timestamp
            assert!(
                BitcoinHelper::get_time(&header) < MAX_ALLOWED_GAP,
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

            // Check POW (header work is sufficient)
            assert!(
                BitcoinHelper::check_pow(&header),
                EINVALID_POW
            );

            // Store block connection and height
            table::add(&mut relay.previousBlock, current_hash, previous_hash);
            table::add(&mut relay.blockHeight, current_hash, height);

            // Emit event
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

    /// @notice Adds headers to storage, performs additional validation of retarget
    fun add_headers_with_retarget(
        relay: &mut BTCRelay,
        old_start: &vector<u8>,
        old_end: &vector<u8>,
        headers: &vector<u8>,
        ctx: & TxContext
    ): bool {
        // Get heights of both blocks
        let start_hash = BitcoinHelper::hash256(old_start);
        let end_hash = BitcoinHelper::hash256(old_end);
        let start_height = find_height(relay, start_hash);
        let end_height = find_height(relay, end_hash);

        // Verify retarget intervals (2016 blocks)
        assert!(
            end_height % BitcoinHelper::get_retarget_period_blocks() == 2015,
            EINVALID_HEADER
        );
        assert!(
            end_height == start_height + 2015,
            EINVALID_HEADER
        );

        // Check difficulty period
        assert!(
            BitcoinHelper::get_diff(old_start) == BitcoinHelper::get_diff(old_end),
            EINVALID_POW
        );

        // Calculate and verify new target
        let new_start = BitcoinHelper::index_header_array(headers, 0);
        let actual_target = BitcoinHelper::get_target(&new_start);
        let expected_target = BitcoinHelper::retarget_algorithm(
            BitcoinHelper::get_target(old_start),
            BitcoinHelper::get_time(old_start),
            BitcoinHelper::get_time(old_end)
        );

        // Verify target matches expected
        assert!(
            actual_target <= expected_target,
            EINVALID_POW
        );

        // Add headers to chain
        add_headers(relay, old_end, headers, true, ctx)
    }

    fun check_input_size_add_headers(headers_view: &vector<u8>, anchor_view: &vector<u8>) {
        // Check that headers are non-empty and multiple of 80 bytes
        assert!(
            !vector::is_empty(headers_view) && vector::length(headers_view) % 80 == 0 
                && !vector::is_empty(anchor_view) && vector::length(anchor_view) == 80,
            EINVALID_HEADER
        );
    }

    fun check_input_size_add_headers_with_retarget(
        old_start_header: &vector<u8>,
        old_end_header: &vector<u8>,
        headers_view: &vector<u8>
    ) {
        // Check that headers are non-empty and multiple of 80 bytes 
        assert!(
            !vector::is_empty(old_start_header) && vector::length(old_start_header) == 80 
         && !vector::is_empty(old_end_header) && vector::length(old_end_header) == 80
         && !vector::is_empty(headers_view) && vector::length(headers_view) % 80 == 0,
            EINVALID_HEADER
        );
    }

    /// @notice Adds a header to the chain
    /// @dev We prune the chain if the new header finalizes any header
    /// @param  header The new block header
    /// @param  height The height of the new block header
    fun add_to_chain(relay: &mut BTCRelay, header: &vector<u8>, height: u64, ctx: &TxContext) {
        // Prevent relayers to submit too old block headers
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

        // Add to chain
        let headers = table::borrow_mut(&mut relay.chain, height);
        vector::push_back(headers, new_block_header);

        if (height > relay.lastSubmittedHeight) {
            relay.lastSubmittedHeight = relay.lastSubmittedHeight + 1;
            update_fee(relay);
            prune_chain(relay);
        };
    }
    /// @notice Reset the number of epoch users when a new epoch starts
    /// @dev This parameter is used to calculate the fee that Relay gets from users in the next epoch
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

    /// @notice Finalizes a block header and removes all the other headers in that height
    /// @dev When chain gets pruned, we only delete blocks in the same 
    ///      height as the finalized header. Other blocks on top of the non finalized blocks 
    ///      will exist until their height gets finalized.
    fun prune_chain(relay: &mut BTCRelay) {
        // Make sure that we have at least finalizationParameter blocks on relay
        if ((relay.lastSubmittedHeight - relay.initialHeight) >= relay.finalizationParameter) {
            let mut idx = relay.finalizationParameter;
            let mut current_height = relay.lastSubmittedHeight;
            let mut stable_idx = 0;
            
            while (idx > 0) {
                let headers = table::borrow(&relay.chain, current_height);
                let parent_header_hash = vector::borrow(headers, stable_idx).parentHash;
                stable_idx = find_index(relay, parent_header_hash, current_height - 1);
                idx = idx - 1;
                current_height = current_height - 1;
            };

            // Keep the finalized block header and delete rest of headers
            let headers = table::borrow_mut(&mut relay.chain, current_height);
            let finalized_header = *vector::borrow(headers, stable_idx);
            *vector::borrow_mut(headers, 0) = finalized_header;
            
            if (vector::length(headers) > 1) {
                // prune height, keep a finialzed header and remove others
                let mut len = vector::length(headers);
        
                // Keep removing elements from the end until only one remains
                while (len > 1) {
                    vector::pop_back(headers);
                    len = len - 1;
                };
            };

            // Emit event for block finalization
            let finalized_header = vector::borrow(headers, 0);
            event::emit(BlockFinalized {
                height: current_height,
                self_hash: finalized_header.selfHash,
                parent_hash: finalized_header.parentHash,
                relayer: finalized_header.relayer
            });
        }
    }

    /// @notice Finds the height of a header by its hash
    /// @dev Fails if the header is unknown
    /// @param _hash The header hash to search for
    /// @return The height of the header
    fun find_height(relay: &BTCRelay, hash: vector<u8>): u64 {
        let height = *table::borrow(&relay.blockHeight, hash);
        assert!(height != 0, EINVALID_CHAIN); // Revert if block is unknown
        height
    }

    /// @notice Finds the index of a block header in a specific height
    /// @param header_hash The block header hash
    /// @param height The height that we are searching
    /// @return Index of the block header
    fun find_index(relay: &BTCRelay, header_hash: vector<u8>, height: u64): u64 {
        let headers = table::borrow(&relay.chain, height);
        let len = vector::length(headers);
        let mut i = 0;
        while (i < len) {
            if (vector::borrow(headers, i).selfHash == header_hash) {
                return i
            };
            i = i + 1;
        };
        0 // Return 0 if not found
    } 
}

