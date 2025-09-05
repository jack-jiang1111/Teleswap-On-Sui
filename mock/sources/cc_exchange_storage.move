#[allow(unused)]
module teleswap::exchangestorage {
    use sui::table::{Self, Table};
    use sui::event;
    use sui::coin;


    use teleswap::cc_transfer_router_storage::TxAndProof;
    use teleswap::btcrelay::{Self, BTCRelay};
    use teleswap::telebtc::{Self, TELEBTC};
    // Constants
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    const MAX_BRIDGE_FEE: u64 = 1000000000000000000; // 10^18
    const REGULAR_SLIPPAGE: u64 = 1500; // Not used

    // Error codes
    const EZERO_ADDRESS: u64 = 600;
    const EINVALID_AMOUNT: u64 = 601;
    const EALREADY_USED: u64 = 602;
    const EINVALID_LENGTH: u64 = 603;
    const ENOT_OWNER: u64 = 604;
    const EALREADY_INITIALIZED: u64 = 605;

    // Structures
    // Main logic structure
    public struct ExchangeAdmin has key {
        id: UID,
        owner: address,
        is_initialized: bool,
    }

    // Functions
    fun init(ctx: &mut TxContext) {
        let exchange_admin = ExchangeAdmin {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            is_initialized: false,
        };
        transfer::transfer(exchange_admin, tx_context::sender(ctx));
    }

    // Initialize CcExchangeRouter
    /// Initializes Exchange storage and shares an `ExchangeCap` with provided configuration.
    /// Also seeds third-party fee/address tables and sets the special teleporter.
    ///
    /// Parameters:
    /// - exchange_admin: Admin capability (must be owner)
    /// - starting_block_number: Minimum accepted BTC block for requests
    /// - protocol_percentage_fee: Protocol fee in basis points (1e4)
    /// - locker_percentage_fee: Locker fee in basis points (1e4)
    /// - chain_id: Destination chain id for bridge mappings (reserved)
    /// - lockers: Lockers manager address (reserved)
    /// - btcrelay_object_id: Authorized BTC relay object id
    /// - treasury: Treasury address to receive protocol fees
    /// - third_party_id/fee/address: Initial third-party config to seed
    /// - reward_distributor: Optional distributor for locker fees (0x0 disables)
    /// - special_teleporter: Address authorized to call wrap_and_swap
    /// - ctx: Tx context
    public fun initialize(
        exchange_admin: &mut ExchangeAdmin,
        starting_block_number: u64,
        protocol_percentage_fee: u64,
        locker_percentage_fee: u64,
        chain_id: u64,
        lockers: address,
        btcrelay_object_id: ID,
        treasury: address,
        third_party_id: u64,
        third_party_fee: u64,
        third_party_address: address,
        reward_distributor: address,
        special_teleporter: address,
        ctx: &mut TxContext
    ) {
        assert!(is_owner(exchange_admin, tx_context::sender(ctx)), ENOT_OWNER);
        assert!(!exchange_admin.is_initialized, EALREADY_INITIALIZED);

        // set is_initialized to true
        exchange_admin.is_initialized = true;
        // we are going to create exchange cap and share it in this function
        let mut exchange_cap = ExchangeCap {
            id: object::new(ctx),
            starting_block_number,
            protocol_percentage_fee,
            btcrelay_object_id,
            // set special teleporter as the initializer (can be updated later via setter)
            special_teleporter,
            treasury,
            // V2 vars
            third_party_fee: table::new(ctx),
            third_party_address: table::new(ctx),
            locker_percentage_fee,
            reward_distributor,
            bridge_token_mapping: table::new(ctx),
            final_amount: table::new(ctx),
            // private vars
            cc_exchange_requests: table::new(ctx),
            exchange_vault: sui::balance::zero(),
        };

        // add third party fee and address to the table
        set_third_party_fee(exchange_admin, &mut exchange_cap, third_party_id, third_party_fee, ctx);
        set_third_party_address(exchange_admin, &mut exchange_cap, third_party_id, third_party_address, ctx);

        transfer::public_share_object(exchange_cap);
    }
    // Helper functions
    public fun is_owner(exchange_admin: &ExchangeAdmin, addr: address): bool {
        exchange_admin.owner == addr
    }


