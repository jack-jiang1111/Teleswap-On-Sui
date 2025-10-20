#[allow(unused_use,unused_variable,unused_const,unused_mut_parameter,unused_field)]
module teleswap::burn_router_logic {
    use sui::table::{Self, Table};
    use teleswap::burn_router_storage::{Self, BurnRouter, BurnRequest, BURN_ROUTER_ADMIN};
    use teleswap::burn_router_helper::{Self};
    use btcrelay::bitcoin_helper::{Self};    
    use btcrelay::btcrelay::{Self,BTCRelay};
    use teleswap::telebtc::{Self, TeleBTCCap, TELEBTC};
    use sui::coin::{Self, Coin, TreasuryCap};
    use teleswap::lockerstorage::{Self, LockerCap};
    use teleswap::burn_router_locker_connector::{Self};
    use bridged_btc::btc::BTC;
    use sui::sui::SUI;
    use bridged_usdc::usdc::USDC;
    use bridged_usdt::usdt::USDT;
    use sui::clock::Clock;
    use sui::balance::{Self, Balance};
    use sui::event;
    use cetus_clmm::pool;
    use cetus_clmm::config::GlobalConfig;
    use teleswap::dexconnector::{Self};
    
    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    const DUST_SATOSHI_AMOUNT: u64 = 1000;
    
    // Error codes
    const ENOT_LOCKER: u64 = 201;
    const ENOT_FINALIZED: u64 = 202;
    const EINVALID_BURN_PROOF: u64 = 203;
    const EINVALID_LOCKER: u64 = 204;
    const EINVALID_BTCRELAY: u64 = 205;
    const ESWAP_FAILED: u64 = 206;
    const EINVALID_SWAP_RETURN_AMOUNT: u64 = 207;

