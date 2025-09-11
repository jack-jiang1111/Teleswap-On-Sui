#[allow(unused_field,unused_variable)]
module teleswap::burn_router_storage {
    use sui::table::{Self, Table};
    use teleswap::btcrelay::{BTCRelay};

    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    const DUST_SATOSHI_AMOUNT: u64 = 1000;

    // Error codes
    const EINVALID_ADMIN: u64 = 225;
    const EINVALID_LOCKER_TARGET_ADDRESS: u64 = 226;
    const EALREADY_INITIALIZED: u64 = 227;
    const EINVALID_FEE: u64 = 228;
    // ===== STRUCTURES =====
    public struct BurnRequest has store, copy,drop {
        amount: u64,
        burnt_amount: u64,
        sender: address,
        user_script: vector<u8>,
        script_type: u8,
        deadline: u64,
        is_transferred: bool,
        request_id_of_locker: u64,
    }

    /// Main storage structure for the burn router
    /// Manages all burn requests and configuration
    public struct BurnRouter has key,store {
        id: UID,
        owner: address,
        starting_block_number: u64,
        transfer_deadline: u64,
        protocol_percentage_fee: u64, // Min amount is %00.01        
        locker_percentage_fee: u64, // Locker fee percentage
        slasher_percentage_reward: u64, // Min amount is %1
        bitcoin_fee: u64, // Fee of submitting a tx on Bitcoin
        treasury: address,
        bitcoin_fee_oracle: address,
        btcrelay_object_id: ID, // Add field to store legitimate BTCRelay object ID
        burn_requests: Table<address, vector<BurnRequest>>, 
        // ^ Mapping from locker target address to assigned burn requests
        burn_request_counter: Table<address, u64>,
        is_used_as_burn_proof: Table<vector<u8>, bool>, 
        // ^ Mapping that shows a txId has been submitted to pay a burn request

        third_party_fee: Table<u64, u64>,
        third_party_address: Table<u64, address>,
    }

    /// Admin control structure for the contract
    /// Stores owner address
    public struct BURN_ROUTER_ADMIN has key, store {
        id: UID,                      // Unique identifier
        owner: address,                // Admin owner address
        initialized: bool              // Whether the admin has been initialized
    }    
    
    /// Helper function to verify admin privileges
    /// @param caller Caller's address
    /// @param burn_router The burn router capability
    public(package) fun assert_admin(caller: address, burn_router: &BurnRouter) {
        assert!(caller == burn_router.owner, EINVALID_ADMIN);
    }


    // ===== PUBLIC GETTERS =====
    public fun get_max_percentage_fee(): u64 { MAX_PERCENTAGE_FEE }
    public fun get_dust_satoshi_amount(): u64 { DUST_SATOSHI_AMOUNT }

    public fun get_starting_block_number(burn_router: &BurnRouter): u64 { burn_router.starting_block_number }
    public fun get_transfer_deadline(burn_router: &BurnRouter): u64 { burn_router.transfer_deadline }
    public fun get_protocol_percentage_fee(burn_router: &BurnRouter): u64 { burn_router.protocol_percentage_fee }
    public fun get_slasher_percentage_reward(burn_router: &BurnRouter): u64 { burn_router.slasher_percentage_reward }
    public fun get_bitcoin_fee(burn_router: &BurnRouter): u64 { burn_router.bitcoin_fee }
    public fun get_locker_percentage_fee(burn_router: &BurnRouter): u64 { burn_router.locker_percentage_fee }
    public fun get_treasury(burn_router: &BurnRouter): address { burn_router.treasury }
    public fun get_bitcoin_fee_oracle(burn_router: &BurnRouter): address { burn_router.bitcoin_fee_oracle }

    /// @notice Validates that the provided BTCRelay object is the legitimate one
    /// @dev Compares the object ID with the stored legitimate BTCRelay ID.
    /// This ensures that only the authorized BTCRelay instance can be used
    /// for burn proof validation and dispute operations.
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object to validate
    /// @return true if the BTCRelay is legitimate, false otherwise
    public fun validate_btcrelay(burn_router: &BurnRouter, btcrelay: &BTCRelay): bool {
        object::id(btcrelay) == burn_router.btcrelay_object_id
    }

