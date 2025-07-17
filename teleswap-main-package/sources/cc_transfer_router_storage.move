#[allow( lint(self_transfer))]
module teleswap::cc_transfer_router_storage {
    use sui::table::{Self, Table};
    use sui::event;
    use btcrelay::btcrelay::BTCRelay;

    // === Error Codes ===
    const EINVALID_PARAMETER: u64 = 313;
    const EINVALID_ADMIN: u64 = 314;
    const EZERO_ADDRESS: u64 = 315;
    const EINVALID_THIRD_PARTY: u64 = 316;

    // === Constants ===
    /// Maximum allowed percentage fee (100%)
    const MAX_PERCENTAGE_FEE: u64 = 10000;

    // === Structs ===

    /// Represents a cross-chain transfer request
    public struct CCTransferRequest has store, drop, copy {
        inputAmount: u64,                  // Amount of BTC to be transferred
        recipientAddress: address,         // Recipient's Sui address
        fee: u64,                          // Network fee in satoshis
        speed: u8,                         // Transfer speed (0: normal, 1: instant)
        isUsed: bool                       // Whether the request has been processed
    }

    /// Structure for passing transaction and its inclusion proof
    public struct TxAndProof has store, drop, copy {
        version: vector<u8>,           // Bitcoin transaction version
        vin: vector<u8>,              // Transaction inputs
        vout: vector<u8>,             // Transaction outputs
        locktime: vector<u8>,         // Transaction locktime
        block_number: u64,            // Block height containing the transaction
        intermediate_nodes: vector<u8>, // Merkle proof nodes
        index: u64                    // Transaction index in block
    }

    /// Admin control structure for the contract
    /// Stores owner address
    public struct CC_TRANSFER_ADMIN has key, store {
        id: UID,                      // Unique identifier
        owner: address,                // Admin owner address
        initialized: bool              // Whether the admin has been initialized
    }

    /// Main contract structure for CC transfer router
    /// Manages cross-chain transfer requests and fee configurations
    public struct CCTransferRouterCap has key, store {
        id: UID,                      // Unique identifier
        starting_block_number: u64,   // Minimum block height for valid requests
        app_id: u8,                   // Application identifier
        protocol_percentage_fee: u64, // Protocol fee percentage (0-10000)
        special_teleporter: address,  // Special teleporter address
        treasury: address,            // Treasury address for fee collection
        locker_percentage_fee: u64,   // Locker fee percentage (0-10000)
        btcrelay_object_id: ID,     // BTCRelay object ID
        
        // Storage tables
        transfer_requests: Table<vector<u8>, CCTransferRequest>,  // Maps tx_id to transfer request
        third_party_fees: Table<u8, u64>,                        // Maps third party ID to fee
        third_party_addresses: Table<u8, address>,               // Maps third party ID to address
        third_party_mapping: Table<vector<u8>, u8>,              // Maps tx_id to third party ID
        owner: address                                           // Contract owner address
    }

    // === Events ===

    /// Emitted when a new transfer request is created
    public struct TransferRequestCreated has copy, drop {
        tx_id: vector<u8>,           // Bitcoin transaction ID
        speed: u8,                   // Transfer speed
        recipient: address,          // Recipient address
        amount: u64,                 // Transfer amount
        network_fee: u64             // Network fee
    }

    /// Emitted when protocol fee is updated
    public struct ProtocolFeeUpdated has copy, drop {
        old_fee: u64,    // Previous protocol fee
        new_fee: u64     // New protocol fee
    }

    /// Emitted when treasury address is updated
    public struct NewTreasury has copy, drop {
        old_treasury: address,  // Previous treasury address
        new_treasury: address   // New treasury address
    }

    /// Emitted when third party address is updated
    public struct NewThirdPartyAddress has copy, drop {
        third_party_id: u8,     // Third party identifier
        old_address: address,   // Previous third party address
        new_address: address    // New third party address
    }

    /// Emitted when third party fee is updated
    public struct NewThirdPartyFee has copy, drop {
        third_party_id: u8,  // Third party identifier
        old_fee: u64,        // Previous fee value
        new_fee: u64         // New fee value
    }