    // === Events ===
    public struct DebugEvent has copy, drop {
            vec1: vector<u8>,
            vec2: vector<u8>,
            vec3: vector<u8>,
            vec4: vector<u8>,
            num1: u256,
            num2: u256,
            num3: u256,
            num4: u256,
            addr1: address,
            addr2: address,
            addr3: address,
            addr4: address
        }
    // ===== EVENTS =====
    public struct NewUnwrap has copy, drop {
        user_script: vector<u8>,
        script_type: u8,
        locker_target_address: address,
        sender: address,
        request_id: u64,
        deadline: u64,
        third_party: u64,
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
        bitcoin_fee_oracle: address,
        btcrelay_object_id: ID,
        rewarder_address: address,
        rewarder_percentage_fee: u64,
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
            btcrelay_object_id,
            rewarder_address,
            rewarder_percentage_fee,
            ctx
        );
        transfer::public_share_object(burn_router);
    }

    /// @notice Records a user's burn request for cross-chain BTC withdrawal.
    /// @dev After submitting, the locker has a limited time to send BTC and provide proof.
    /// @param burn_router The BurnRouter object
    /// @param amount_coins Vector of TeleBTC coins to unwrap
    /// @param amount The amount to unwrap from the merged coins
    /// @param user_script The user's Bitcoin script hash
    /// @param script_type The users script type
    /// @param locker_locking_script The lockers Bitcoin locking script
    /// @param third_party The third party id
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The protocol treasury capability
    /// @param btcrelay The BTCRelay object
    /// @param locker_cap The dummy locker capability
    /// @param ctx The transaction context
    /// @return The amount of BTC the user will receive
    public fun unwrap(
        burn_router: &mut BurnRouter,
        amount_coins: vector<Coin<TELEBTC>>,
        amount: u64,
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        third_party: u64,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap:  &mut TreasuryCap<TELEBTC>,
        btcrelay: &BTCRelay,
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ): u64 {
        // Call the connector function to avoid circular dependency
        burn_router_locker_connector::unwrap(
            burn_router,
            amount_coins,
            amount,
            user_script,
            script_type,
            locker_locking_script,
            third_party,
            telebtc_cap,
            treasury_cap,
            btcrelay,
            locker_cap,
            ctx
        )
    }

    /// @notice Exchanges input token for teleBTC, then burns it for cross-chain withdrawal.
    /// @dev After exchanging, rest of the process is similar to unwrap.
    /// @param burn_router The BurnRouter object
    /// @param amounts [inputTokenAmount, minTeleBTCAmount]
    /// @param user_script The user's Bitcoin script hash
    /// @param script_type The users script type
    /// @param locker_locking_script The lockers Bitcoin locking script
    /// @param third_party The third party id
    /// @param config Global configuration for Cetus CLMM
    /// @param pool_usdc_sui Pool for USDC-SUI trading
    /// @param pool_usdc_usdt Pool for USDC-USDT trading
    /// @param pool_usdc_wbtc Pool for USDC-WBTC trading
    /// @param pool_telebtc_wbtc Pool for TELEBTC-WBTC trading
    /// @param wbtc_coin WBTC coin for swapping (only one of the tokens should be non-zero)
    /// @param sui_coin SUI coin for swapping (only one of the tokens should be non-zero)
    /// @param usdt_coin USDT coin for swapping (only one of the tokens should be non-zero)
    /// @param usdc_coin USDC coin for swapping (only one of the tokens should be non-zero)
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The protocol treasury capability
    /// @param btcrelay The BTCRelay object
    /// @param locker_cap The dummy locker capability
    /// @param clock The Sui clock
    /// @param ctx The transaction context
    /// @return The amount of BTC the user will receive
    public fun swap_and_unwrap(
        burn_router: &mut BurnRouter,
        amounts: vector<u64>,
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        third_party: u64,
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        wbtc_coins: vector<Coin<BTC>>,
        sui_coins: vector<Coin<SUI>>,
        usdt_coins: vector<Coin<USDT>>,
        usdc_coins: vector<Coin<USDC>>,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        btcrelay: &BTCRelay,
        locker_cap: &mut LockerCap,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        // Exchange input token for teleBTC using the exchange helper
        let telebtc_coin = exchange_helper(
            config,
            pool_usdc_sui,
            pool_usdc_usdt,
            pool_usdc_wbtc,
            pool_telebtc_wbtc,
            amounts[0], // input amount
            amounts[1], // min output amount
            wbtc_coins,
            sui_coins,
            usdt_coins,
            usdc_coins,
            clock,
            ctx
        );
        // Call unwrap to burn the teleBTC and return the BTC amount
        let mut coins_vector = vector::empty<Coin<TELEBTC>>();
        vector::push_back(&mut coins_vector, telebtc_coin);
        let telebtc_amount = coin::value(vector::borrow(&coins_vector, 0));
        
        unwrap(
            burn_router, 
            coins_vector,
            telebtc_amount,
            user_script, 
            script_type, 
            locker_locking_script, 
            third_party, 
            telebtc_cap, 
            treasury_cap, 
            btcrelay, 
            locker_cap, 
            ctx
        )
    }

    /// @notice Checks the correctness of a burn proof (Bitcoin tx) and marks requests as paid.
    /// @dev Only the locker or oracle can call. Updates isTransferred flag for paid requests.
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object
    /// @param version Version of the Bitcoin tx
    /// @param vin Inputs of the Bitcoin tx
    /// @param vout Outputs of the Bitcoin tx
    /// @param locktime Lock time of the Bitcoin tx
    /// @param block_number Height of the block containing the Bitcoin tx
    /// @param intermediate_nodes Merkle inclusion proof for the Bitcoin tx
    /// @param index Index of the Bitcoin tx in the block
    /// @param locker_locking_script Locker's locking script that this burn request belongs to
    /// @param burn_req_indexes Indexes of requests that locker wants to provide proof for them
    /// @param vout_indexes Indexes of outputs that were used to pay burn requests.
    ///                     vout_indexes[i] belongs to burn_req_indexes[i]
    /// @param locker_cap The dummy locker capability
    /// @param ctx The transaction context
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
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext,
    ): bool {
        // Validate that the provided BTCRelay is the legitimate one
        assert!(
            burn_router_storage::validate_btcrelay(burn_router, btcrelay),
            EINVALID_BTCRELAY
        );

        // Get the Locker target address
        let locker_target_address = lockerstorage::get_locker_target_address(locker_locking_script,locker_cap);
        
        // Validate caller is locker or oracle
        let caller = ctx.sender();
        assert!(
            caller == locker_target_address,
            ENOT_LOCKER
        );
        // we can design a cap to verify the caller is the locker

        // Call burn_proof_helper 
        burn_router_helper::burn_proof_helper(
            block_number,
            burn_router_storage::get_starting_block_number(burn_router),
            locktime,
            locker_locking_script,
            vector::length(&burn_req_indexes),
            vector::length(&vout_indexes),
            locker_cap
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
        // if the burn proof provided is not matched with the burn request, it will revert with error EINVALID_BURN_PROOF
        // any invalid burn proof (amount doesn't match, deadline passed, etc.) will give false because paid_number = 0
        assert!(is_used, EINVALID_BURN_PROOF);
        true
    }



    /// @notice Slashes a locker if they did not pay a burn request before its deadline.
    /// @dev Only owner can call. Iterates over provided indices and slashes the locker for each.
    /// @param burn_admin The admin object
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object
    /// @param locker_locking_script Locker's locking script that the unpaid request belongs to
    /// @param indices Indices of requests that their deadline has passed
    /// @param ctx The transaction context
    /// @param locker_cap The dummy locker capability
    public fun dispute_burn(
        burn_admin: &BURN_ROUTER_ADMIN,
        burn_router: &mut BurnRouter,
        btcrelay: &BTCRelay,
        locker_locking_script: vector<u8>,
        indices: vector<u64>,
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ) {
        burn_router_storage::assert_admin(tx_context::sender(ctx), burn_router);
        // Check if the locking script is valid
        assert!(lockerstorage::is_locker(locker_cap,locker_locking_script), EINVALID_LOCKER);

        // Get the target address of the locker from its locking script
        let locker_target_address = lockerstorage::get_locker_target_address(locker_locking_script,locker_cap);

        let len = vector::length(&indices);
        let mut i = 0u64;
        while (i < len) {
            let idx = *vector::borrow(&indices, i);
            // Call helper to process dispute 
            burn_router_helper::dispute_burn_helper(
                burn_router,
                btcrelay,
                locker_target_address,
                idx
            );

            // Get the burn request
            let request = burn_router_storage::get_burn_request(
                burn_router,
                locker_target_address,
                idx
            );
            let amount = burn_router_storage::get_amount(&request);
            let sender = burn_router_storage::get_sender(&request);

            // Call burn_router_locker_connector slashing 
            burn_router_locker_connector::slash_idle_locker(
                locker_target_address,
                amount, // slasher reward 
                tx_context::sender(ctx), // slasher address
                amount, // total amount
                sender, // user address
                locker_cap,
                ctx
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
    /// @param locker_locking_script Suspicious locker's locking script
    /// @param versions Versions of input and output txs
    /// @param input_vin Inputs of the malicious transaction
    /// @param input_vout Outputs of the malicious transaction
    /// @param output_vin Inputs of the spent transaction
    /// @param output_vout Outputs of the spent transaction
    /// @param locktimes Locktimes of input and output txs
    /// @param input_intermediate_nodes Merkle inclusion proof for the malicious transaction
    /// @param indexes_and_block_numbers Indices of malicious input in input tx,
    ///                                input tx in block and block number of input tx
    /// @param ctx The transaction context
    /// @param locker_cap The dummy locker capability
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
        locker_cap: &mut LockerCap,
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
            indexes_and_block_numbers,
            locker_cap
        );

        // 3. Slash the locker for dispute
        slash_locker_for_dispute(
            burn_router,
            locker_locking_script,
            input_vout,
            input_tx_id,
            *vector::borrow(&indexes_and_block_numbers, 2),
            ctx,
            locker_cap
        );
    }

    // ===== PRIVATE FUNCTIONS =====


    /// @notice Helper to slash a locker for a malicious transaction, emits LockerDispute event.
    /// @dev Internal function, called by dispute_locker. Prepares slashing data and calls
    /// the dummy locker to perform the actual slashing. Emits LockerDispute event with
    /// details of the slashing operation.
    /// @param burn_router The BurnRouter object
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param input_vout The outputs of the malicious transaction
    /// @param input_tx_id The tx id of the malicious transaction
    /// @param input_block_number The block number of the malicious transaction
    /// @param ctx The transaction context
    /// @param locker_cap The dummy locker capability
    fun slash_locker_for_dispute(
        burn_router: &mut BurnRouter,
        locker_locking_script: vector<u8>,
        input_vout: vector<u8>,
        input_tx_id: vector<u8>,
        input_block_number: u64,
        ctx: &mut TxContext,
        locker_cap: &mut LockerCap
    ) {
        let (locker_target_address, slasher_reward, total_value) = burn_router_helper::prepare_slash_locker_for_dispute(
            burn_router,
            input_vout,
            locker_locking_script,
            locker_cap
        );
        burn_router_locker_connector::slash_thief_locker(
            locker_target_address,
            slasher_reward,
            tx_context::sender(ctx),
            total_value,
            locker_cap,
            ctx
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

    // this helper will swap the input token for teleBTC, and return the teleBTC coin
    fun exchange_helper(
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        input_amount: u64,
        min_output_amount: u64,
        wbtc_coin: vector<Coin<BTC>>,
        sui_coin: vector<Coin<SUI>>,
        usdt_coin: vector<Coin<USDT>>,
        usdc_coin: vector<Coin<USDC>>,
        clock: &Clock,
        ctx: &mut TxContext
    ): Coin<TELEBTC>
    {
        // Create a empty vector of teleBTC coin for the swap
        let telebtc_coins = vector::empty<Coin<TELEBTC>>();
        
        let (status,telebtc_coin,wbtc_coin,sui_coin,usdt_coin,usdc_coin) = dexconnector::mainSwapTokens<TELEBTC>(
            config,
            pool_usdc_sui,
            pool_usdc_usdt,
            pool_usdc_wbtc,
            pool_telebtc_wbtc,
            input_amount,
            min_output_amount,
            telebtc_coins,
            wbtc_coin,
            sui_coin,
            usdt_coin,
            usdc_coin,
            clock,
            ctx
        );
        // The return value from mainswap token should contain only teleBTC, with other tokens being zero
        assert!(status, ESWAP_FAILED);
        assert!(coin::value(&wbtc_coin) == 0, EINVALID_SWAP_RETURN_AMOUNT);
        assert!(coin::value(&sui_coin) == 0, EINVALID_SWAP_RETURN_AMOUNT);
        assert!(coin::value(&usdt_coin) == 0, EINVALID_SWAP_RETURN_AMOUNT);
        assert!(coin::value(&usdc_coin) == 0, EINVALID_SWAP_RETURN_AMOUNT);
        // destroy the zero-amount coins
        coin::destroy_zero(wbtc_coin);
        coin::destroy_zero(sui_coin);
        coin::destroy_zero(usdt_coin);
        coin::destroy_zero(usdc_coin);
        // return the teleBTC coin
        telebtc_coin
    }

} 