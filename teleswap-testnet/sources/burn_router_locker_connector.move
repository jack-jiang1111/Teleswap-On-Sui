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
    const ELOW_FEE: u64 = 231;
    const EDEADLINE_NOT_PASSED: u64 = 232;
    const EINVALID_BTCRELAY: u64 = 233;
    const ERROR_IS_PAUSED: u64 = 234;
    const ERROR_INSUFFICIENT_FUNDS: u64 = 235;
    const ERROR_BURN_FAILED: u64 = 236;
    const ERROR_NOT_LOCKER: u64 = 237;

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

    public struct DEBUG_EVENT has copy, drop {
        num1: u256,
        num2: u256,
        num3: u256,
        num4: u256,
        num5: u256,
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
        let locker_target_address = lockerstorage::get_locker_target_address(locker_locking_script,locker_cap);

        
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
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ) {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Get locker target address from locking script
        let _locker_target_address = lockerstorage::get_locker_target_address_from_script(_locker_locking_script, locker_cap);
        
        // Get locker from mapping
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Get the amount from the coins
        let _amount = coin::value(&coins) as u256;
        
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
        

        // Get the locker from mapping for calculations
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);

        // Calculate equivalent amounts using price oracle
        let equivalent_collateral_token = price_oracle::equivalent_output_amount(
            (_reward_amount + _amount) as u256, // Total amount of TeleBTC that is slashed
            8, // Decimal of teleBTC
            8, // Decimal of locked collateral
            @0x0, // teleBTC address (placeholder)
            @0x0 // Output token
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
            ((final_equivalent_collateral_token * (_amount as u256)) / ((_amount as u256) + (_reward_amount as u256)));
        
        // Calculate recipient amount
        let recipient_amount = final_equivalent_collateral_token - reward_amount_in_collateral_token;
        
        // Check if contract has sufficient collateral balance
        let locker_collateral_token_balance_after_slash = lockerstorage::get_locker_collateral_token_balance(locker_cap, _locker_target_address);
        // this check is no longer needed since we will cap the amount of collateral to slash at the locker's collateral
        //assert!(locker_collateral_token_balance > final_equivalent_collateral_token, ERROR_INSUFFICIENT_FUNDS);
        
        // Transfer WBTC to slasher
        let slasher_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, reward_amount_in_collateral_token, ctx);
        transfer::public_transfer(slasher_coins, _slasher);
        
        // Transfer WBTC to recipient
        let recipient_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, recipient_amount, ctx);
        transfer::public_transfer(recipient_coins, _recipient);
        
        // Emit slashing event (matching Solidity event structure)
        lockerstorage::emit_locker_slashed_event(
            _locker_target_address,
            reward_amount_in_collateral_token,
            _slasher,
            _amount as u256,
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
        
        assert!(lockerstorage::is_locker_by_address(locker_cap, _locker_target_address),ERROR_NOT_LOCKER);
        
        // Get values from locker_cap before getting mutable reference
        let reliability_factor = lockerstorage::get_reliability_factor(locker_cap, _locker_target_address);
        let liquidation_ratio = lockerstorage::get_liquidation_ratio(locker_cap);
        let lib_constants = lockerstorage::get_lib_constants(locker_cap);
        let one_hundred_percent = lockerstorage::get_one_hundred_percent(lib_constants);
        
        // Get the locker from mapping for calculations
        let the_locker = lockerstorage::get_locker_from_mapping(locker_cap, _locker_target_address);
        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);

        // Calculate equivalent collateral token using price oracle
        let equivalent_collateral_token = price_oracle::equivalent_output_amount(
            _amount as u256, // Total amount of TeleBTC that is slashed
            8, // Decimal of TeleBTC
            8, // Decimal of locked collateral
            @0x0, // teleBTC address (placeholder)
            @0x0 // Output token
        );
        
        // Calculate reward in collateral token
        let reward_in_collateral_token = (equivalent_collateral_token * (_reward_amount as u256)) / (_amount as u256);
        
        // Calculate needed collateral token for slash
        let needed_collateral_token_for_slash = (equivalent_collateral_token * liquidation_ratio * reliability_factor) / 
            (one_hundred_percent * one_hundred_percent);

        // Get current values
        let current_collateral = lockerstorage::get_collateral_token_locked_amount(the_locker);
        let current_net_minted = lockerstorage::get_net_minted(the_locker);
        let current_slashing_telebtc = lockerstorage::get_slashing_telebtc_amount(the_locker);
        let current_reserved_collateral = lockerstorage::get_reserved_collateral_token_for_slash(the_locker);
        
        // Check if total exceeds locker's collateral
        let (final_reward, final_needed) = if ((reward_in_collateral_token + needed_collateral_token_for_slash) > current_collateral) {
            // Divide total locker's collateral proportional to reward amount and slash amount
            let proportional_reward = (reward_in_collateral_token * current_collateral as u256) / 
                (reward_in_collateral_token + needed_collateral_token_for_slash);
            let proportional_needed = current_collateral - proportional_reward;
            (proportional_reward, proportional_needed)
        } else {
            (reward_in_collateral_token, needed_collateral_token_for_slash)
        };
        
        // Check if contract has sufficient collateral balance
        let locker_collateral_token_balance = lockerstorage::get_locker_collateral_token_balance(locker_cap, _locker_target_address);
        assert!(locker_collateral_token_balance >= final_reward+final_needed, ERROR_INSUFFICIENT_FUNDS);

        // Update locker's bond (in collateral token)
        let the_mut_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        lockerstorage::set_collateral_token_locked_amount(the_mut_locker, current_collateral - (final_reward + final_needed));
        
        // Update net minted (cap at net minted if amount exceeds it)
        let amount_to_deduct = if ((_amount as u256) > current_net_minted) {
            current_net_minted
        } else {
            _amount as u256
        };
        
        lockerstorage::set_net_minted(the_mut_locker, current_net_minted - amount_to_deduct);
        
        // Update slashing info
        lockerstorage::set_slashing_telebtc_amount(the_mut_locker, current_slashing_telebtc + (_amount as u256));
        lockerstorage::set_reserved_collateral_token_for_slash(the_mut_locker, current_reserved_collateral + final_needed);
        
       
        // Transfer WBTC to slasher
        let slasher_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, final_reward, ctx);
        transfer::public_transfer(slasher_coins, _slasher);
       
        
        // Emit slashing event (matching Solidity event structure)
        lockerstorage::emit_locker_slashed_event(
            _locker_target_address,
            final_reward,
            _slasher,
            _amount as u256,
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
        // Calculate fees
        let amount = coin::value(&amount_coin);
        let protocol_fee = (amount * burn_router_storage::get_protocol_percentage_fee(burn_router)) / MAX_PERCENTAGE_FEE;
        let third_party_fee = (amount * burn_router_storage::get_third_party_fee(burn_router, third_party)) / MAX_PERCENTAGE_FEE;
        let locker_fee = (amount * burn_router_storage::get_locker_percentage_fee(burn_router)) / MAX_PERCENTAGE_FEE;
        let bitcoin_fee = burn_router_storage::get_bitcoin_fee(burn_router);
        let combined_locker_fee = locker_fee + bitcoin_fee;
        assert!(amount  > DUST_SATOSHI_AMOUNT + protocol_fee + third_party_fee + combined_locker_fee, ELOW_FEE); // handle negative number use this trick
        let remained_amount = amount - protocol_fee - third_party_fee - combined_locker_fee;
        
        let locker_target_address = lockerstorage::get_locker_target_address(locker_locking_script,locker_cap);

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

        // Burn remaining coins using locker burn function
        burn(locker_locking_script, coins, telebtc_cap, treasury_cap, locker_cap, ctx);

        // Return fee details
        (remained_amount, protocol_fee, third_party_fee, combined_locker_fee)
    }
} 