    // === Public Functions ===

    /// Creates a new cross-chain transfer request
    /// Stores the request details and emits an event
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @param speed Transfer speed (0: normal, 1: instant)
    /// @param recipient Recipient's Sui address
    /// @param amount Transfer amount in satoshis
    /// @param network_fee Network fee in satoshis
    /// @param third_party_id Third party service identifier
    /// @param ctx Transaction context
    public(package) fun create_transfer_request(
        router: &mut CCTransferRouterCap,
        tx_id: vector<u8>,
        speed: u8,
        recipient: address,
        amount: u64,
        network_fee: u64,
        third_party_id: u8,
    ) {
        let request = CCTransferRequest {
            inputAmount: amount,
            recipientAddress: recipient,
            speed,
            fee: network_fee,
            isUsed: true
        };

        // Store request and third party mapping
        table::add(&mut router.transfer_requests, tx_id, request);
        table::add(&mut router.third_party_mapping, tx_id, third_party_id);

        // Emit creation event
        event::emit(TransferRequestCreated {
            tx_id,
            speed,
            recipient,
            amount,
            network_fee,
        });
    }

    /// Creates a new CC transfer router instance
    /// Initializes the router with configuration parameters
    /// @param admin Admin capability object
    /// @param starting_block_number Minimum block height for valid requests
    /// @param app_id Application identifier
    /// @param protocol_percentage_fee Protocol fee percentage (0-10000)
    /// @param special_teleporter Special teleporter address
    /// @param treasury Treasury address for fee collection
    /// @param locker_percentage_fee Locker fee percentage (0-10000)
    /// @param btcrelay_object_id The legitimate BTCRelay object ID
    /// @param ctx Transaction context
    /// @return New CC transfer router instance
    public(package) fun create_cc_transfer_router(
        admin: &CC_TRANSFER_ADMIN,
        starting_block_number: u64,
        app_id: u8,
        protocol_percentage_fee: u64,
        special_teleporter: address,
        treasury: address,
        locker_percentage_fee: u64,
        btcrelay_object_id: ID,
        ctx: &mut TxContext
    ): CCTransferRouterCap {
        // Validate fee percentages
        assert!(protocol_percentage_fee <= MAX_PERCENTAGE_FEE, EINVALID_PARAMETER);
        assert!(locker_percentage_fee <= MAX_PERCENTAGE_FEE, EINVALID_PARAMETER);

        let owner = admin.owner;
        CCTransferRouterCap {
            id: object::new(ctx),
            starting_block_number,
            app_id,
            protocol_percentage_fee,
            special_teleporter,
            treasury,
            locker_percentage_fee,
            btcrelay_object_id,
            transfer_requests: table::new(ctx),
            third_party_fees: table::new(ctx),
            third_party_addresses: table::new(ctx),
            third_party_mapping: table::new(ctx),
            owner: owner
        }
    }

    /// @notice Validates that the provided BTCRelay object is the legitimate one
    /// @param router The CCTransferRouterCap object
    /// @param btcrelay The BTCRelay object to validate
    /// @return true if the BTCRelay is legitimate
    public fun validate_btcrelay(router: &CCTransferRouterCap, btcrelay: &BTCRelay): bool {
        object::id(btcrelay) == router.btcrelay_object_id
    }

    /// @notice Gets the legitimate BTCRelay object ID
    /// @param router The CCTransferRouterCap object
    /// @return The legitimate BTCRelay object ID
    public fun get_btcrelay_object_id(router: &CCTransferRouterCap): ID {
        router.btcrelay_object_id
    }

    /// Creates a new admin instance
    /// Transfers admin control to the sender
    /// @param ctx Transaction context
    public(package) fun create_admin(ctx: &mut TxContext) {
        transfer::public_transfer(CC_TRANSFER_ADMIN {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            initialized: false
        }, tx_context::sender(ctx));
    }

    /// Sets the starting block number
    /// Only callable by admin
    /// @param router The CC transfer router capability
    /// @param admin Admin capability object
    /// @param new_block_number New starting block number
    public fun set_starting_block_number(
        router: &mut CCTransferRouterCap,
        admin: &CC_TRANSFER_ADMIN,
        new_block_number: u64
    ) {
        assert_admin(admin.owner, router);
        router.starting_block_number = new_block_number;
    }
    
