#[allow(unused_use,unused_variable,unused_const,unused_mut_parameter,unused_field)]
module teleswap::burn_router_logic {
    use sui::table::{Self, Table};
    use teleswap::burn_router_storage::{Self, BurnRouter, BurnRequest, BURN_ROUTER_ADMIN};
    use teleswap::burn_router_helper::{Self};
    use btcrelay::bitcoin_helper::{Self};    
    use btcrelay::btcrelay::{Self, BTCRelay};
    use teleswap::telebtc::{TeleBTCCap, TELEBTC};
    use sui::coin::{Self, Coin, TreasuryCap};
    use teleswap::dummy_locker::{Self, LockerCapability};
    use sui::event;
    
    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    const DUST_SATOSHI_AMOUNT: u64 = 1000;
    
    // Error codes
    const EZERO_ADDRESS: u64 = 200;
    const ENOT_ORACLE: u64 = 201;
    const ELOW_STARTING_BLOCK: u64 = 202;
    const EINVALID_FEE: u64 = 203;
    const EINVALID_REWARD: u64 = 204;
    const ELOW_DEADLINE: u64 = 205;
    const ENOT_LOCKER: u64 = 206;
    const ETRANSFER_FAILED: u64 = 207;
    const EEXCHANGE_FAILED: u64 = 208;
    const EINVALID_PATH: u64 = 209;
    const EWRONG_AMOUNTS: u64 = 210;
    const EINVALID_AMOUNT: u64 = 211;
    const ELOW_AMOUNT: u64 = 212;
    const EFEE_TRANSFER_FAILED: u64 = 213;
    const ETHIRD_PARTY_FEE_TRANSFER_FAILED: u64 = 214;
    const ENETWORK_FEE_TRANSFER_FAILED: u64 = 215;
    const EALREADY_PAID: u64 = 216;
    const EDEADLINE_NOT_PASSED: u64 = 217;
    const EOLD_REQUEST: u64 = 218;
    const EWRONG_INPUTS: u64 = 219;
    const ENOT_FINALIZED: u64 = 220;
    const EALREADY_USED: u64 = 221;
    const EDEADLINE_NOT_PASSED_SLASH: u64 = 222;
    const EWRONG_OUTPUT_TX: u64 = 223;
    const ENOT_FOR_LOCKER: u64 = 224;
    const ENON_ZERO_LOCK_TIME: u64 = 225;
    const EWRONG_INDEXES: u64 = 226;
    const ELOW_FEE: u64 = 227;
    const EINVALID_SCRIPT: u64 = 228;
    const EUNSORTED_VOUT_INDEXES: u64 = 229;
    const EINVALID_BURN_PROOF: u64 = 230;
    const EINVALID_LOCKER: u64 = 231;
    const EALREADY_INITIALIZED: u64 = 232;


    // ===== EVENTS =====
    public struct NewUnwrap has copy, drop {
        user_script: vector<u8>,
        script_type: u8,
        locker_target_address: address,
        sender: address,
        request_id: u64,
        deadline: u64,
        third_party: u64,
        input_token: address,
        amounts: vector<u64>,
        fees: vector<u64>,
    }

    public struct BurnDispute has copy, drop {
        user: address,
        locker: address,
        locker_locking_script: vector<u8>,
        request_id_of_locker: u64
    }

