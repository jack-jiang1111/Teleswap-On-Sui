#[allow(unused_field, unused_variable, unused_const, unused_use)]
module teleswap::lockerhelper {

    // Import from storage
    use teleswap::lockerstorage::{Self, Locker, LockersLibConstants, LockerCap};
    use teleswap::price_oracle;
    
    // Import burn router and related modules
    use teleswap::burn_router_logic::{Self};
    use btcrelay::btcrelay::{Self, BTCRelay};
    use teleswap::burn_router_storage::{Self, BurnRouter};
    use teleswap::burn_router_locker_connector::{Self};
    
    // Import Sui modules
    use sui::coin::{Self, Coin, TreasuryCap};
    use teleswap::telebtc::{Self, TeleBTCCap, TELEBTC};


    // Error constants
    const ERROR_NOT_BURN_ROUTER: u64 = 1;
    const ERROR_ZERO_VALUE: u64 = 2;
    const ERROR_ZERO_ADDRESS: u64 = 3;
    const ERROR_NOT_LOCKER: u64 = 4;
    const ERROR_NOT_CANDIDATE: u64 = 5;
    const ERROR_ALREADY_LOCKER: u64 = 6;
    const ERROR_ALREADY_CANDIDATE: u64 = 7;
    const ERROR_INSUFFICIENT_FUNDS: u64 = 8;
    const ERROR_HEALTH_LOCKER: u64 = 9;
    const ERROR_MORE_THAN_MAX_REMOVABLE_COLLATERAL: u64 = 10;
    const ERROR_INVALID_VALUE: u64 = 11;
    const ERROR_ALREADY_IN_QUEUE: u64 = 12;
    const ERROR_BURN_FAILED: u64 = 13;
    // Helper functions from lockerlib.sol
    /// @notice Helper function to request to become a locker
    /// @dev This function handles the core logic for creating a locker candidate. Validates inputs and creates the locker object.
    /// @param locker_cap The locker capability object
    /// @param the_locker_target_address Target address for the locker
    /// @param collateral_token Collateral token address
    /// @param collateral_decimal Collateral token decimal places
    /// @param _locked_tst_amount Amount of TST locked
    /// @param _locked_collateral_token_amount Amount of collateral locked
    /// @param _candidate_locking_script Locker locking script
    /// @param _locker_script_type Type of locker script
    /// @param _locker_rescue_script Locker rescue script
    /// @param ctx Transaction context
    public(package) fun request_to_become_locker(
        locker_cap: &mut LockerCap,
        the_locker_target_address: address,
        collateral_token: address,
        collateral_decimal: u8,
        _locked_collateral_token_amount: u64,
        _candidate_locking_script: vector<u8>,
        _locker_script_type: u8,
        _locker_rescue_script: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Validate collateral decimal is not zero (whitelisted)
        assert!(collateral_decimal != 0, ERROR_ZERO_VALUE);
        
        // Validate target address is not zero (should be the sender's address)
        assert!(the_locker_target_address != @0x0, ERROR_ZERO_ADDRESS);
        
        // Check if the address is already a candidate or locker
        if (lockerstorage::locker_exists(locker_cap, the_locker_target_address)) {
            let existing_locker = lockerstorage::get_locker_from_mapping(locker_cap, the_locker_target_address);
            
            // Check if already a candidate
            assert!(!lockerstorage::is_locker_candidate(existing_locker), ERROR_ALREADY_CANDIDATE);
            
            // Check if already a locker
            assert!(!lockerstorage::is_locker_struct_active(existing_locker), ERROR_ALREADY_LOCKER);

            abort(ERROR_ALREADY_IN_QUEUE)// This should never happen
        };
        
        // Create new locker candidate using storage function
        let new_locker = lockerstorage::create_locker(
            _candidate_locking_script,
            _locker_script_type,
            _locker_rescue_script,
            _locked_collateral_token_amount,
            ctx
        );
        
        // Add to lockers mapping table
        lockerstorage::add_locker_to_mapping(locker_cap, the_locker_target_address, new_locker);
        
        // Update total number of candidates
        lockerstorage::increment_total_candidates(locker_cap);
    }

    /// @notice Buys slashed collateral of a locker
    /// @param the_locker Reference to the locker
    /// @param _collateral_amount Amount of collateral to buy
    /// @return Amount of TeleBTC needed
    public(package) fun buy_slashed_collateral_of_locker(
        _the_locker: &mut Locker,
        _collateral_amount: u64
    ): u64 {
        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(_the_locker), ERROR_NOT_LOCKER);
        
        // Get current values using storage functions
        let slashing_telebtc_amount = lockerstorage::get_slashing_telebtc_amount(_the_locker);
        let reserved_collateral = lockerstorage::get_reserved_collateral_token_for_slash(_the_locker);
        
        // Validate enough slashed collateral to buy
        assert!(_collateral_amount <= reserved_collateral, ERROR_INSUFFICIENT_FUNDS);
        
        // Calculate needed TeleBTC
        let needed_telebtc = (slashing_telebtc_amount * _collateral_amount) / reserved_collateral;
        
        // Add 1 to avoid precision loss
        let final_needed_telebtc = if (needed_telebtc < slashing_telebtc_amount) {
            needed_telebtc + 1
        } else {
            needed_telebtc
        };
        
        // Update locker's slashing info using storage functions
        lockerstorage::set_slashing_telebtc_amount(_the_locker, slashing_telebtc_amount - final_needed_telebtc);
        lockerstorage::set_reserved_collateral_token_for_slash(_the_locker, reserved_collateral - _collateral_amount);
        