    /// Sets the third party fee
    /// Only callable by admin
    /// @param router The CC transfer router capability
    /// @param admin Admin capability object
    /// @param third_party_id Third party identifier
    /// @param new_fee New fee value
    public fun set_third_party_fee(
        router: &mut CCTransferRouterCap,
        admin: &CC_TRANSFER_ADMIN,
        third_party_id: u8,
        new_fee: u64
    ) {
        assert_admin(admin.owner, router);
        assert!(table::contains(&router.third_party_addresses, third_party_id), EINVALID_THIRD_PARTY);
        
        // Get old fee value
        let old_fee = if (table::contains(&router.third_party_fees, third_party_id)) {
            *table::borrow(&router.third_party_fees, third_party_id)
        } else {
            0
        };

        // Update fee value
        if (table::contains(&router.third_party_fees, third_party_id)) {
            table::remove(&mut router.third_party_fees, third_party_id);
        };
        table::add(&mut router.third_party_fees, third_party_id, new_fee);

        // Emit fee update event
        event::emit(NewThirdPartyFee {
            third_party_id,
            old_fee,
            new_fee
        });
    }

    /// Sets the third party address
    /// Only callable by admin
    /// @param router The CC transfer router capability
    /// @param admin Admin capability object
    /// @param third_party_id Third party identifier
    /// @param new_address New third party address
    public fun set_third_party_address(
        router: &mut CCTransferRouterCap,
        admin: &CC_TRANSFER_ADMIN,
        third_party_id: u8,
        new_address: address
    ) {
        assert_admin(admin.owner, router);
        
        // Get old address
        let old_address = if (table::contains(&router.third_party_addresses, third_party_id)) {
            *table::borrow(&router.third_party_addresses, third_party_id)
        } else {
            @0x0
        };

        // Update address
        if (table::contains(&router.third_party_addresses, third_party_id)) {
            table::remove(&mut router.third_party_addresses, third_party_id);
        };
        table::add(&mut router.third_party_addresses, third_party_id, new_address);

        // Emit address update event
        event::emit(NewThirdPartyAddress {
            third_party_id,
            old_address,
            new_address
        });
    }

    /// Renounces admin ownership
    /// Transfers admin control to zero address
    /// @param router The CC transfer router capability
    /// @param admin Admin capability object
    /// @param ctx Transaction context
    public fun renounce_admin_ownership(
        router: &mut CCTransferRouterCap,
        admin: CC_TRANSFER_ADMIN
    ) {
        assert_admin(admin.owner, router);
        transfer::public_transfer(admin, @0x0);
    }

    /// Sets the protocol percentage fee
    /// Only callable by admin
    /// @param router The CC transfer router capability
    /// @param admin Admin capability object
    /// @param new_protocol_percentage_fee New protocol fee percentage (0-10000)
    public fun set_protocol_percentage_fee(
        router: &mut CCTransferRouterCap,
        admin: &CC_TRANSFER_ADMIN,
        new_protocol_percentage_fee: u64
    ) {
        assert_admin(admin.owner, router);
        assert!(new_protocol_percentage_fee <= MAX_PERCENTAGE_FEE, EINVALID_PARAMETER);
        
        let old_fee = router.protocol_percentage_fee;
        router.protocol_percentage_fee = new_protocol_percentage_fee;
        
        event::emit(ProtocolFeeUpdated {
            old_fee,
            new_fee: new_protocol_percentage_fee
        });
    }

    /// Sets the treasury address
    /// Only callable by admin
    /// @param router The CC transfer router capability
    /// @param admin Admin capability object
    /// @param new_treasury New treasury address
    public fun set_treasury(
        router: &mut CCTransferRouterCap,
        admin: &CC_TRANSFER_ADMIN,
        new_treasury: address
    ) {
        assert_admin(admin.owner, router);
        assert!(new_treasury != @0x0, EZERO_ADDRESS);
        
        let old_treasury = router.treasury;
        router.treasury = new_treasury;
        
        event::emit(NewTreasury {
            old_treasury,
            new_treasury
        });
    }

