#[allow(unused_field,lint(self_transfer))]
module teleswap::lockermanager {

    // Import from storage and helper
    use teleswap::lockerstorage::{Self, LockerCap, LockerAdminCap};
    use teleswap::lockerhelper::{Self};
    use teleswap::telebtc::{Self, TELEBTC, TeleBTCCap};
    use sui::coin::{Self, Coin, TreasuryCap};
    use teleswap::wbtc::WBTC;

    // Error constants
    const ERROR_ZERO_ADDRESS: u64 = 510;
    const ERROR_ZERO_VALUE: u64 = 511;
    const ERROR_NOT_LOCKER: u64 = 512;
    const ERROR_LOCKER_ACTIVE: u64 = 513;
    const ERROR_INVALID_VALUE: u64 = 514;
    const ERROR_NOT_REQUESTED: u64 = 515;
    const ERROR_BURN_FAILED: u64 = 516;
    const ERROR_INSUFFICIENT_FUNDS: u64 = 517;
    const ERROR_ALREADY_REQUESTED: u64 = 518;
    const ERROR_MORE_THAN_MAX_REMOVABLE_COLLATERAL: u64 = 519;

    const WBTC_ADDRESS: address = @wbtc;
    /// @notice Submit request to become Locker
    /// @dev This request may be approved by the owner. Users provide WBTC collateral and locking script.
    /// @param locker_cap The locker capability object
    /// @param _locker_locking_script Locking script of the Locker. Users can use this script to lock BTC.
    /// @param wbtc_coins WBTC coins to add as collateral bond
    /// @param _locker_script_type Type of Locker's script (e.g. P2SH)
    /// @param _locker_rescue_script Rescue script of Locker. In the case of liquidation, BTC is sent to this script.
    /// @param ctx Transaction context
    /// @return True if candidate added successfully
    public fun request_to_become_locker(
        locker_cap: &mut LockerCap,
        _locker_locking_script: vector<u8>,
        wbtc_coins: Coin<WBTC>,
        _locker_script_type: u8,
        _locker_rescue_script: vector<u8>,
        ctx: &mut TxContext
    ): bool {
        let sender = tx_context::sender(ctx);
        let wbtc_amount = coin::value(&wbtc_coins);
        assert!(wbtc_amount != 0, ERROR_ZERO_VALUE);
        
        // Call the helper function to handle the locker creation logic
        lockerhelper::request_to_become_locker(
            locker_cap,
            sender,
            WBTC_ADDRESS, // WBTC address
            8, // WBTC decimal places
            wbtc_amount,
            _locker_locking_script,
            _locker_script_type,
            _locker_rescue_script,
            ctx
        );

        // Set collateral token to WBTC for the sender
        lockerstorage::set_locker_collateral_token(locker_cap, sender, WBTC_ADDRESS);
        
        // Add WBTC coins to the vault
        lockerstorage::add_wbtc_collateral_to_contract(locker_cap, wbtc_coins);

        // Emit request to become locker event
        lockerstorage::emit_request_add_locker_event(
            sender,
            _locker_locking_script,
            WBTC_ADDRESS,
            wbtc_amount,
        );
        
        true
    }

    /// @notice Revoke request to become Locker
    /// @dev Send back WBTC collateral to the candidate. Only the candidate can revoke their own request.
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return True if the candidate is removed successfully
    public fun revoke_request(
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ): bool {
        let sender = tx_context::sender(ctx);
        
        // Check if sender has requested to become a locker
        let locker_request = lockerstorage::get_locker_from_mapping(locker_cap, sender);
        assert!(lockerstorage::is_locker_candidate(locker_request), ERROR_NOT_REQUESTED);
        
        // Get locker information before removing
        let locker_locking_script = lockerstorage::get_locker_locking_script(locker_request);
        let collateral_amount = lockerstorage::get_collateral_token_locked_amount(locker_request);
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, sender);
        
        // Remove candidate from lockers mapping and get the removed locker
        let removed_locker = lockerstorage::remove_locker_from_mapping(locker_cap, sender);
        
        // Decrement total number of candidates
        lockerstorage::decrement_total_candidates(locker_cap);
        
        // Return collateral to sender
        if (collateral_token == WBTC_ADDRESS) {
            let wbtc_coins = lockerstorage::remove_wbtc_collateral_from_contract(
                locker_cap,
                collateral_amount,
                ctx
            );
            transfer::public_transfer(wbtc_coins, sender);
        };
        
        // Clean up collateral token mapping
        lockerstorage::remove_locker_collateral_token(locker_cap, sender);
        
        // Destroy the removed locker (it has key ability, so we need to delete it)
        lockerstorage::delete_locker(removed_locker);
        