    /// @notice Gets the legitimate BTCRelay object ID
    /// @dev Returns the stored BTCRelay object ID for validation purposes.
    /// This ID is set during initialization and used to validate that
    /// only the authorized BTCRelay instance is used.
    /// @param burn_router The BurnRouter object
    /// @return The legitimate BTCRelay object ID
    public fun get_btcrelay_object_id(burn_router: &BurnRouter): ID {
        burn_router.btcrelay_object_id
    }

    // ===== FIELD GETTERS FOR BurnRequest =====
    public fun get_amount(request: &BurnRequest): u64 { request.amount }
    public fun get_burnt_amount(request: &BurnRequest): u64 { request.burnt_amount }
    public fun get_sender(request: &BurnRequest): address { request.sender }
    public fun get_user_script(request: &BurnRequest): vector<u8> { request.user_script }
    public fun get_script_type(request: &BurnRequest): u8 { request.script_type }
    public fun get_deadline(request: &BurnRequest): u64 { request.deadline }
    public fun is_transferred(request: &BurnRequest): bool { request.is_transferred }
    public fun get_request_id_of_locker(request: &BurnRequest): u64 { request.request_id_of_locker }
    public fun set_is_transferred(request: &mut BurnRequest, value: bool) { request.is_transferred = value; }

    // ===== OWNERS SETTERS =====
    public fun set_starting_block_number(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, block_number: u64) {
        assert_admin(burn_admin.owner, burn_router);
        burn_router.starting_block_number = block_number;
    }
    public fun set_transfer_deadline(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, deadline: u64) {
        assert_admin(burn_admin.owner, burn_router);
        burn_router.transfer_deadline = deadline;
    }
    public fun set_protocol_percentage_fee(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, fee: u64) {
        assert_admin(burn_admin.owner, burn_router);
        assert!(fee <= MAX_PERCENTAGE_FEE, EINVALID_FEE);
        burn_router.protocol_percentage_fee = fee;
    }
    public fun set_slasher_percentage_reward(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, reward: u64) {
        assert_admin(burn_admin.owner, burn_router);
        assert!(reward <= MAX_PERCENTAGE_FEE, EINVALID_FEE);
        burn_router.slasher_percentage_reward = reward;
    }
    public fun set_locker_percentage_fee(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, fee: u64) {
        assert_admin(burn_admin.owner, burn_router);
        assert!(fee <= MAX_PERCENTAGE_FEE, EINVALID_FEE);
        burn_router.locker_percentage_fee = fee;
    }
    public fun set_bitcoin_fee(burn_router: &mut BurnRouter, fee: u64, ctx: &TxContext) {
        assert!(burn_router.bitcoin_fee_oracle == tx_context::sender(ctx), EINVALID_ADMIN);
        burn_router.bitcoin_fee = fee;
    }
    // ===== TABLE OPERATIONS =====
    public fun get_burn_requests(burn_router: &BurnRouter, locker_target_address: address): vector<BurnRequest> {
        if (table::contains(&burn_router.burn_requests, locker_target_address)) {
            *table::borrow(&burn_router.burn_requests, locker_target_address)
        } else {
            // Return empty vector if no requests exist for this address
            vector::empty<BurnRequest>()
        }
    }

    public fun get_burn_requests_ref(burn_router: &BurnRouter, locker_target_address: address): &vector<BurnRequest> {
        assert!(table::contains(&burn_router.burn_requests, locker_target_address), EINVALID_LOCKER_TARGET_ADDRESS);
        table::borrow(&burn_router.burn_requests, locker_target_address)
    }

    public fun has_burn_requests(burn_router: &BurnRouter, locker_target_address: address): bool {
        table::contains(&burn_router.burn_requests, locker_target_address)
    }

    public fun get_burn_request_counter(burn_router: &BurnRouter, locker_target_address: address): u64 {
        if (table::contains(&burn_router.burn_request_counter, locker_target_address)) {
            *table::borrow(&burn_router.burn_request_counter, locker_target_address)
        } else {
            0
            // need to throw error
        }
    }

    public fun get_is_used_as_burn_proof(burn_router: &BurnRouter, tx_id: vector<u8>): bool {
        if (table::contains(&burn_router.is_used_as_burn_proof, tx_id)) {
            *table::borrow(&burn_router.is_used_as_burn_proof, tx_id)
        } else {
            false
        }
    }

    public fun get_is_used_as_burn_proof_mut(burn_router: &mut BurnRouter): &mut table::Table<vector<u8>, bool> {
        &mut burn_router.is_used_as_burn_proof
    }

