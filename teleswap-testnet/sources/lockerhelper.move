#[allow(unused_field, unused_variable, unused_use)]
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
    const ERROR_ZERO_ADDRESS: u64 = 521;
    const ERROR_NOT_LOCKER: u64 = 522;
    const ERROR_ALREADY_LOCKER: u64 = 523;
    const ERROR_ALREADY_CANDIDATE: u64 = 524;
    const ERROR_INSUFFICIENT_FUNDS: u64 = 525;
    const ERROR_HEALTH_LOCKER: u64 = 526;
    const ERROR_ALREADY_IN_QUEUE: u64 = 527;
    const ERROR_INSUFFICIENT_COLLATERAL_FOR_SLASH: u64 = 528;
    const ERROR_INSUFFICIENT_CAPACITY: u64 = 529;
    // Helper functions from lockerlib.sol
    /// @notice Helper function to request to become a locker
    /// @dev This function handles the core logic for creating a locker candidate. Validates inputs and creates the locker object.
    /// @param locker_cap The locker capability object
    /// @param the_locker_target_address Target address for the locker
    /// @param _locked_tst_amount Amount of TST locked
    /// @param _locked_collateral_token_amount Amount of collateral locked
    /// @param _candidate_locking_script Locker locking script
    /// @param _locker_script_type Type of locker script
    /// @param _locker_rescue_script Locker rescue script
    /// @param ctx Transaction context
    public(package) fun request_to_become_locker(
        locker_cap: &mut LockerCap,
        the_locker_target_address: address,
        _locked_collateral_token_amount: u256,
        _candidate_locking_script: vector<u8>,
        _locker_script_type: u8,
        _locker_rescue_script: vector<u8>,
        ctx: &mut TxContext
    ) {
        
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
        _collateral_amount: u256
    ): u256 {
        // Validate locker is active
        assert!(lockerstorage::is_locker_struct_active(_the_locker), ERROR_NOT_LOCKER);
        
        // Get current values using storage functions
        let slashing_telebtc_amount = lockerstorage::get_slashing_telebtc_amount(_the_locker);
        let reserved_collateral = lockerstorage::get_reserved_collateral_token_for_slash(_the_locker);
        
        // Validate enough slashed collateral to buy
        assert!(_collateral_amount <= reserved_collateral, ERROR_INSUFFICIENT_COLLATERAL_FOR_SLASH);
        
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
    /// @param _collateral_amount Amount of collateral
    /// @param _reliability_factor Reliability factor
    /// @return Amount of TeleBTC received
    public(package) fun liquidate_locker(
        locker_target_address: address,
        locker_cap: &mut LockerCap,
        _collateral_amount: u256,
        _reliability_factor: u256
    ): u256 {
        // Get price of one unit of collateral in BTC
        let price_of_collateral = lockerstorage::price_of_one_unit_of_collateral_in_btc(
            locker_cap
        );
        
        // Check that the collateral has become unhealthy
        let health_factor = lockerstorage::calculate_health_factor(
            locker_target_address,
            locker_cap,
            _reliability_factor
        );
        assert!(health_factor < lockerstorage::get_health_factor(lockerstorage::get_lib_constants(locker_cap)), ERROR_HEALTH_LOCKER);
        
        // Calculate maximum buyable collateral
        let max_buyable_collateral = lockerstorage::maximum_buyable_collateral(
            locker_target_address,
            locker_cap,
            price_of_collateral,
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
            price_of_collateral
        );
        
        // Add 1 to prevent precision loss
        needed_telebtc + 1
    }
    
    public(package) fun mint_helper(
        locker_cap: &mut LockerCap,
        _locker_target_address: address,
        amount: u256
    ) {
        // Get all necessary data from locker_cap
        let reliability_factor = lockerstorage::get_reliability_factor(locker_cap, _locker_target_address);
        
        // Get locker from mapping for capacity check
        let the_locker_ref = lockerstorage::get_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Calculate locker capacity
        let the_locker_capacity = lockerstorage::get_locker_capacity(
            locker_cap,
            _locker_target_address,
        );
        
        // Validate capacity is sufficient
        assert!(the_locker_capacity >= amount, ERROR_INSUFFICIENT_CAPACITY);
        
        // Get locker from mapping for updates
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Get current net minted amount
        let current_net_minted = lockerstorage::get_net_minted(the_locker);
        
        // Update net minted amount
        lockerstorage::set_net_minted(the_locker, current_net_minted + amount);
    }

} 