        // Emit revoke add locker request event
        lockerstorage::emit_revoke_add_locker_request_event(
            sender,
            locker_locking_script,
            collateral_token,
            collateral_amount,
        );

        true
    }

    /// @notice Approve the candidate request to become Locker
    /// @dev Only owner can call this. The isCandidate is also set to false. Converts candidate to active locker.
    /// @param locker_cap The locker capability object
    /// @param _locker_target_address Locker's target chain address
    /// @param _locker_reliability_factor Reliability factor for the locker
    /// @param ctx Transaction context
    /// @return True if the candidate is added successfully
    public fun add_locker(
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        _locker_target_address: address,
        _locker_reliability_factor: u64,
        ctx: &mut TxContext
    ): bool {
        // Check admin permissions
        lockerstorage::assert_admin(admin_cap, locker_cap, ctx);
        
        // Check if locker target address is not zero
        assert!(_locker_target_address != @0x0, ERROR_ZERO_ADDRESS);
        
        // Check if reliability factor is not zero
        assert!(_locker_reliability_factor != 0, ERROR_ZERO_VALUE);
        
        // Check if the address has requested to become a locker
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        assert!(lockerstorage::is_locker_candidate(the_locker), ERROR_NOT_REQUESTED);
        
        // Update locker status
        lockerstorage::set_locker_candidate_status(the_locker, false);
        lockerstorage::set_locker_status(the_locker, true);
        
        // Get information from the_locker before releasing the borrow
        let locker_locking_script = lockerstorage::get_locker_locking_script(the_locker);
        let collateral_amount = lockerstorage::get_collateral_token_locked_amount(the_locker);
        
        // Now we can use locker_cap again since we've extracted what we need from the_locker
        // Update number of candidates and lockers
        lockerstorage::decrement_total_candidates(locker_cap);
        lockerstorage::increment_total_lockers(locker_cap);
        
        // Set up target address mapping
        lockerstorage::set_locker_target_address_mapping(locker_cap, locker_locking_script, _locker_target_address);
        
        // Set reliability factor
        lockerstorage::set_locker_reliability_factor(
            admin_cap,
            locker_cap,
            _locker_target_address,
            _locker_reliability_factor,
            ctx
        );
        
        // Get collateral information for event
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, _locker_target_address);
        
        // Emit locker added event
        lockerstorage::emit_locker_added_event(
            _locker_target_address,
            locker_locking_script,
            collateral_token,
            collateral_amount,
            _locker_reliability_factor,
            tx_context::epoch(ctx),
        );
        
        true
    }

    /// @notice Request to inactivate Locker
    /// @dev This would inactivate Locker after INACTIVATION_DELAY. The impact of inactivation is:
    ///      1. No one can mint TeleBTC by the Locker
    ///      2. Locker can be removed
    ///      3. Locker can withdraw unused collateral
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return True if deactivated successfully
    public fun request_inactivation(
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ): bool {
        let sender = tx_context::sender(ctx);
        
        // Check if sender is a locker
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, sender);
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);
        
        // Get information from the_locker before releasing the borrow
        let locker_locking_script = lockerstorage::get_locker_locking_script(the_locker);
        let collateral_amount = lockerstorage::get_collateral_token_locked_amount(the_locker);
        let net_minted = lockerstorage::get_locker_net_minted(the_locker);
        
        // Now we can use locker_cap again since we've extracted what we need from the_locker
        // Check if inactivation is not already requested
        let current_inactivation_timestamp = lockerstorage::get_locker_inactivation_timestamp(locker_cap, sender);
        assert!(current_inactivation_timestamp == 0, ERROR_ALREADY_REQUESTED);
        
        // Set the inactivation timestamp (current epoch + INACTIVATION_DELAY)
        let current_epoch = tx_context::epoch(ctx);
        let inactivation_timestamp = current_epoch + lockerstorage::get_inactivation_delay(locker_cap);
        lockerstorage::set_locker_inactivation_timestamp(locker_cap, sender, inactivation_timestamp);
        
        // Get collateral token for event
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, sender);
        
        // Emit request inactivate locker event
        lockerstorage::emit_request_inactivate_locker_event(
            sender,
            inactivation_timestamp,
            locker_locking_script,
            collateral_token,
            collateral_amount,
            net_minted,
        );
        
        true
    }

    /// @notice Activate Locker
    /// @dev Users can only mint TeleBTC by active locker
    ///      Note: lockerInactivationTimestamp = 0 means that the Locker is active
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return True if activated successfully
    public fun request_activation(
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ): bool {
        let sender = tx_context::sender(ctx);
        
        // Check if sender is a locker
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, sender);
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);
        
        // Get information from the_locker before releasing the borrow
        let locker_locking_script = lockerstorage::get_locker_locking_script(the_locker);
        let collateral_amount = lockerstorage::get_collateral_token_locked_amount(the_locker);
        let net_minted = lockerstorage::get_locker_net_minted(the_locker);
        
        // Clear the inactivation timestamp (set to 0)
        lockerstorage::set_locker_inactivation_timestamp(locker_cap, sender, 0);
        
        // Get collateral token for event
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, sender);
        
        // Emit activate locker event
        lockerstorage::emit_activate_locker_event(
            sender,
            locker_locking_script,
            collateral_token,
            collateral_amount,
            net_minted,
        );
        
        true
    }

    /// @notice Removes Locker from system and send back Locker TST and collateral.
    /// @dev Only Locker can call this. The conditions for successful remove is:
    ///      1. Locker has been inactivated
    ///      2. Locker sends net minted TeleBTC to the contract
    ///      3. Locker is not being slashed
    /// @param locker_cap The locker capability object
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The TeleBTC treasury capability
    /// @param telebtc_coins TeleBTC coins to burn
    /// @param ctx Transaction context
    /// @return True if locker is removed successfully
    public fun self_remove_locker(
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        telebtc_coins: Coin<TELEBTC>,
        ctx: &mut TxContext
    ): bool {
        let sender = tx_context::sender(ctx);
        
        // Get the removing locker
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, sender);
        
        // Check if sender is a locker
        assert!(lockerstorage::is_locker_struct_active(the_locker), ERROR_NOT_LOCKER);
        
        // Get information from the_locker before releasing the borrow
        let locker_locking_script = lockerstorage::get_locker_locking_script(the_locker);
        let net_minted = lockerstorage::get_locker_net_minted(the_locker);
        let slashing_telebtc_amount = lockerstorage::get_locker_slashing_telebtc_amount(the_locker);
        let collateral_amount = lockerstorage::get_collateral_token_locked_amount(the_locker);
        let reserved_collateral_for_slash = lockerstorage::get_locker_reserved_collateral_for_slash(the_locker);
        
        // Now we can use locker_cap again since we've extracted what we need from the_locker
        // Check if locker is not active (must be inactivated first)
        assert!(!lockerstorage::is_locker_active(locker_cap, sender, ctx), ERROR_LOCKER_ACTIVE);
        
        // Check that provided TeleBTC coins match net minted amount
        let provided_telebtc = coin::value(&telebtc_coins);
        assert!(provided_telebtc == net_minted, ERROR_INSUFFICIENT_FUNDS);
        
        // Burn the TeleBTC coins
        let burn_success = telebtc::burn(telebtc_cap, treasury_cap, telebtc_coins, ctx);
        assert!(burn_success, ERROR_BURN_FAILED);
        
        // Check that slashing amount is 0
        assert!(slashing_telebtc_amount == 0, ERROR_INVALID_VALUE);
        
        // Remove locker from mappings
        let removed_locker = lockerstorage::remove_locker_from_mapping(locker_cap, sender);
        
        // Decrement total lockers
        lockerstorage::decrement_total_lockers(locker_cap);
        
        // Get collateral token for return
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, sender);
        
        // Return collateral to sender
        if (collateral_token == WBTC_ADDRESS) {
            let total_collateral = collateral_amount + reserved_collateral_for_slash;
            let wbtc_coins = lockerstorage::remove_wbtc_collateral_from_contract(
                locker_cap,
                total_collateral,
                ctx
            );
            transfer::public_transfer(wbtc_coins, sender);
        };
        

        // Emit locker removed event
        lockerstorage::emit_locker_removed_event(
            sender,
            locker_locking_script,
            collateral_token,
            collateral_amount,
        );
        
        // Clean up collateral token mapping
        lockerstorage::remove_locker_collateral_token(locker_cap, sender);
        
        // Destroy the removed locker
        lockerstorage::delete_locker(removed_locker);
        
        true
    }

    /// @notice Increase collateral of the locker
    /// @param locker_cap The locker capability object
    /// @param _locker_target_address Locker's target chain address
    /// @param wbtc_coins WBTC coins to add as collateral
    /// @param ctx Transaction context
    /// @return True if collateral is added successfully
    public fun add_collateral(
        locker_cap: &mut LockerCap,
        _locker_target_address: address,
        wbtc_coins: Coin<WBTC>,
        ctx: &mut TxContext
    ): bool {
        // Check if locker target address is not zero
        assert!(_locker_target_address != @0x0, ERROR_ZERO_ADDRESS);
        
        // Check if WBTC coins amount is not zero
        let wbtc_amount = coin::value(&wbtc_coins);
        assert!(wbtc_amount != 0, ERROR_ZERO_VALUE);
        
        // check if the sender is the locker
        assert!(lockerstorage::is_locker_by_address(locker_cap, _locker_target_address), ERROR_NOT_LOCKER);
        
        // Add WBTC coins to the vault first
        lockerstorage::add_wbtc_collateral_to_contract(locker_cap, wbtc_coins);
        
        // Get the locker after vault operation
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        // set locker collateral amount
        let old_collateral_amount = lockerstorage::get_collateral_token_locked_amount(the_locker);
        // update locker collateral amount
        lockerstorage::set_collateral_token_locked_amount(the_locker, old_collateral_amount + wbtc_amount);
        
        // Emit collateral added event
        lockerstorage::emit_collateral_added_event(
            _locker_target_address,
            WBTC_ADDRESS,
            wbtc_amount,
            old_collateral_amount + wbtc_amount,
            tx_context::epoch(ctx),
        );
        
        true
    }

    /// @notice Decreases collateral of the locker
    /// @dev Only the locker can remove collateral from their own position
    ///      Locker must be inactivated before removing collateral
    /// @param locker_cap The locker capability object
    /// @param _removing_collateral_token_amount Amount of removed collateral
    /// @param ctx Transaction context
    /// @return True if collateral is removed successfully
    public fun remove_collateral(
        locker_cap: &mut LockerCap,
        _removing_collateral_token_amount: u64,
        ctx: &mut TxContext
    ): bool {
        let sender = tx_context::sender(ctx);
        
        // Check if amount is not zero
        assert!(_removing_collateral_token_amount != 0, ERROR_ZERO_VALUE);
        
        // check if the sender is the locker
        assert!(lockerstorage::is_locker_by_address(locker_cap, sender), ERROR_NOT_LOCKER);
        
        // Get the locker after all other operations
        let the_locker = lockerstorage::get_locker_from_mapping(locker_cap, sender);

        // Get information from locker_cap before getting mutable reference to the_locker
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, sender);
        let collateral_decimal = lockerstorage::get_collateral_decimal(locker_cap, sender);
        let reliability_factor = lockerstorage::get_reliability_factor(locker_cap, sender);
        let collateral_amount = lockerstorage::get_collateral_token_locked_amount(the_locker);
        let net_minted = lockerstorage::get_locker_net_minted(the_locker);
        
        // Calculate price of one unit of collateral in BTC
        let price_of_one_unit_of_collateral = lockerstorage::price_of_one_unit_of_collateral_in_btc(
            collateral_token,
            collateral_decimal,
            locker_cap
        );
        
        // Capacity of locker = (locker's collateral value in TeleBTC) / (collateral ratio) - (minted TeleBTC)

        // Get lib constants for calculations
        let lib_constants = lockerstorage::get_lib_constants(locker_cap);
        let one_hundred_percent = lockerstorage::get_one_hundred_percent(lib_constants);
        let collateral_ratio = lockerstorage::get_collateral_ratio(locker_cap);
        
        let locker_capacity = collateral_amount * price_of_one_unit_of_collateral * one_hundred_percent * one_hundred_percent / 
        (collateral_ratio * reliability_factor * (std::u64::pow(10, collateral_decimal))) - net_minted;

        let max_removable_collateral = locker_capacity * (std::u64::pow(10, collateral_decimal)) / price_of_one_unit_of_collateral;
        assert!(_removing_collateral_token_amount <= max_removable_collateral, ERROR_MORE_THAN_MAX_REMOVABLE_COLLATERAL);
        
        // this the mutable version of the locker
        let mut_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, sender);

        // Update the locker collateral amount
        let new_collateral_amount = collateral_amount - _removing_collateral_token_amount;
        lockerstorage::set_collateral_token_locked_amount(mut_locker, new_collateral_amount);

        // Check if locker is not active (must be inactivated first)
        assert!(!lockerstorage::is_locker_active(locker_cap, sender, ctx), ERROR_LOCKER_ACTIVE);

        // Remove WBTC coins from the vault and return to sender
        let wbtc_coins = lockerstorage::remove_wbtc_collateral_from_contract(
            locker_cap,
            _removing_collateral_token_amount,
            ctx
        );
        // Return collateral coins to sender
        transfer::public_transfer(wbtc_coins, sender);
        
        // Emit collateral removed event
        lockerstorage::emit_collateral_removed_event(
            sender,
            collateral_token,
            _removing_collateral_token_amount,
            new_collateral_amount,
            tx_context::epoch(ctx),
        );
        
        true
    }

    


} 