    /// Structure for recording cross-chain exchange requests (merged from CcExchangeRequest and ExtendedCcExchangeRequest)
    /// Exchange request holds all information parsed from Bitcoin and extended fields for processing.
    public struct ExchangeRequest has store, drop {
        // Basic request fields
        app_id: u64,
        input_amount: u64,
        output_amount: u64,
        is_fixed_token: bool,
        recipient_address: address,
        fee: u64,
        is_used: bool,
        target_token: u8,
        speed: u64,
        
        // Extended fields
        is_request_completed: bool,
        remained_input_amount: u64,
        bridge_percentage_fee: u64,
        third_party: u64,
        protocol_fee: u64,
        third_party_fee: u64,
        locker_fee: u64,
    }

    // constructor for ExchangeRequest
    public(package) fun new_exchange_request(
        exchange_cap: & ExchangeCap,
        app_id: u64,
        input_amount: u64,
        output_amount: u64,
        is_fixed_token: bool,
        recipient_address: address,
        fee: u64,
        is_used: bool,
        target_token: u8,
        speed: u64,
        is_request_completed: bool,
        remained_input_amount: u64,
        bridge_percentage_fee: u64,
        third_party: u64,
    ): ExchangeRequest {
        ExchangeRequest {
            app_id,
            input_amount,
            output_amount,
            is_fixed_token,
            recipient_address,
            fee,
            is_used,
            target_token,
            speed,
            is_request_completed,
            remained_input_amount,
            bridge_percentage_fee,
            third_party,
            protocol_fee: exchange_cap.protocol_percentage_fee,
            third_party_fee: exchange_cap.third_party_fee[third_party],
            locker_fee: exchange_cap.locker_percentage_fee,
        }
    }

    /// Structure for storing filling requests
    public struct FillData has store, drop {
        starting_time: u64,
        req_token: address,
        last_used_idx: u64,
        remaining_amount_of_last_fill: u64,
        is_withdrawn_last_fill: bool,
    }

    /// Structure for storing fillers of a request
    public struct FillerData has store, drop {
        index: u64,
        token: address,
        amount: u64,
    }

    /// Structure for storing fillings
    public struct PrefixFillSum has store, drop {
        prefix_sum: vector<u64>,
        current_index: u64,
    }



    // Main storage structure
    /// ExchangeCap holds all configuration, request table and the TeleBTC vault for failed swaps.
    public struct ExchangeCap has key, store {
        id: UID,
        // Basic variables
        starting_block_number: u64,
        protocol_percentage_fee: u64,
        btcrelay_object_id: ID,
        special_teleporter: address,
        treasury: address,
        
        // V2 variables
        third_party_fee: Table<u64, u64>,
        third_party_address: Table<u64, address>,
        //filler_address: Table<vector<u8>, Table<address, Table<address, Table<u64, Table<u64, Table<u64, address>>>>>>,
        locker_percentage_fee: u64,
        reward_distributor: address,
        bridge_token_mapping: Table<address, Table<u64, address>>, // used for fill logic
        final_amount: Table<vector<u8>, u64>, // txId to final amount (used for fill logic)
        
        // Private variables
        cc_exchange_requests: Table<vector<u8>, ExchangeRequest>,

        // exchange vault, holding TeleBtc coins for failed swap
        exchange_vault: sui::balance::Balance<TELEBTC>,
    }

    // Events

    public struct RefundProcessed has copy, drop {
        tx_id: vector<u8>,
        refunded_by: address,
        failed_request_amount: u64,
        refund_amount: u64,
        user_script: vector<u8>,
        script_type: u8,
        locker_target_address: address,
        burn_request_counter: u64,
    }

    public struct SetExchangeConnector has copy, drop {
        app_id: u64,
        exchange_connector: address,
    }

    public struct NewRelay has copy, drop {
        old_relay: address,
        new_relay: address,
    }

    public struct NewSpecialTeleporter has copy, drop {
        old_special_teleporter: address,
        new_special_teleporter: address,
    }

    public struct NewProtocolPercentageFee has copy, drop {
        old_protocol_percentage_fee: u64,
        new_protocol_percentage_fee: u64,
    }

    public struct NewTreasury has copy, drop {
        old_treasury: address,
        new_treasury: address,
    }

