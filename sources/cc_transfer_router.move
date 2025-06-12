#[allow( lint(self_transfer),lint(share_owned))]
module teleswap::cc_transfer_router {
    use teleswap::cc_transfer_router_storage::{Self, CCTransferRouterCap, CC_TRANSFER_ADMIN, TxAndProof};
    use teleswap::telebtc::{TeleBTCCap, TELEBTC};
    use teleswap::btcrelay::{Self, BTCRelay};
    use teleswap::dummy_locker::{Self, LockerCapability};
    use teleswap::bitcoin_helper;
    use teleswap::request_parser;
    use sui::coin::{Self, TreasuryCap};
    use sui::event;

    // === Error Codes ===

    const EINVALID_LOCKER: u64 = 11;
    const EINVALID_DATA_LENGTH: u64 = 12;
    const EZERO_INPUT_AMOUNT: u64 = 13;
    const EINVALID_APP_ID: u64 = 14;
    const EINVALID_FEE: u64 = 15;
    const EINVALID_SPEED: u64 = 16;
    const EINVALID_SENDER: u64 = 19;
    const EREQUEST_TOO_OLD: u64 = 20;
    const EREQUEST_USED: u64 = 21;
    const ENONZERO_LOCKTIME: u64 = 22;
    const ETX_NOT_FINALIZED: u64 = 23;
    const EALREADY_INITIALIZED: u64 = 24;
    // === Events ===

    /// Emitted when a new wrap request is completed
    /// Contains details about the wrapped transaction including amounts and fees
    public struct NewWrap has copy, drop {
        bitcoin_tx_id: vector<u8>,          // Bitcoin transaction ID
        locker_locking_script: vector<u8>,  // Locker's Bitcoin address
        locker_target_address: address,     // Locker's Sui address
        user: address,                      // User's Sui address
        teleporter: address,                // Teleporter's address
        amounts: vector<u64>,               // [inputAmount, teleBTCAmount]
        fees: vector<u64>,                  // [network fee, locker fee, protocol fee, third party fee]
        third_party_id: u8                  // ID of the third party service
    }

    // === Initialization Functions ===

    /// Initializes the CC transfer router with all necessary components
    /// Creates and transfers the admin object to the sender
    /// @param ctx The transaction context
    fun init(
        ctx: &mut TxContext
    ) {
        cc_transfer_router_storage::create_admin(ctx);
    }

    /// Initializes the router with configuration parameters
    /// Creates and shares the router object for public access
    /// @param starting_block_number Starting block number for transaction validation
    /// @param app_id Application identifier
    /// @param protocol_percentage_fee Protocol fee percentage (0-10000)
    /// @param special_teleporter Special teleporter address
    /// @param treasury Treasury address for fee collection
    /// @param locker_percentage_fee Locker fee percentage (0-10000)
    /// @param admin Admin capability object
    /// @param ctx Transaction context
    public fun initialize(
        starting_block_number: u64,
        app_id: u8,
        protocol_percentage_fee: u64,
        special_teleporter: address,
        treasury: address,
        locker_percentage_fee: u64,
        admin: &mut CC_TRANSFER_ADMIN,
        ctx: &mut TxContext
    ){
        assert!(!cc_transfer_router_storage::get_initialized(admin), EALREADY_INITIALIZED);
        let router = cc_transfer_router_storage::create_cc_transfer_router(
            admin,
            starting_block_number,
            app_id,
            protocol_percentage_fee,
            special_teleporter,
            treasury,
            locker_percentage_fee,
            ctx
        );
        transfer::public_share_object(router);
        cc_transfer_router_storage::set_initialized(admin);
    }

    // === Core Functions ===

    /// Checks if a transaction is confirmed on the source chain
    /// Validates the transaction proof against the Bitcoin relay
    /// @param router The CC transfer router
    /// @param tx_id Transaction ID in little-endian format (hex format without 0x prefix)
    /// @param block_number Height of the block containing the transaction
    /// @param intermediate_nodes Merkle proof nodes from transaction to root (hex format without 0x prefix)
    /// @param index Position of transaction in the block
    /// @param relay The Bitcoin relay instance
    /// @return True if transaction is confirmed on Bitcoin
    fun is_confirmed(
        tx_id: vector<u8>,
        block_number: u64,
        intermediate_nodes: vector<u8>,
        index: u64,
        relay: &mut BTCRelay
    ): bool {
        btcrelay::checkTxProof(
            relay,
            tx_id,
            block_number,
            intermediate_nodes,
            index
        )
    }

