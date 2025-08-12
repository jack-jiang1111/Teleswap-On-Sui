#[allow(unused_use,unused_variable,unused_const,unused_mut_parameter,unused_field)]
module teleswap::burn_router_locker_connector {
    use sui::table::{Self, Table};
    use teleswap::burn_router_storage::{Self, BurnRouter, BurnRequest, BURN_ROUTER_ADMIN};
    use teleswap::burn_router_helper::{Self};
    use btcrelay::bitcoin_helper::{Self};    
    use btcrelay::btcrelay::{Self,BTCRelay};
    use teleswap::telebtc::{Self, TeleBTCCap, TELEBTC};
    use sui::coin::{Self, Coin, TreasuryCap};
    use teleswap::lockerstorage::{Self, LockerCap, Locker, LockerAdminCap};
    use teleswap::price_oracle::{Self};
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
    const ELOW_FEE: u64 = 212;
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
    const EINVALID_SCRIPT: u64 = 228;
    const EUNSORTED_VOUT_INDEXES: u64 = 229;
    const EINVALID_BURN_PROOF: u64 = 230;
    const EINVALID_LOCKER: u64 = 231;
    const EALREADY_INITIALIZED: u64 = 232;
    const EINVALID_BTCRELAY: u64 = 233;
    const ERROR_ZERO_VALUE: u64 = 1;
    const ERROR_INSUFFICIENT_FUNDS: u64 = 2;
    const ERROR_BURN_FAILED: u64 = 13;
    const ERROR_IS_PAUSED: u64 = 234;

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

    // ===== CONNECTOR FUNCTIONS =====

    /// @notice Unwraps TeleBTC for cross-chain withdrawal (connector function)
    /// @param burn_router The BurnRouter object
    /// @param amount_coin The TeleBTC coins to unwrap
    /// @param user_script The user's Bitcoin script hash
    /// @param script_type The user's script type
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param third_party The third party id
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The TeleBTC treasury capability
    /// @param btcrelay The BTCRelay object
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return The amount of BTC the user will receive
    public(package) fun unwrap(
        burn_router: &mut BurnRouter,
        amount_coin: Coin<TELEBTC>,
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
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Validate that the provided BTCRelay is the legitimate one
        assert!(
            burn_router_storage::validate_btcrelay(burn_router, btcrelay),
            EINVALID_BTCRELAY
        );

        // Extract amount from coin
        let amount = coin::value(&amount_coin);
        let locker_target_address = lockerstorage::get_locker_target_address(locker_locking_script, locker_cap);

        
        // Check validity of user script
        burn_router_helper::check_script_type_and_locker(
            user_script,
            script_type,
            locker_locking_script,
            locker_cap
        );

        let (remaining_amount, protocol_fee, third_party_fee, locker_fee) = burn_and_distribute_fees(
            burn_router,
            amount_coin,
            locker_locking_script,
            third_party,
            telebtc_cap,
            treasury_cap,
            ctx,
            locker_cap
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
            tx_context::sender(ctx),
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
            sender: tx_context::sender(ctx),
            request_id,
            deadline: btcrelay::lastSubmittedHeight(btcrelay) + burn_router_storage::get_transfer_deadline(burn_router),
            third_party,
            amounts,
            fees,
        });
        