    // === View Functions ===

    /// Returns the application ID
    /// @param router The CC transfer router capability
    /// @return Application identifier
    public fun get_app_id(router: &CCTransferRouterCap): u8 {
        router.app_id
    }

    /// Checks if a request has been processed
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @return True if the request has been processed
    public fun is_request_used(router: &CCTransferRouterCap, tx_id: vector<u8>): bool {
        if (!table::contains(&router.transfer_requests, tx_id)) {
            return false
        };
        let request = table::borrow(&router.transfer_requests, tx_id);
        request.isUsed
    }

    /// Returns the transfer request for a given transaction ID
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @return Reference to the transfer request
    public fun get_transfer_request(router: &CCTransferRouterCap, tx_id: vector<u8>): &CCTransferRequest {
        table::borrow(&router.transfer_requests, tx_id)
    }

    /// Returns the amount from a transfer request
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @return Transfer amount in satoshis
    public fun get_amount(router: &CCTransferRouterCap, tx_id: vector<u8>): u64 {
        let request = get_transfer_request(router, tx_id);
        request.inputAmount
    }

    /// Returns the network fee from a transfer request
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @return Network fee in satoshis
    public fun get_network_fee(router: &CCTransferRouterCap, tx_id: vector<u8>): u64 {
        let request = get_transfer_request(router, tx_id);
        request.fee
    }

    /// Returns the recipient address from a transfer request
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @return Recipient's Sui address
    public fun get_recipient(router: &CCTransferRouterCap, tx_id: vector<u8>): address {
        let request = get_transfer_request(router, tx_id);
        request.recipientAddress
    }

    /// Returns the protocol percentage fee
    /// @param router The CC transfer router capability
    /// @return Protocol fee percentage (0-10000)
    public fun get_protocol_percentage_fee(router: &CCTransferRouterCap): u64 {
        router.protocol_percentage_fee
    }

    /// Returns the treasury address
    /// @param router The CC transfer router capability
    /// @return Treasury address
    public fun get_treasury(router: &CCTransferRouterCap): address {
        router.treasury
    }

    /// Returns the third party fee for a given third party ID
    /// @param router The CC transfer router capability
    /// @param third_party_id Third party identifier
    /// @return Third party fee value
    public fun get_third_party_fee(router: &CCTransferRouterCap, third_party_id: u8): u64 {
        if (table::contains(&router.third_party_fees, third_party_id)) {
            *table::borrow(&router.third_party_fees, third_party_id)
        } else {
            0
        }
    }

    /// Returns the third party address for a given third party ID
    /// @param router The CC transfer router capability
    /// @param third_party_id Third party identifier
    /// @return Third party address
    public fun get_third_party_address(router: &CCTransferRouterCap, third_party_id: u8): address {
        if (table::contains(&router.third_party_addresses, third_party_id)) {
            *table::borrow(&router.third_party_addresses, third_party_id)
        } else {
            @0x0
        }
    }

    /// Returns the third party ID for a given transaction ID
    /// @param router The CC transfer router capability
    /// @param tx_id Bitcoin transaction ID
    /// @return Third party identifier
    public fun get_third_party_id(router: &CCTransferRouterCap, tx_id: vector<u8>): u8 {
        if (table::contains(&router.third_party_mapping, tx_id)) {
            *table::borrow(&router.third_party_mapping, tx_id)
        } else {
            0
        }
    }

    /// Helper function to verify admin privileges
    /// @param caller Caller's address
    /// @param router The CC transfer router capability
    public fun assert_admin(caller: address, router: &CCTransferRouterCap) {
        assert!(caller == router.owner, EINVALID_ADMIN);
    }

    /// Returns the special teleporter address
    /// @param router The CC transfer router capability
    /// @return Special teleporter address
    public fun get_special_teleporter(router: &CCTransferRouterCap): address {
        router.special_teleporter
    }

    /// Returns the starting block number
    /// @param router The CC transfer router capability
    /// @return Starting block number
    public fun get_starting_block_number(router: &CCTransferRouterCap): u64 {
        router.starting_block_number
    }