    public struct LockerDispute has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        block_number: u64,
        tx_id: vector<u8>,
        total_value_slashed: u64,
    }

    // ===== PLACEHOLDER FUNCTIONS =====
    /// @notice Initializes the admin object for the burn router contract.
    /// @dev Should be called once at deployment to set up admin privileges.
    fun init(ctx: &mut TxContext){
        let admin = burn_router_storage::create_burn_router_admin(ctx);
        transfer::public_transfer(admin, tx_context::sender(ctx));
    }

    /// @notice Initializes the burn router contract with all configuration parameters.
    /// @dev Can only be called once. Shares the BurnRouter object for protocol use.
    /// @param burn_admin The admin object (must be mutable reference)
    /// @param starting_block_number The minimum block number for valid requests
    /// @param treasury The protocol treasury address
    /// @param transfer_deadline Deadline for sending BTC after a burn request
    /// @param protocol_percentage_fee Protocol fee percentage
    /// @param locker_percentage_fee Locker fee percentage
    /// @param slasher_percentage_reward Slasher reward percentage
    /// @param bitcoin_fee Fee for submitting a Bitcoin transaction
    /// @param wrapped_native_token The wrapped native token address
    /// @param bitcoin_fee_oracle The Bitcoin fee oracle address
    /// @param btcrelay_object_id The legitimate BTCRelay object ID
    /// @param ctx The transaction context
    public fun initialize(
        burn_admin: &mut BURN_ROUTER_ADMIN,
        starting_block_number: u64,
        treasury: address,
        transfer_deadline: u64,
        protocol_percentage_fee: u64,
        locker_percentage_fee: u64,
        slasher_percentage_reward: u64,
        bitcoin_fee: u64,
        wrapped_native_token: address,
        bitcoin_fee_oracle: address,
        btcrelay_object_id: ID,
        ctx: &mut TxContext
    ) {
        // Only allow initialization once, and set initialized in storage
        let owner = burn_router_storage::do_initialize(burn_admin);
        let burn_router = burn_router_storage::create_burn_router(
            owner,
            starting_block_number,
            transfer_deadline,
            protocol_percentage_fee,
            locker_percentage_fee,
            slasher_percentage_reward,
            bitcoin_fee,
            treasury,
            bitcoin_fee_oracle,
            wrapped_native_token,
            btcrelay_object_id,
            ctx
        );
        transfer::public_share_object(burn_router);
    }

    /// @notice Records a user's burn request for cross-chain BTC withdrawal.
    /// @dev After submitting, the locker has a limited time to send BTC and provide proof.
    /// @param burn_router The BurnRouter object
    /// @param input_token The address of teleBTC (default)
    /// @param amount_coin The Coin containing teleBTC to burn
    /// @param user_script The user's Bitcoin script hash
    /// @param script_type The users script type
    /// @param locker_locking_script The lockers Bitcoin locking script
    /// @param third_party The third party id
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The protocol treasury capability
    /// @param btcrelay The BTCRelay object
    /// @param ctx The transaction context
    /// @return The amount of BTC the user will receive
    public fun unwrap(
        burn_router: &mut BurnRouter,
        input_token: address, // address of teleBTC for default
        amount_coin: Coin<TELEBTC>,
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        third_party: u64,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap:  &mut TreasuryCap<TELEBTC>,
        btcrelay: &BTCRelay,
        ctx: &mut TxContext
    ): u64 {
        // Validate that the provided BTCRelay is the legitimate one
        assert!(
            burn_router_storage::validate_btcrelay(burn_router, btcrelay),
            EINVALID_BURN_PROOF
        );

        // Extract amount from coin
        let amount = coin::value(&amount_coin);
        let locker_target_address = dummy_locker::get_locker_target_address(locker_locking_script);
        // Check validity of user script
        burn_router_helper::check_script_type_and_locker(
            user_script,
            script_type,
            locker_locking_script
        );

        let (remaining_amount, protocol_fee, third_party_fee, locker_fee) = burn_and_distribute_fees(
            burn_router,
            amount_coin,
            locker_locking_script,
            third_party,
            telebtc_cap,
            treasury_cap,
            ctx
        );
        
        // Save burn request
        let request_id = burn_router_storage::save_burn_request(
            burn_router,
            amount,
            remaining_amount,
            user_script,
            script_type,
            btcrelay::lastSubmittedHeight(btcrelay),
            locker_target_address,
            ctx.sender(),
        );

        // Create amounts vector: [input_amount, amount, remaining_amount]
        let mut amounts = vector::empty<u64>();
        vector::push_back(&mut amounts, amount); // input_amount
        vector::push_back(&mut amounts, amount-remaining_amount); // fees
        vector::push_back(&mut amounts, remaining_amount); // remaining_amount

        // Create fees vector: [bitcoin_fee, locker_fee, protocol_fee, third_party_fee]
        let mut fees = vector::empty<u64>();
        vector::push_back(&mut fees, locker_fee); // locker_fee with bitcoin_fee
        vector::push_back(&mut fees, protocol_fee);
        vector::push_back(&mut fees, third_party_fee);

        // Emit NewUnwrap event 
        event::emit(NewUnwrap {
            user_script,
            script_type,
            locker_target_address,
            sender: ctx.sender(),
            request_id,
            deadline: btcrelay::lastSubmittedHeight(btcrelay) + burn_router_storage::get_transfer_deadline(burn_router),
            third_party,
            input_token,
            amounts,
            fees,
        });
        // For now, we'll just return the remaining amount
        remaining_amount
    }

    /// @notice Exchanges input token for teleBTC, then burns it for cross-chain withdrawal.
    /// @dev Not yet implemented. Will call exchange connector and then unwrap.
    /// @return The amount of BTC the user will receive
    public fun swap_and_unwrap(
        burn_router: &mut BurnRouter,
        exchange_connector: address,
        amounts: vector<u64>,
        is_fixed_token: bool,
        path: vector<address>,
        deadline: u64,
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        third_party: u64,
        ctx: &mut TxContext
    ): u64 {
        // Notice:Will implement this when exchange connector is implemented
        // TODO: Exchange input token for teleBTC
        // TODO: Call _swap_and_unwrap function
        // TODO: Return amount
        0
    }

    /// @notice Checks the correctness of a burn proof (Bitcoin tx) and marks requests as paid.
    /// @dev Only the locker or oracle can call. Updates isTransferred flag for paid requests.
    /// @return true if burn proof is valid
    public fun burn_proof(
        burn_router: &mut BurnRouter,
        btcrelay: &mut BTCRelay,
        version: vector<u8>,
        vin: vector<u8>,
        vout: vector<u8>,
        locktime: vector<u8>,
        block_number: u64,
        intermediate_nodes: vector<u8>,
        index: u64,
        locker_locking_script: vector<u8>,
        burn_req_indexes: vector<u64>,
        vout_indexes: vector<u64>,
        ctx: &mut TxContext
    ): bool {
        // Validate that the provided BTCRelay is the legitimate one
        assert!(
            burn_router_storage::validate_btcrelay(burn_router, btcrelay),
            EINVALID_BURN_PROOF
        );

        // Get the Locker target address
        let locker_target_address = dummy_locker::get_locker_target_address(locker_locking_script);
        
        // Validate caller is locker or oracle
        let caller = ctx.sender();
        assert!(
            caller == locker_target_address,
            ENOT_LOCKER
        );
        // we can design a cap to verify the caller is the locker

        // Call burn_proof_helper (placeholder for now)
        burn_router_helper::burn_proof_helper(
            block_number,
            burn_router_storage::get_starting_block_number(burn_router),
            locktime,
            locker_locking_script,
            vector::length(&burn_req_indexes),
            vector::length(&vout_indexes)
        );

        // Calculate transaction ID
        let tx_id = bitcoin_helper::calculate_tx_id(version, vin, vout, locktime);
        
        // Check transaction confirmation
        assert!(
            btcrelay::checkTxProof(
                btcrelay,
                tx_id,
                block_number,
                intermediate_nodes,
                index
            ),
            ENOT_FINALIZED
        );

        // Mark the burn requests that are paid by this transaction
        let paid_output_counter = burn_router_helper::check_paid_burn_requests(
            burn_router,
            tx_id,
            block_number,
            locker_target_address,
            vout,
            burn_req_indexes,
            vout_indexes
        );


        // Mark the Bitcoin tx as used for burn proof so Locker cannot use it again
        let is_used = burn_router_helper::update_is_used_as_burn_proof(
            burn_router_storage::get_is_used_as_burn_proof_mut(burn_router),
            paid_output_counter,
            &vout,
            &locker_locking_script,
            &tx_id
        );

        assert!(is_used, EINVALID_BURN_PROOF);
        true
    }



    /// @notice Slashes a locker if they did not pay a burn request before its deadline.
    /// @dev Only owner can call. Iterates over provided indices and slashes the locker for each.
    /// @param burn_admin The admin object
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param indices The indices of requests to dispute
    /// @param ctx The transaction context
    public fun dispute_burn(
        burn_admin: &BURN_ROUTER_ADMIN,
        burn_router: &mut BurnRouter,
        btcrelay: &BTCRelay,
        locker_locking_script: vector<u8>,
        indices: vector<u64>,
        ctx: &mut TxContext
    ) {
        burn_router_storage::assert_admin(tx_context::sender(ctx), burn_router);
        // Check if the locking script is valid
        assert!(dummy_locker::is_locker(locker_locking_script), EINVALID_LOCKER);

        // Get the target address of the locker from its locking script
        let locker_target_address = dummy_locker::get_locker_target_address(locker_locking_script);

        let len = vector::length(&indices);
        let mut i = 0u64;
        while (i < len) {
            let idx = *vector::borrow(&indices, i);
            // Call helper to process dispute (placeholder)
            burn_router_helper::dispute_burn_helper(
                burn_router,
                btcrelay,
                locker_target_address,
                idx
            );

            // Get the burn request (assume getter exists)
            let request = burn_router_storage::get_burn_request(
                burn_router,
                locker_target_address,
                idx
            );
            let amount = burn_router_storage::get_amount(&request);
            let sender = burn_router_storage::get_sender(&request);

            // Call dummy locker slashing (placeholder)
            dummy_locker::slash_idle_locker(
                locker_target_address,
                amount, // slasher reward (placeholder)
                tx_context::sender(ctx), // slasher address
                amount, // total amount
                sender // user address
            );

            // Emit BurnDispute event (define if needed)
            let event = BurnDispute {
                user: sender,
                locker: locker_target_address,
                locker_locking_script: locker_locking_script,
                request_id_of_locker: burn_router_storage::get_request_id_of_locker(&request)
            };
            event::emit(event);
            i = i + 1;
        }
    }

    /// @notice Slashes a locker for issuing a malicious transaction not matching any burn request.
    /// @dev Only owner can call. Checks input tx, calls helper, and slashes locker.
    /// @param burn_admin The admin object
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param versions The versions of input and output txs
    /// @param input_vin The inputs of the malicious transaction
    /// @param input_vout The outputs of the malicious transaction
    /// @param output_vin The inputs of the spent transaction
    /// @param output_vout The outputs of the spent transaction
    /// @param locktimes The locktimes of input and output txs
    /// @param input_intermediate_nodes The Merkle proof for the malicious tx
    /// @param indexes_and_block_numbers Indices and block number for the input tx
    /// @param ctx The transaction context
    public fun dispute_locker(
        burn_admin: &BURN_ROUTER_ADMIN,
        burn_router: &mut BurnRouter,
        btcrelay: &BTCRelay,
        locker_locking_script: vector<u8>,
        versions: vector<vector<u8>>, // [inputTxVersion, outputTxVersion]
        input_vin: vector<u8>,
        input_vout: vector<u8>,
        output_vin: vector<u8>,
        output_vout: vector<u8>,
        locktimes: vector<vector<u8>>, // [inputTxLocktime, outputTxLocktime]
        input_intermediate_nodes: vector<u8>,
        indexes_and_block_numbers: vector<u64>, // [inputIndex, inputTxIndex, inputTxBlockNumber]
        ctx: &mut TxContext
    ) {
        burn_router_storage::assert_admin(tx_context::sender(ctx), burn_router);
        // 1. Calculate input tx id
        let input_tx_id = bitcoin_helper::calculate_tx_id(
            *vector::borrow(&versions, 0),
            input_vin,
            input_vout,
            *vector::borrow(&locktimes, 0)
        );

        // 2. Call dispute_and_slash_locker_helper
        let mut input_output_vin_vout = vector::empty<vector<u8>>();
        vector::push_back(&mut input_output_vin_vout, input_vin);
        vector::push_back(&mut input_output_vin_vout, output_vin);
        vector::push_back(&mut input_output_vin_vout, output_vout);
        burn_router_helper::dispute_and_slash_locker_helper(
            locker_locking_script,
            versions,
            input_output_vin_vout,
            burn_router,
            btcrelay,
            input_tx_id,
            locktimes,
            input_intermediate_nodes,
            indexes_and_block_numbers
        );

        // 3. Slash the locker for dispute
        slash_locker_for_dispute(
            burn_router,
            locker_locking_script,
            input_vout,
            input_tx_id,
            *vector::borrow(&indexes_and_block_numbers, 2),
            ctx
        );
    }

    // ===== PRIVATE FUNCTIONS =====

    /// @notice Calculates and distributes protocol, third-party, and locker fees, then burns remaining teleBTC.
    /// @dev Internal function used by unwrap. Returns all fee details.
    /// @return (remaining_amount, protocol_fee, third_party_fee, locker_fee)
    fun burn_and_distribute_fees(
        burn_router: &mut BurnRouter,
        amount_coin: Coin<TELEBTC>,
        locker_locking_script: vector<u8>,
        third_party: u64,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext
    ): (u64, u64, u64, u64) {
        // Calculate fees
        let amount = coin::value(&amount_coin);
        let protocol_fee = (amount * burn_router_storage::get_protocol_percentage_fee(burn_router)) / MAX_PERCENTAGE_FEE;
        let third_party_fee = (amount * burn_router_storage::get_third_party_fee(burn_router, third_party)) / MAX_PERCENTAGE_FEE;
        let locker_fee = (amount * burn_router_storage::get_locker_percentage_fee(burn_router)) / MAX_PERCENTAGE_FEE;
        let bitcoin_fee = burn_router_storage::get_bitcoin_fee(burn_router);
        let combined_locker_fee = locker_fee + bitcoin_fee;

        let remained_amount = amount - protocol_fee - third_party_fee - combined_locker_fee;
        assert!(remained_amount > DUST_SATOSHI_AMOUNT, ELOW_AMOUNT);
        let locker_target_address = dummy_locker::get_locker_target_address(locker_locking_script);

        // Start with the amount coin and split for each fee
        let mut coins = amount_coin;

        // Distribute fees to respective parties
        if (protocol_fee > 0) {
            let fee_coins = coin::split(&mut coins, protocol_fee, ctx);
            transfer::public_transfer(fee_coins, burn_router_storage::get_treasury(burn_router));
        };

        if (third_party_fee > 0) {
            let fee_coins = coin::split(&mut coins, third_party_fee, ctx);
            transfer::public_transfer(fee_coins, burn_router_storage::get_third_party_address(burn_router, third_party));
        };

        if (combined_locker_fee > 0) {
            let fee_coins = coin::split(&mut coins, combined_locker_fee, ctx);
            transfer::public_transfer(fee_coins, locker_target_address);
        };

        // Burn remaining coins using dummy_locker
        dummy_locker::burn(locker_locking_script, coins, telebtc_cap, treasury_cap, ctx);

        // Return fee details
        (remained_amount, protocol_fee, third_party_fee, combined_locker_fee)
    }

    /// @notice Helper to slash a locker for a malicious transaction, emits LockerDispute event.
    /// @dev Internal function, called by dispute_locker.
    /// @param burn_router The BurnRouter object
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param input_vout The outputs of the malicious transaction
    /// @param input_tx_id The tx id of the malicious transaction
    /// @param input_block_number The block number of the malicious transaction
    /// @param ctx The transaction context
    fun slash_locker_for_dispute(
        burn_router: &mut BurnRouter,
        locker_locking_script: vector<u8>,
        input_vout: vector<u8>,
        input_tx_id: vector<u8>,
        input_block_number: u64,
        ctx: &mut TxContext
    ) {
        let (locker_target_address, slasher_reward, total_value) = burn_router_helper::prepare_slash_locker_for_dispute(
            burn_router,
            input_vout,
            locker_locking_script,
        );
        dummy_locker::slash_thief_locker(
            locker_target_address,
            slasher_reward,
            tx_context::sender(ctx),
            total_value,
        );
        let total_value_slashed = total_value + slasher_reward;
        let event = LockerDispute {
            locker_target_address,
            locker_locking_script,
            block_number: input_block_number,
            tx_id: input_tx_id,
            total_value_slashed
        };
        event::emit(event);
    }

} 