    public fun get_third_party_fee(burn_router: &BurnRouter, third_party_id: u64): u64 {
        if (table::contains(&burn_router.third_party_fee, third_party_id)) {
            *table::borrow(&burn_router.third_party_fee, third_party_id)
        } else {
            0
        }
    }

    public fun get_third_party_address(burn_router: &BurnRouter, third_party_id: u64): address {
        if (table::contains(&burn_router.third_party_address, third_party_id)) {
            *table::borrow(&burn_router.third_party_address, third_party_id)
        } else {
            @0x0
        }
    }

    // ===== MUTABLE TABLE OPERATIONS =====
    public(package) fun set_burn_requests(burn_router: &mut BurnRouter, locker_target_address: address, requests: vector<BurnRequest>) {
        if (table::contains(&burn_router.burn_requests, locker_target_address)) {
            *table::borrow_mut(&mut burn_router.burn_requests, locker_target_address) = requests;
        } else {
            table::add(&mut burn_router.burn_requests, locker_target_address, requests);
        }
    }

    public(package) fun set_burn_request_counter(burn_router: &mut BurnRouter, locker_target_address: address, counter: u64) {
        if (table::contains(&burn_router.burn_request_counter, locker_target_address)) {
            *table::borrow_mut(&mut burn_router.burn_request_counter, locker_target_address) = counter;
        } else {
            table::add(&mut burn_router.burn_request_counter, locker_target_address, counter);
        }
    }

    public(package) fun add_burn_request(burn_router: &mut BurnRouter, locker_target_address: address, request: BurnRequest) {
        let mut requests = get_burn_requests(burn_router, locker_target_address);
        vector::push_back(&mut requests, request);
        set_burn_requests(burn_router, locker_target_address, requests);
    }

    public(package) fun set_burn_request(burn_router: &mut BurnRouter, locker_target_address: address, index: u64, request: BurnRequest) {
        let mut requests = get_burn_requests(burn_router, locker_target_address);
        assert!(index < vector::length(&requests), 1); // Index out of bounds
        *vector::borrow_mut(&mut requests, index) = request;
        set_burn_requests(burn_router, locker_target_address, requests);
    }

    public(package) fun set_is_used_as_burn_proof(burn_router: &mut BurnRouter, tx_id: vector<u8>, is_used: bool) {
        if (table::contains(&burn_router.is_used_as_burn_proof, tx_id)) {
            *table::borrow_mut(&mut burn_router.is_used_as_burn_proof, tx_id) = is_used;
        } else {
            table::add(&mut burn_router.is_used_as_burn_proof, tx_id, is_used);
        }
    }

    public fun set_third_party_fee(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, third_party_id: u64, fee: u64) {
        assert_admin(burn_admin.owner, burn_router);
        if (table::contains(&burn_router.third_party_fee, third_party_id)) {
            *table::borrow_mut(&mut burn_router.third_party_fee, third_party_id) = fee;
        } else {
            table::add(&mut burn_router.third_party_fee, third_party_id, fee);
        }
    }

    public fun set_third_party_address(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, third_party_id: u64, addr: address) {
        assert_admin(burn_admin.owner, burn_router);
        if (table::contains(&burn_router.third_party_address, third_party_id)) {
            *table::borrow_mut(&mut burn_router.third_party_address, third_party_id) = addr;
        } else {
            table::add(&mut burn_router.third_party_address, third_party_id, addr);
        }
    }

    // ===== HELPER FUNCTIONS =====
    public(package) fun create_burn_request(
        amount: u64,
        burnt_amount: u64,
        sender: address,
        user_script: vector<u8>,
        script_type: u8,
        deadline: u64,
        request_id_of_locker: u64
    ): BurnRequest {
        BurnRequest {
            amount,
            burnt_amount,
            sender,
            user_script,
            script_type,
            deadline,
            is_transferred: false,
            request_id_of_locker,
        }
    }

    public fun get_burn_request(burn_router: &BurnRouter, locker_target_address: address, index: u64): BurnRequest {
        let requests = get_burn_requests(burn_router, locker_target_address);
        assert!(index < vector::length(&requests), 1); // Index out of bounds
        *vector::borrow(&requests, index)
    }

    public fun get_burn_request_ref(burn_router: &BurnRouter, locker_target_address: address, index: u64): &BurnRequest {
        let requests = get_burn_requests_ref(burn_router, locker_target_address);
        assert!(index < vector::length(requests), 1); // Index out of bounds
        vector::borrow(requests, index)
    }