    /// Returns the locker percentage fee
    /// @param router The CC transfer router capability
    /// @return Locker fee percentage (0-10000)
    public fun get_locker_percentage_fee(router: &CCTransferRouterCap): u64 {
        router.locker_percentage_fee
    }

    /// Returns the transfer requests table
    /// @param router The CC transfer router capability
    /// @return Reference to transfer requests table
    public fun get_transfer_requests(router: &CCTransferRouterCap): &Table<vector<u8>, CCTransferRequest> {
        &router.transfer_requests
    }

    /// Returns the third party mapping table
    /// @param router The CC transfer router capability
    /// @return Reference to third party mapping table
    public fun get_third_party_mapping(router: &CCTransferRouterCap): &Table<vector<u8>, u8> {
        &router.third_party_mapping
    }

    /// Returns the third party fees table
    /// @param router The CC transfer router capability
    /// @return Reference to third party fees table
    public fun get_third_party_fees(router: &CCTransferRouterCap): &Table<u8, u64> {
        &router.third_party_fees
    }

    // === TxAndProof Getters ===

    /// Returns the version from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Transaction version
    public fun get_version(tx_and_proof: &TxAndProof): vector<u8> {
        tx_and_proof.version
    }

    /// Returns the vin from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Transaction inputs
    public fun get_vin(tx_and_proof: &TxAndProof): vector<u8> {
        tx_and_proof.vin
    }

    /// Returns the vout from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Transaction outputs
    public fun get_vout(tx_and_proof: &TxAndProof): vector<u8> {
        tx_and_proof.vout
    }

    /// Returns the locktime from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Transaction locktime
    public fun get_locktime(tx_and_proof: &TxAndProof): vector<u8> {
        tx_and_proof.locktime
    }

    /// Returns the block number from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Block height
    public fun get_block_number(tx_and_proof: &TxAndProof): u64 {
        tx_and_proof.block_number
    }

    /// Returns the intermediate nodes from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Merkle proof nodes
    public fun get_intermediate_nodes(tx_and_proof: &TxAndProof): vector<u8> {
        tx_and_proof.intermediate_nodes
    }

    /// Returns the index from TxAndProof
    /// @param tx_and_proof Transaction and proof data
    /// @return Transaction index in block
    public fun get_index(tx_and_proof: &TxAndProof): u64 {
        tx_and_proof.index
    }

    // === CCTransferRequest Getters ===

    /// Returns the recipient address from CCTransferRequest
    /// @param request Transfer request
    /// @return Recipient's Sui address
    public fun get_recipient_address(request: &CCTransferRequest): address {
        request.recipientAddress
    }

    /// Returns the input amount from CCTransferRequest
    /// @param request Transfer request
    /// @return Transfer amount in satoshis
    public fun get_input_amount(request: &CCTransferRequest): u64 {
        request.inputAmount
    }

    /// Returns the fee from CCTransferRequest
    /// @param request Transfer request
    /// @return Network fee in satoshis
    public fun get_fee(request: &CCTransferRequest): u64 {
        request.fee
    }

    public fun set_initialized(admin: &mut CC_TRANSFER_ADMIN) {
        admin.initialized = true;
    }

    public fun get_initialized(admin: &CC_TRANSFER_ADMIN): bool {
        admin.initialized
    }

    /// Creates a new TxAndProof instance
    /// @param version Bitcoin transaction version
    /// @param vin Transaction inputs
    /// @param vout Transaction outputs
    /// @param locktime Transaction locktime
    /// @param block_number Block height containing the transaction
    /// @param intermediate_nodes Merkle proof nodes
    /// @param index Transaction index in block
    /// @return New TxAndProof instance
    public fun create_tx_and_proof(
        version: vector<u8>,
        vin: vector<u8>,
        vout: vector<u8>,
        locktime: vector<u8>,
        block_number: u64,
        intermediate_nodes: vector<u8>,
        index: u64
    ): TxAndProof {
        TxAndProof {
            version,
            vin,
            vout,
            locktime,
            block_number,
            intermediate_nodes,
            index
        }
    }
} 