    public struct NewThirdPartyAddress has copy, drop {
        third_party_id: u64,
        old_third_party_address: address,
        new_third_party_address: address,
    }

    public struct NewThirdPartyFee has copy, drop {
        third_party_id: u64,
        old_third_party_fee: u64,
        new_third_party_fee: u64,
    }

    // Read-only functions
    /// Returns whether a request id has been seen and its 'is_used' bit set.
    public fun is_request_used(storage: &ExchangeCap, tx_id: vector<u8>): bool {
        if (table::contains(&storage.cc_exchange_requests, tx_id)) {
            let request = table::borrow(&storage.cc_exchange_requests, tx_id);
            request.is_used
        } else {
            false
        }
    }

    /// Validates the provided BTCRelay object by comparing its id against the configured relay id.
    /// This ensures that only the authorized BTCRelay instance can be used
    /// for burn proof validation and dispute operations.
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object to validate
    /// @return true if the BTCRelay is legitimate, false otherwise
    public fun validate_btcrelay(storage: &ExchangeCap, btcrelay: &BTCRelay): bool {
        object::id(btcrelay) == storage.btcrelay_object_id
    }


    public fun starting_block_number(storage: &ExchangeCap): u64 {
        storage.starting_block_number
    }

    public fun protocol_percentage_fee(storage: &ExchangeCap): u64 {
        storage.protocol_percentage_fee
    }
    

    public fun btcrelay_object_id(storage: &ExchangeCap): ID {
        storage.btcrelay_object_id
    }

    public fun special_teleporter(storage: &ExchangeCap): address {
        storage.special_teleporter
    }

    public fun treasury(storage: &ExchangeCap): address {
        storage.treasury
    }


    /// Mutable accessor to the requests table, used by logic module to insert/update requests.
    public fun cc_exchange_requests(storage: &mut ExchangeCap): &mut Table<vector<u8>, ExchangeRequest> {
        &mut storage.cc_exchange_requests
    }

    /// Deposit TeleBTC into the exchange vault (used when swaps fail). Coin is converted to balance and joined.
    public(package) fun deposit_to_vault(storage: &mut ExchangeCap, coin_in: sui::coin::Coin<TELEBTC>) {
        sui::balance::join(&mut storage.exchange_vault, sui::coin::into_balance(coin_in));
    }

    /// Withdraw a specific amount of TeleBTC from the vault. Returns a Coin<TELEBTC> for off-chain unwrap.
    public(package) fun withdraw_from_vault(storage: &mut ExchangeCap, amount: u64, ctx: &mut TxContext): sui::coin::Coin<TELEBTC> {
        sui::coin::from_balance(sui::balance::split(&mut storage.exchange_vault, amount), ctx)
    }

    // Setter functions (owner only)
    /// Sets the starting block number used to accept future wrap requests.
    public fun set_starting_block_number(
        exchange_admin: &mut ExchangeAdmin,
        storage: &mut ExchangeCap,
        starting_block_number: u64,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.starting_block_number = starting_block_number;
    }

    /// Sets the authorized BTC relay object id.
    public fun set_btcrelay_object_id(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        btcrelay_object_id: ID,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.btcrelay_object_id = btcrelay_object_id;
    }

    /// Sets the special teleporter address authorized for wrap_and_swap.
    public fun set_special_teleporter(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        special_teleporter: address,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.special_teleporter = special_teleporter;
    }

    /// Sets the treasury address that receives protocol fees.
    public fun set_treasury(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        treasury: address,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.treasury = treasury;
    }

    /// Sets the protocol percentage fee (basis points) for future requests.
    public fun set_protocol_percentage_fee(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        protocol_percentage_fee: u64,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.protocol_percentage_fee = protocol_percentage_fee;
    }

    /// Sets the locker percentage fee (basis points) for future requests.
    public fun set_locker_percentage_fee(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        locker_percentage_fee: u64,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.locker_percentage_fee = locker_percentage_fee;
    }

    /// Adds or updates a third-party payout address.
    public fun set_third_party_address(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        third_party_id: u64, 
        third_party_address: address,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        table::add(&mut storage.third_party_address, third_party_id, third_party_address);
    }

    /// Adds or updates a third-party fee entry (basis points).
    public fun set_third_party_fee(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        third_party_id: u64, 
        third_party_fee: u64,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        table::add(&mut storage.third_party_fee, third_party_id, third_party_fee);
    }
    