        final_needed_telebtc
    }

    /// @notice Liquidates a locker
    /// @param the_locker Reference to the locker
    /// @param locker_cap The locker capability object
    /// @param _collateral_token Collateral token address
    /// @param _collateral_decimal Collateral decimal places
    /// @param _collateral_amount Amount of collateral
    /// @param _reliability_factor Reliability factor
    /// @return Amount of TeleBTC received
    public(package) fun liquidate_locker(
        locker_target_address: address,
        locker_cap: &mut LockerCap,
        _collateral_token: address,
        _collateral_decimal: u8,
        _collateral_amount: u64,
        _reliability_factor: u64
    ): u64 {
        // Get price of one unit of collateral in BTC
        let price_of_collateral = lockerstorage::price_of_one_unit_of_collateral_in_btc(
            _collateral_token,
            _collateral_decimal,
            locker_cap
        );
        
        // Check that the collateral has become unhealthy
        let health_factor = lockerstorage::calculate_health_factor(
            locker_target_address,
            locker_cap,
            _collateral_token,
            _collateral_decimal,
            _reliability_factor
        );
        assert!(health_factor < lockerstorage::get_health_factor(lockerstorage::get_lib_constants(locker_cap)), ERROR_HEALTH_LOCKER);
        
        // Calculate maximum buyable collateral
        let max_buyable_collateral = lockerstorage::maximum_buyable_collateral(
            locker_target_address,
            locker_cap,
            price_of_collateral,
            _collateral_decimal,
            _reliability_factor
        );
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, locker_target_address);

        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);
        // If max buyable collateral is greater than locked amount, cap it
        let final_max_buyable = if (max_buyable_collateral > lockerstorage::get_collateral_token_locked_amount(the_locker)) {
            lockerstorage::get_collateral_token_locked_amount(the_locker)
        } else {
            max_buyable_collateral
        };
        
        // Validate collateral amount is within limits
        assert!(_collateral_amount <= final_max_buyable, ERROR_INSUFFICIENT_FUNDS);
        
        // Calculate needed TeleBTC to buy collateral
        let needed_telebtc = lockerstorage::needed_telebtc_to_buy_collateral(
            locker_cap,
            _collateral_amount,
            _collateral_decimal,
            price_of_collateral
        );
        
        // Add 1 to prevent precision loss
        needed_telebtc + 1
    }

    public(package) fun slash_thief_locker(
        locker_target_address: address,
        locker_cap: &mut LockerCap,
        _reliability_factor: u64,
        _collateral_token: address,
        _collateral_decimal: u8,
        _reward_amount: u64,
        _amount: u64
    ): (u64, u64) {
        
        
        // Calculate equivalent collateral token using price oracle
        let equivalent_collateral_token = price_oracle::equivalent_output_amount(
            _amount, // Total amount of TeleBTC that is slashed
            8, // Decimal of teleBTC
            _collateral_decimal, // Decimal of locked collateral
            @0x0, // teleBTC address (placeholder)
            _collateral_token // Output token
        );
        
        // Calculate reward in collateral token
        let reward_in_collateral_token = (equivalent_collateral_token * _reward_amount) / _amount;
        
        // Calculate needed collateral token for slash
        let needed_collateral_token_for_slash = (equivalent_collateral_token * lockerstorage::get_liquidation_ratio(locker_cap) * _reliability_factor) / 
            (lockerstorage::get_one_hundred_percent(lockerstorage::get_lib_constants(locker_cap)) * lockerstorage::get_one_hundred_percent(lockerstorage::get_lib_constants(locker_cap)));
        
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, locker_target_address);
        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);

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
        
        (final_reward, final_needed)
    }

    public(package) fun slash_idle_locker(
        locker_target_address: address,
        locker_cap: &mut LockerCap,
        _collateral_token: address,
        _collateral_decimal: u8,
        _reward_amount: u64,
        _amount: u64
    ): (u64, u64) {
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, locker_target_address);

        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);
        
        // Calculate equivalent collateral token using price oracle
        let equivalent_collateral_token = price_oracle::equivalent_output_amount(
            _reward_amount + _amount, // Total amount of TeleBTC that is slashed
            8, // Decimal of teleBTC
            _collateral_decimal, // Decimal of locked collateral
            @0x0, // teleBTC address (placeholder)
            _collateral_token // Output token
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
        
        (final_equivalent_collateral_token, reward_amount_in_collateral_token)
    }
    
    public(package) fun mint_helper(
        locker_cap: &mut LockerCap,
        _locker_target_address: address,
        amount: u64
    ) {
        // Get all necessary data from locker_cap
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, _locker_target_address);
        let collateral_decimal = lockerstorage::get_collateral_decimal(locker_cap, collateral_token);
        let reliability_factor = lockerstorage::get_reliability_factor(locker_cap, _locker_target_address);
        
        // Get locker from mapping for capacity check
        let the_locker_ref = lockerstorage::get_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Calculate locker capacity
        let the_locker_capacity = lockerstorage::get_locker_capacity(
            the_locker_ref,
            locker_cap,
            _locker_target_address,
            collateral_token,
            collateral_decimal,
            reliability_factor
        );
        
        // Validate capacity is sufficient
        assert!(the_locker_capacity >= amount, ERROR_INSUFFICIENT_FUNDS);
        
        // Get locker from mapping for updates
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Get current net minted amount
        let current_net_minted = lockerstorage::get_net_minted(the_locker);
        
        // Update net minted amount
        lockerstorage::set_net_minted(the_locker, current_net_minted + amount);
    }

} 