    /// Mints teleBTC and distributes fees to various parties
    /// Handles the minting of teleBTC tokens and distribution of fees to:
    /// - Network fee to teleporter
    /// - Protocol fee to treasury
    /// - Third party fee to service provider
    /// - Locker fee to locker
    /// @param router The CC transfer router
    /// @param locker_cap The locker capability
    /// @param locker_locking_script Locker's locking script
    /// @param tx_id The transaction ID of the request
    /// @param telebtc_cap TeleBTC capability object
    /// @param treasury_cap Treasury capability object
    /// @param ctx The transaction context
    /// @return Tuple of (amount, remained_amount, network_fee, locker_fee, protocol_fee, third_party_fee, recipient_address)
    fun mint_and_distribute(
        router: & CCTransferRouterCap,
        locker_cap: &mut LockerCapability,
        locker_locking_script: vector<u8>,
        tx_id: vector<u8>,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext
    ):(u64,u64,u64,u64,u64,u64,address){
        // Calculate fees
        let amount = cc_transfer_router_storage::get_amount(router, tx_id);
        let protocol_fee = (amount * cc_transfer_router_storage::get_protocol_percentage_fee(router)) / 10000;
        let network_fee = cc_transfer_router_storage::get_network_fee(router, tx_id);
        let third_party_id = cc_transfer_router_storage::get_third_party_id(router, tx_id);
        let third_party_fee = (amount * cc_transfer_router_storage::get_third_party_fee(router, third_party_id)) / 10000;
        let locker_fee = protocol_fee*2; // just a place holder, will implement later when doing the locker contract
        let remained_amount = amount - protocol_fee - network_fee - third_party_fee;
        let recipient_address = cc_transfer_router_storage::get_recipient(router, tx_id);

        // Mint teleBTC and get the coins
        let (mut coins, locker_address) = dummy_locker::mint(locker_locking_script, amount, locker_cap, telebtc_cap, treasury_cap, recipient_address, ctx);

        // Distribute fees to respective parties
        if (network_fee > 0) {
            let teleport_reward = coin::split(&mut coins, network_fee, ctx);
            transfer::public_transfer(teleport_reward, tx_context::sender(ctx));
        };

        if (protocol_fee > 0) {
            let fee_coins = coin::split(&mut coins, protocol_fee, ctx);
            transfer::public_transfer(fee_coins, cc_transfer_router_storage::get_treasury(router));
        };

        if (third_party_fee > 0) {
            let fee_coins = coin::split(&mut coins, third_party_fee, ctx);
            let third_party_address = cc_transfer_router_storage::get_third_party_address(router, third_party_id);
            transfer::public_transfer(fee_coins, third_party_address);
        };

        if (locker_fee > 0) {
            let fee_coins = coin::split(&mut coins, locker_fee, ctx);
            transfer::public_transfer(fee_coins, locker_address);
        };

        // Transfer remaining coins to recipient
        transfer::public_transfer(coins, recipient_address);

        // Return fee details
        (amount, remained_amount, network_fee, locker_fee, protocol_fee, third_party_fee, recipient_address)
    }

    /// Parses and validates a cross-chain transfer request
    /// Verifies the request format and saves it for processing
    /// @param router The CC transfer router capability
    /// @param locker_locking_script Locker's locking script
    /// @param vout The outputs of the transaction
    /// @param tx_id The transaction ID of the request
    /// @param ctx The transaction context
    fun save_cc_transfer_request(
        router: &mut CCTransferRouterCap,
        locker_locking_script: vector<u8>,
        vout: vector<u8>,
        tx_id: vector<u8>
    ) {
        // Verify locker exists
        assert!(dummy_locker::is_locker(locker_locking_script), EINVALID_LOCKER);

        // Extract value and opreturn data from request
        let (input_amount, arbitrary_data) = bitcoin_helper::parse_value_and_data_having_locking_script_small_payload(
            &vout,
            &locker_locking_script
        );

        // Verify data length is correct (38 bytes)
        assert!(vector::length(&arbitrary_data) == 38, EINVALID_DATA_LENGTH);

        // Verify input amount is not zero
        assert!(input_amount > 0, EZERO_INPUT_AMOUNT);

        // Verify app ID matches
        let app_id = request_parser::parse_app_id(&arbitrary_data);
        assert!(app_id == cc_transfer_router_storage::get_app_id(router), EINVALID_APP_ID);
        let network_fee = request_parser::parse_network_fee(&arbitrary_data);
        assert!(network_fee <= input_amount, EINVALID_FEE);

        // Parse and validate request parameters
        let recipient_address = request_parser::parse_recipient_address(&arbitrary_data);
        let speed = request_parser::parse_speed(&arbitrary_data);
        assert!(speed == 0, EINVALID_SPEED);

        let third_party_id = request_parser::parse_third_party_id(&arbitrary_data);

        // Save the validated request
        cc_transfer_router_storage::create_transfer_request(
            router,
            tx_id,
            speed,
            recipient_address,
            input_amount,
            network_fee,
            third_party_id,
        );
    }