    /// Sets a reward distributor address to handle locker fee payout. 0x0 disables distributor.
    public fun set_reward_distributor(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap, 
        reward_distributor: address,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        storage.reward_distributor = reward_distributor;
    }

    /// Adds a bridge token mapping for off-chain fill logic: source -> (chain_id -> dest token).
    public fun set_bridge_token_mapping(
        exchange_admin: &ExchangeAdmin,
        storage: &mut ExchangeCap,
        source_token: address,
        destination_chain_id: u64,
        destination_token: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == exchange_admin.owner, ENOT_OWNER);
        if (!table::contains(&storage.bridge_token_mapping, source_token)) {
            table::add(&mut storage.bridge_token_mapping, source_token, table::new(ctx));
        };
        let token_mapping = table::borrow_mut(&mut storage.bridge_token_mapping, source_token);
        table::add(token_mapping, destination_chain_id, destination_token);
    }

    // Getter functions for ExchangeRequest fields
    public fun app_id(request: &ExchangeRequest): u64 {
        request.app_id
    }

    public fun bridge_percentage_fee(request: &ExchangeRequest): u64 {
        request.bridge_percentage_fee
    }

    public fun input_amount(request: &ExchangeRequest): u64 {
        request.input_amount
    }

    public fun fee(request: &ExchangeRequest): u64 {
        request.fee
    }

    public fun third_party(request: &ExchangeRequest): u64 {
        request.third_party
    }

    public fun protocol_fee(request: &ExchangeRequest): u64 {
        request.protocol_fee
    }

    public fun third_party_fee(request: &ExchangeRequest): u64 {
        request.third_party_fee
    }

    public fun locker_fee(request: &ExchangeRequest): u64 {
        request.locker_fee
    }

    public fun remained_input_amount(request: &ExchangeRequest): u64 {
        request.remained_input_amount
    }

    public fun is_request_completed(request: &ExchangeRequest): bool {
        request.is_request_completed
    }

    public fun output_amount(request: &ExchangeRequest): u64 {
        request.output_amount
    }

    public fun is_fixed_token(request: &ExchangeRequest): bool {
        request.is_fixed_token
    }

    public fun recipient_address(request: &ExchangeRequest): address {
        request.recipient_address
    }

    public fun is_used(request: &ExchangeRequest): bool {
        request.is_used
    }

    public fun target_token(request: &ExchangeRequest): u8 {
        request.target_token
    }

    public fun speed(request: &ExchangeRequest): u64 {
        request.speed
    }

    // Getter functions for storage fields
    public fun locker_percentage_fee(storage: &ExchangeCap): u64 {
        storage.locker_percentage_fee
    }

    public fun get_third_party_fee_from_storage(storage: &ExchangeCap, third_party_id: u64): u64 {
        if (table::contains(&storage.third_party_fee, third_party_id)) {
            *table::borrow(&storage.third_party_fee, third_party_id)
        } else {
            0
        }
    }

    public fun reward_distributor(storage: &ExchangeCap): address {
        storage.reward_distributor
    }

    public fun get_third_party_address_from_storage(storage: &ExchangeCap, third_party_id: u64): address {
        if (table::contains(&storage.third_party_address, third_party_id)) {
            *table::borrow(&storage.third_party_address, third_party_id)
        } else {
            @0x0
        }
    }

    // Setter functions for ExchangeRequest fields (for internal updates)
    public(package) fun set_request_protocol_fee(request: &mut ExchangeRequest, protocol_fee: u64) {
        request.protocol_fee = protocol_fee;
    }

    public(package) fun set_request_third_party_fee(request: &mut ExchangeRequest, third_party_fee: u64) {
        request.third_party_fee = third_party_fee;
    }

    public(package) fun set_request_locker_fee(request: &mut ExchangeRequest, locker_fee: u64) {
        request.locker_fee = locker_fee;
    }

    public(package) fun set_request_remained_input_amount(request: &mut ExchangeRequest, remained_input_amount: u64) {
        request.remained_input_amount = remained_input_amount;
    }

    public(package) fun set_request_completed(request: &mut ExchangeRequest, is_completed: bool) {
        request.is_request_completed = is_completed;
    }
    
} 