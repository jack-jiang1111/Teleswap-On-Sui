#[allow(unused)]
module btcrelay::btcrelay_mock {
    // ------------------------------------------------------
    // The whole contract is a mock of btcrelay, it is used for testing
    // checkTxProof is the function always return btcrelay.test_Value
    // ------------------------------------------------------
    
    // === Imports ===
    use sui::table::{Self, Table};
    use sui::event;
    use sui::package::{Self, UpgradeCap};
    use std::string::{Self, String};
    use btcrelay::bitcoin_helper::{Self as BitcoinHelper}; // Helper module for Bitcoin-specific operations

    use std::address::length;
    use btcrelay::bitcoin_helper::hex_to_bytes;
    use btcrelay::bitcoin_helper;

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
    const EINVALID_UPGRADE_CAP: u64 = 16;  // Invalid upgrade capability

     // === Constants ===
    const ONE_HUNDRED_PERCENT: u64 = 10000;        // 100% in basis points
    const MAX_FINALIZATION_PARAMETER: u64 = 432;   // Maximum finalization period (roughly 3 days)
    const MAX_ALLOWED_GAP: u64 = 5400;             // Maximum allowed time gap (90 minutes in seconds)

    /// Represents a Bitcoin block header with essential information
    /// Used for storing and verifying block headers
    public struct BlockHeader has store, drop, copy {
        selfHash: vector<u8>,      // Hash of this block
        parentHash: vector<u8>,    // Hash of parent block
        merkleRoot: vector<u8>,    // Merkle root of transactions
        relayer: address,          // Address of the relayer who submitted this header
    }

    /// Admin control structure for the contract
    /// Stores initialization state and owner address
    public struct RELAY_ADMIN has key, store {
        id: UID,
        initialized: bool,
        owner: address
    }

    /// Main contract structure for Bitcoin relay
    /// Manages the relay of Bitcoin block headers to Sui
    public struct BTCRelay has key {
        id: UID,
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
        adminAddress: address,             // Contract owner
        test_Value: bool,                  // Used for the mock function checkTxProof

        chain: Table<u64, vector<BlockHeader>>,           // Maps height to block headers
        previousBlock: Table<vector<u8>, vector<u8>>,     // Maps block hash to parent hash
        blockHeight: Table<vector<u8>, u64>,              // Maps block hash to height
    }

    
    // mock function, always return true
    public fun checkTxProof(
            relay: & BTCRelay,
            txid: vector<u8>,
            block_height: u64,
            intermediate_nodes: vector<u8>,
            index: u64,
        ): bool {
            relay.test_Value
    }

    // === Getter and Setter for lastSubmittedHeight ===
    public fun lastSubmittedHeight(relay: &BTCRelay): u64 {
        relay.lastSubmittedHeight
    }

    /// Public entry to set lastSubmittedHeight for testing
    public entry fun set_last_submitted_height(relay: &mut BTCRelay, value: u64) {
        relay.lastSubmittedHeight = value;
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
        let mut chain = table::new<u64, vector<BlockHeader>>(ctx);
        let previous_block = table::new<vector<u8>, vector<u8>>(ctx);
        let mut block_height = table::new<vector<u8>, u64>(ctx);
        
        // Add genesis header to chain
        let mut headers = vector::empty<BlockHeader>();
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
            adminAddress: tx_context::sender(ctx),
            test_Value: true,
        };

        // Share relay object
        transfer::share_object(relay);
    }

    public fun set_mock_return(relay: &mut BTCRelay, value: bool) {
        relay.test_Value = value;
    }
}