    /// Check if the request has been executed before
    /// This is to avoid re-submitting a used request
    /// @param router The CC transfer router capability
    /// @param tx_id The transaction ID of the request
    /// @return True if the request has been executed
    fun is_request_used(router: &CCTransferRouterCap, tx_id: vector<u8>): bool {
        cc_transfer_router_storage::is_request_used(router, tx_id)
    }

    /// Executes the cross chain transfer request
    /// Validates the transfer request, then,
    /// if speed is 1, the request is instant which pays back the loan,
    /// if the speed is 0, it is a normal transfer
    /// @param router The CC transfer router capability
    /// @param tx_and_proof Transaction and merkle proof data
    /// @param locker_locking_script Locker address
    /// @param locker_cap Locker capability object
    /// @param relay The Bitcoin relay instance
    /// @param telebtc_cap TeleBTC capability object
    /// @param treasury_cap Treasury capability object
    /// @param ctx The transaction context
    public fun wrap(
        router: &mut CCTransferRouterCap,
        tx_and_proof: TxAndProof,
        locker_locking_script: vector<u8>,
        locker_cap: &mut LockerCapability,
        relay: &mut BTCRelay,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext
    ) {
        // Verify sender is authorized teleporter
        assert!(tx_context::sender(ctx) == cc_transfer_router_storage::get_special_teleporter(router), EINVALID_SENDER);

        // Verify block is not too old
        assert!(cc_transfer_router_storage::get_block_number(&tx_and_proof) >= cc_transfer_router_storage::get_starting_block_number(router), EREQUEST_TOO_OLD);

        // Calculate and verify transaction ID
        let tx_id = bitcoin_helper::calculate_tx_id(
            cc_transfer_router_storage::get_version(&tx_and_proof),
            cc_transfer_router_storage::get_vin(&tx_and_proof),
            cc_transfer_router_storage::get_vout(&tx_and_proof),
            cc_transfer_router_storage::get_locktime(&tx_and_proof)
        );

        // Verify request hasn't been used
        assert!(!is_request_used(router, tx_id), EREQUEST_USED);

        // Verify locktime is zero
        let locktime = cc_transfer_router_storage::get_locktime(&tx_and_proof);
        let mut is_all_zeros = true;
        let mut i = 0;
        while (i < vector::length(&locktime)) {
            if (vector::borrow(&locktime, i) != &0u8) {
                is_all_zeros = false;
                break
            };
            i = i + 1;
        };
        assert!(is_all_zeros, ENONZERO_LOCKTIME);

        // Save and validate the request
        save_cc_transfer_request(
            router,
            locker_locking_script,
            cc_transfer_router_storage::get_vout(&tx_and_proof),
            tx_id
        );

        // Verify transaction is confirmed
        assert!(
            is_confirmed(
                tx_id, 
                cc_transfer_router_storage::get_block_number(&tx_and_proof), 
                cc_transfer_router_storage::get_intermediate_nodes(&tx_and_proof), 
                cc_transfer_router_storage::get_index(&tx_and_proof), 
                relay
            ),
            ETX_NOT_FINALIZED
        );

        // Get locker target address
        let locker_target_address = dummy_locker::get_locker_target_address(locker_locking_script);

        // Process the wrap request
        let (amount,received_amount,network_fee,locker_fee,protocol_fee,third_party_fee,recipient_address) = mint_and_distribute(router, locker_cap, locker_locking_script, tx_id, telebtc_cap, treasury_cap, ctx);
       
        // Emit wrap completion event
        event::emit(NewWrap {
            bitcoin_tx_id: tx_id,
            locker_locking_script,
            locker_target_address,
            user: recipient_address,
            teleporter: tx_context::sender(ctx),
            amounts: vector[amount, received_amount],
            fees: vector[network_fee, locker_fee, protocol_fee, third_party_fee],
            third_party_id: cc_transfer_router_storage::get_third_party_id(router, tx_id)
        });
    }
} 