        // Return the remaining amount
        remaining_amount
    }

    /// @notice Burns TeleBTC by a locker (connector function)
    /// @param _locker_locking_script The locker's locking script
    /// @param coins The TeleBTC coins to burn
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The TeleBTC treasury capability
    /// @param ctx Transaction context
    /// @param locker_cap The locker capability object
    public(package) fun burn(
        _locker_locking_script: vector<u8>,
        coins: Coin<TELEBTC>,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext,
        locker_cap: &mut LockerCap
    ) {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Get locker target address from locking script
        let _locker_target_address = lockerstorage::get_locker_target_address_from_script(_locker_locking_script, locker_cap);
        
        // Get locker from mapping
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Get the amount from the coins
        let _amount = coin::value(&coins);
        
        // Check if locker has sufficient net minted
        let net_minted = lockerstorage::get_net_minted(the_locker);
        assert!(net_minted >= _amount, ERROR_INSUFFICIENT_FUNDS);
        
        // Update net minted amount
        lockerstorage::set_net_minted(the_locker, net_minted - _amount);
        
        // Burn TeleBTC using the telebtc module
        let burn_success = telebtc::burn(telebtc_cap, treasury_cap, coins, ctx);
        assert!(burn_success, ERROR_BURN_FAILED);
        
        // Emit burn event
        lockerstorage::emit_burn_by_locker_event(
            _locker_target_address,
            _amount,
            0, // No fee for now
            tx_context::epoch(ctx),
        );
    }

    /// @notice Slashes idle locker (connector function)
    /// @param _locker_target_address Locker's target chain address
    /// @param _reward_amount Amount of TeleBTC that slasher receives
    /// @param _slasher Address of slasher who receives reward
    /// @param _amount Amount of TeleBTC that is slashed from Locker
    /// @param _recipient Address of user who receives the slashed collateral
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return True if the locker is slashed successfully
    public(package) fun slash_idle_locker(
        _locker_target_address: address,
        _reward_amount: u64,
        _slasher: address,
        _amount: u64,
        _recipient: address,
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ): bool {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Get values from locker_cap before getting mutable reference
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, _locker_target_address);
        let collateral_decimal = lockerstorage::get_collateral_decimal(locker_cap, collateral_token);
        
        // Get the locker from mapping for calculations
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Calculate equivalent amounts using price oracle
        let equivalent_collateral_token = price_oracle::equivalent_output_amount(
            _reward_amount + _amount, // Total amount of TeleBTC that is slashed
            8, // Decimal of teleBTC
            collateral_decimal, // Decimal of locked collateral
            @0x0, // teleBTC address (placeholder)
            collateral_token // Output token
        );
        
        // Get current collateral amount
        let current_collateral = lockerstorage::get_collateral_token_locked_amount(the_locker);
        
        // Cap at locker's collateral if it exceeds
        let final_equivalent_collateral_token = if (equivalent_collateral_token > current_collateral) {
            current_collateral
        } else {
            equivalent_collateral_token
        };
        
        // Update locker's bond (in collateral token)
        lockerstorage::set_collateral_token_locked_amount(the_locker, current_collateral - final_equivalent_collateral_token);
        
        // Calculate reward amount in collateral token
        let reward_amount_in_collateral_token = final_equivalent_collateral_token - 
            ((final_equivalent_collateral_token * _amount) / (_amount + _reward_amount));
        
        // Calculate recipient amount
        let recipient_amount = final_equivalent_collateral_token - reward_amount_in_collateral_token;
        
        // Check if contract has sufficient collateral balance
        let locker_collateral_token_balance = lockerstorage::get_locker_collateral_token_balance(locker_cap, _locker_target_address);
        assert!(locker_collateral_token_balance >= final_equivalent_collateral_token, ERROR_INSUFFICIENT_FUNDS);
        
        // Handle token transfers based on token type
        if (collateral_token == @0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b) { // WBTC address
            // Transfer WBTC to slasher
            let slasher_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, reward_amount_in_collateral_token, ctx);
            transfer::public_transfer(slasher_coins, _slasher);
            
            // Transfer WBTC to recipient
            let recipient_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, recipient_amount, ctx);
            transfer::public_transfer(recipient_coins, _recipient);
        } else {
            // For other tokens (treat as ERC20 equivalent)
            // TODO: Implement generic token transfer logic
            // For now, just assert that we have sufficient balance
            assert!(false, ERROR_INSUFFICIENT_FUNDS);
        };
        
        // Emit slashing event (matching Solidity event structure)
        lockerstorage::emit_locker_slashed_event(
            _locker_target_address,
            collateral_token,
            reward_amount_in_collateral_token,
            _slasher,
            _amount,
            _recipient,
            final_equivalent_collateral_token,
            tx_context::epoch(ctx),
            true,
        );
        
        true
    }

    /// @notice Slashes thief locker (connector function)
    /// @param _locker_target_address Locker's target chain address
    /// @param _reward_amount Amount of TeleBTC that slasher receives
    /// @param _slasher Address of slasher who receives reward
    /// @param _amount Amount of TeleBTC that is slashed from Locker
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return True if the locker is slashed successfully
    public(package) fun slash_thief_locker(
        _locker_target_address: address,
        _reward_amount: u64,
        _slasher: address,
        _amount: u64,
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ): bool {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Get values from locker_cap before getting mutable reference
        let reliability_factor = lockerstorage::get_reliability_factor(locker_cap, _locker_target_address);
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, _locker_target_address);
        let collateral_decimal = lockerstorage::get_collateral_decimal(locker_cap, collateral_token);
        let liquidation_ratio = lockerstorage::get_liquidation_ratio(locker_cap);
        let lib_constants = lockerstorage::get_lib_constants(locker_cap);
        let one_hundred_percent = lockerstorage::get_one_hundred_percent(lib_constants);
        
        // Get the locker from mapping for calculations
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Calculate equivalent collateral token using price oracle
        let equivalent_collateral_token = price_oracle::equivalent_output_amount(
            _amount, // Total amount of TeleBTC that is slashed
            8, // Decimal of TeleBTC
            collateral_decimal, // Decimal of locked collateral
            @0x0, // teleBTC address (placeholder)
            collateral_token // Output token
        );
        
        // Calculate reward in collateral token
        let reward_in_collateral_token = (equivalent_collateral_token * _reward_amount) / _amount;
        
        // Calculate needed collateral token for slash
        let needed_collateral_token_for_slash = (equivalent_collateral_token * liquidation_ratio * reliability_factor) / 
            (one_hundred_percent * one_hundred_percent);
        
        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(the_locker), ENOT_LOCKER);

        // Get current values
        let current_collateral = lockerstorage::get_collateral_token_locked_amount(the_locker);
        let current_net_minted = lockerstorage::get_net_minted(the_locker);
        let current_slashing_telebtc = lockerstorage::get_slashing_telebtc_amount(the_locker);
        let current_reserved_collateral = lockerstorage::get_reserved_collateral_token_for_slash(the_locker);
        
        // Check if total exceeds locker's collateral
        let (final_reward, final_needed) = if ((reward_in_collateral_token + needed_collateral_token_for_slash) > current_collateral) {
            // Divide total locker's collateral proportional to reward amount and slash amount
            let proportional_reward = (reward_in_collateral_token * current_collateral) / 
                (reward_in_collateral_token + needed_collateral_token_for_slash);
            let proportional_needed = current_collateral - proportional_reward;
            (proportional_reward, proportional_needed)
        } else {
            (reward_in_collateral_token, needed_collateral_token_for_slash)
        };
        
        // Update locker's bond (in collateral token)
        lockerstorage::set_collateral_token_locked_amount(the_locker, current_collateral - (final_reward + final_needed));
        
        // Update net minted (cap at net minted if amount exceeds it)
        let amount_to_deduct = if (_amount > current_net_minted) {
            current_net_minted
        } else {
            _amount
        };
        lockerstorage::set_net_minted(the_locker, current_net_minted - amount_to_deduct);
        
        // Update slashing info
        lockerstorage::set_slashing_telebtc_amount(the_locker, current_slashing_telebtc + _amount);
        lockerstorage::set_reserved_collateral_token_for_slash(the_locker, current_reserved_collateral + final_needed);
        
        // Check if contract has sufficient collateral balance
        let locker_collateral_token_balance = lockerstorage::get_locker_collateral_token_balance(locker_cap, _locker_target_address);
        assert!(locker_collateral_token_balance >= final_reward, ERROR_INSUFFICIENT_FUNDS);
        
        // Handle token transfers based on token type
        if (collateral_token == @0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b) { // WBTC address
            // Transfer WBTC to slasher
            let slasher_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, final_reward, ctx);
            transfer::public_transfer(slasher_coins, _slasher);
        } else {
            // For other tokens (treat as ERC20 equivalent)
            // TODO: Implement generic token transfer logic
            // For now, just assert that we have sufficient balance
            assert!(false, ERROR_INSUFFICIENT_FUNDS);
        };
        
        // Emit slashing event (matching Solidity event structure)
        lockerstorage::emit_locker_slashed_event(
            _locker_target_address,
            collateral_token,
            final_reward,
            _slasher,
            _amount,
            @0x0, // Contract address for thief slashing
            final_needed + final_reward,
            tx_context::epoch(ctx),
            false,
        );
        
        true
    }

    // ===== HELPER FUNCTIONS =====

    /// @notice Burns and distributes fees (internal helper)
    fun burn_and_distribute_fees(
        burn_router: &mut BurnRouter,
        amount_coin: Coin<TELEBTC>,
        locker_locking_script: vector<u8>,
        third_party: u64,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext,
        locker_cap: &mut LockerCap
    ): (u64, u64, u64, u64) {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // For now, return simplified values
        // TODO: Implement actual fee calculation logic
        let amount = coin::value(&amount_coin);
        let remaining_amount = amount * 95 / 100; // 95% remaining
        let protocol_fee = amount * 3 / 100; // 3% protocol fee
        let third_party_fee = amount * 1 / 100; // 1% third party fee
        let locker_fee = amount * 1 / 100; // 1% locker fee
        
        // Burn the coins
        let burn_success = telebtc::burn(telebtc_cap, treasury_cap, amount_coin, ctx);
        assert!(burn_success, ERROR_BURN_FAILED);
        
        (remaining_amount, protocol_fee, third_party_fee, locker_fee)
    }
} 