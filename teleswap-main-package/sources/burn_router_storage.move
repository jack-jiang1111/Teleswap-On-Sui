#[allow(unused_field)]
module teleswap::burn_router_storage {
    use sui::table::{Self, Table};

    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    const DUST_SATOSHI_AMOUNT: u64 = 1000;

    // Error codes
    const EINVALID_ADMIN: u64 = 1;
    const EINVALID_LOCKER_TARGET_ADDRESS: u64 = 2;
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

    // Main storage resource for BurnRouter
    public struct BurnRouter has key {
        id: UID,
        owner: address,
        starting_block_number: u64,
        transfer_deadline: u64,
        protocol_percentage_fee: u64, // Min amount is %0.01
        slasher_percentage_reward: u64, // Min amount is %1
        bitcoin_fee: u64, // Fee of submitting a tx on Bitcoin
        
        // Storage mappings converted to Move tables
        burn_requests: Table<address, vector<BurnRequest>>, 
        // ^ Mapping from locker target address to assigned burn requests
        burn_request_counter: Table<address, u64>,
        is_used_as_burn_proof: Table<vector<u8>, bool>, 
        // ^ Mapping that shows a txId has been submitted to pay a burn request

        third_party_fee: Table<u64, u64>,
        third_party_address: Table<u64, address>,
        wrapped_native_token: address,
        locker_percentage_fee: u64,
        reward_distributor: address,
    }

    // ===== CAPABILITIES =====


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
    fun assert_admin(caller: address, burn_router: &BurnRouter) {
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
    public fun get_wrapped_native_token(burn_router: &BurnRouter): address { burn_router.wrapped_native_token }
    public fun get_locker_percentage_fee(burn_router: &BurnRouter): u64 { burn_router.locker_percentage_fee }
    public fun get_reward_distributor(burn_router: &BurnRouter): address { burn_router.reward_distributor }

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
        burn_router.protocol_percentage_fee = fee;
    }
    public fun set_slasher_percentage_reward(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, reward: u64) {
        assert_admin(burn_admin.owner, burn_router);
        burn_router.slasher_percentage_reward = reward;
    }
    public fun set_wrapped_native_token(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, token: address) {
        assert_admin(burn_admin.owner, burn_router);
        burn_router.wrapped_native_token = token;
    }
    public fun set_locker_percentage_fee(burn_admin: &BURN_ROUTER_ADMIN, burn_router: &mut BurnRouter, fee: u64) {
        assert_admin(burn_admin.owner, burn_router);
        burn_router.locker_percentage_fee = fee;
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
        }
    }

    public fun get_is_used_as_burn_proof(burn_router: &BurnRouter, tx_id: vector<u8>): bool {
        if (table::contains(&burn_router.is_used_as_burn_proof, tx_id)) {
            *table::borrow(&burn_router.is_used_as_burn_proof, tx_id)
        } else {
            false
        }
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
} 