    public fun get_burn_request_count(burn_router: &BurnRouter, locker_target_address: address): u64 {
        let requests = get_burn_requests(burn_router, locker_target_address);
        vector::length(&requests)
    }

    public(package) fun increment_burn_request_counter(burn_router: &mut BurnRouter, locker_target_address: address): u64 {
        let current_counter = get_burn_request_counter(burn_router, locker_target_address);
        let new_counter = current_counter + 1;
        set_burn_request_counter(burn_router, locker_target_address, new_counter);
        current_counter
    }

    public(package) fun remove_burn_request(burn_router: &mut BurnRouter, locker_target_address: address, index: u64): BurnRequest {
        let mut requests = get_burn_requests(burn_router, locker_target_address);
        assert!(index < vector::length(&requests), 1); // Index out of bounds
        let request = vector::remove(&mut requests, index);
        set_burn_requests(burn_router, locker_target_address, requests);
        request
    }

    public(package) fun clear_burn_requests(burn_router: &mut BurnRouter, locker_target_address: address) {
        if (table::contains(&burn_router.burn_requests, locker_target_address)) {
            table::remove(&mut burn_router.burn_requests, locker_target_address);
        }
    }

    /// @notice Records burn request of user
    /// @return request_id The ID of the created burn request
    public(package) fun save_burn_request(
        burn_router: &mut BurnRouter,
        amount: u64,
        burnt_amount: u64,
        user_script: vector<u8>,
        script_type: u8,
        last_submitted_height: u64,
        locker_target_address: address,
        sender: address
    ): u64 {
        // Get current counter for this locker target address
        let request_id = get_burn_request_counter(burn_router, locker_target_address);
        
        // Create burn request with proper parameters
        let request = create_burn_request(
            amount,
            burnt_amount,
            sender,
            user_script,
            script_type,
            last_submitted_height + burn_router.transfer_deadline, // deadline = last_submitted_height + transfer_deadline
            request_id // request_id_of_locker = current counter
        );
        
        // Add request to burn_requests array
        add_burn_request(burn_router, locker_target_address, request);
        
        // Increment counter
        increment_burn_request_counter(burn_router, locker_target_address);
        
        // Return the request_id
        request_id
    }

    /// Returns a mutable reference to a burn request for a given locker and index
    public(package) fun get_burn_request_mut(
        burn_router: &mut BurnRouter,
        locker_target_address: address,
        index: u64
    ): &mut BurnRequest {
        let requests = table::borrow_mut(&mut burn_router.burn_requests, locker_target_address);
        assert!(index < vector::length(requests), 1); // Index out of bounds
        vector::borrow_mut(requests, index)
    }

    /// Creates a new BurnRouter object
    public(package) fun create_burn_router(
        owner: address,
        starting_block_number: u64,
        transfer_deadline: u64,
        protocol_percentage_fee: u64,
        locker_percentage_fee: u64,
        slasher_percentage_reward: u64,
        bitcoin_fee: u64,
        treasury: address,
        bitcoin_fee_oracle: address,
        btcrelay_object_id: ID, // Add field to store legitimate BTCRelay object ID
        ctx: &mut TxContext
    ): BurnRouter {
        BurnRouter {
            id: object::new(ctx),
            owner,
            starting_block_number,
            transfer_deadline,
            protocol_percentage_fee,
            slasher_percentage_reward,
            bitcoin_fee,
            treasury,
            bitcoin_fee_oracle,
            burn_requests: table::new(ctx),
            burn_request_counter: table::new(ctx),
            is_used_as_burn_proof: table::new(ctx),
            third_party_fee: table::new(ctx),
            third_party_address: table::new(ctx),
            locker_percentage_fee,
            btcrelay_object_id, // Add field to store legitimate BTCRelay object ID
        }
    }

    /// Creates a new BURN_ROUTER_ADMIN object
    public(package) fun create_burn_router_admin(ctx: &mut TxContext): BURN_ROUTER_ADMIN {
        BURN_ROUTER_ADMIN {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            initialized: false
        }
    }

    /// Performs the initialize logic: checks and sets initialized, returns owner
    public fun do_initialize(admin: &mut BURN_ROUTER_ADMIN): address {
        assert!(!admin.initialized, EALREADY_INITIALIZED); // Already initialized
        admin.initialized = true;
        admin.owner
    }
} 