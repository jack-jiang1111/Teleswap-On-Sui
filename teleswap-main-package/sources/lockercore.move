#[allow(lint(self_transfer))]
module teleswap::lockercore {


    // Import from storage and helper
    use teleswap::lockerstorage::{Self, LockerCap, LockerAdminCap};
    use teleswap::lockerhelper::{Self};
    use teleswap::telebtc::{Self, TeleBTCCap, TELEBTC};
    
    // Import burn router and related modules
    // Note: Burn router functionality moved to lockerhelper to avoid circular dependencies
    use teleswap::burn_router_storage::{BurnRouter};
    use btcrelay::btcrelay::{BTCRelay};
    use teleswap::burn_router_locker_connector::{Self};
    // Import Sui modules
    use sui::coin::{Self, Coin, TreasuryCap};

    // Error constants
    const ERROR_ZERO_VALUE: u64 = 530;
    const ERROR_LOCKER_NOT_ACTIVE: u64 = 531;
    const ERROR_BURN_FAILED: u64 = 532;
    const ERROR_INSUFFICIENT_FUNDS: u64 = 533;
    const ERROR_IS_PAUSED: u64 = 534;

    // WBTC constants
    const WBTC_ADDRESS: address = @0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b;

    /// @notice Mints TeleBTC tokens will only be called by the cctransfer contract
    /// @param _locker_locking_script Locker locking script
    /// @param _amount Amount to mint
    /// @param locker_cap The locker capability object
    /// @param telebtc_cap The TeleBTC capability
    /// @param treasury_cap The TeleBTC treasury capability
    /// @param _receiver Address to receive the minted tokens
    /// @param ctx Transaction context
    /// @return (Coin<TELEBTC>, address) - minted coins and locker address
    public(package) fun mint(
        _locker_locking_script: vector<u8>,
        _amount: u64,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        _receiver: address,
        ctx: &mut TxContext
    ): (Coin<TELEBTC>, address) {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Get locker target address from locking script
        let _locker_target_address = lockerstorage::get_locker_target_address_from_script(_locker_locking_script, locker_cap);
        
        // Check if locker is active
        assert!(lockerstorage::is_locker_active(locker_cap, _locker_target_address, ctx), ERROR_LOCKER_NOT_ACTIVE);
        
        // Call the mint helper function (similar to Solidity LockersManagerLib.mintHelper)
        lockerhelper::mint_helper(
            locker_cap,
            _locker_target_address,
            _amount
        );
        
        // Mint TeleBTC using the telebtc module
        let coins = telebtc::mint(telebtc_cap, treasury_cap, _receiver, _amount, ctx);
        
        // Emit mint event
        lockerstorage::emit_mint_by_locker_event(
            _locker_target_address,
            _receiver,
            _amount,
            0, // No fee for now
            tx_context::epoch(ctx),
        );
        
        (coins, _locker_target_address)
    }

    // Liquidation function (admin only)
    public fun liquidate_locker(
        _locker_target_address: address,
        _collateral_amount: u64,
        telebtc_coins: Coin<TELEBTC>,
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        btcrelay: &BTCRelay,
        burn_router: &mut BurnRouter,
        ctx: &mut TxContext
    ): bool {
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        
        // Check collateral amount is not zero
        assert!(_collateral_amount != 0, ERROR_ZERO_VALUE);
        
        // Assert admin privileges
        lockerstorage::assert_admin(admin_cap, locker_cap, ctx);
        
        // Get values from locker_cap before getting mutable reference
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, _locker_target_address);
        let collateral_decimal = lockerstorage::get_collateral_decimal(locker_cap, collateral_token);
        let reliability_factor = lockerstorage::get_reliability_factor(locker_cap, _locker_target_address);
        
        let needed_telebtc = lockerhelper::liquidate_locker(
            _locker_target_address,
            locker_cap,
            collateral_token,
            collateral_decimal,
            _collateral_amount,
            reliability_factor,
        );
        // Validate that provided TeleBTC coins are sufficient
        let provided_telebtc = coin::value(&telebtc_coins);
        assert!(provided_telebtc >= needed_telebtc, ERROR_INSUFFICIENT_FUNDS);
        
        // Get locker's rescue script and script type for unwrap
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        let locker_rescue_script = lockerstorage::get_locker_rescue_script(the_locker);
        let locker_script_type = lockerstorage::get_locker_script_type(the_locker);
        let locker_locking_script = lockerstorage::get_locker_locking_script(the_locker);
        
        // Update locked collateral of locker
        let current_collateral = lockerstorage::get_collateral_token_locked_amount(the_locker);
        lockerstorage::set_collateral_token_locked_amount(the_locker, current_collateral - _collateral_amount);
        
        // Unwrap TeleBTC for locker rescue script using helper function
        let remaining_amount = burn_router_locker_connector::unwrap(
            burn_router,
            telebtc_coins, 
            locker_rescue_script, 
            locker_script_type, 
            locker_locking_script, 
            0,
            telebtc_cap, 
            treasury_cap, 
            btcrelay,
            locker_cap,
            ctx
        );
        assert!(remaining_amount != 0, ERROR_BURN_FAILED);
        
        // Check if locker has sufficient collateral balance
        let locker_collateral_token_balance = lockerstorage::get_locker_collateral_token_balance(locker_cap, _locker_target_address);
        assert!(locker_collateral_token_balance >= _collateral_amount, ERROR_INSUFFICIENT_FUNDS);
        
        // Handle token transfers based on token type
        if (collateral_token == WBTC_ADDRESS) {
            // Transfer WBTC to liquidator
            let liquidator_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, _collateral_amount, ctx);
            transfer::public_transfer(liquidator_coins, tx_context::sender(ctx));
        } else {
            // For other tokens (treat as ERC20 equivalent)
            // TODO: Implement generic token transfer logic
            // For now, just assert that we have sufficient balance
            assert!(false, ERROR_INSUFFICIENT_FUNDS);
        };
        
        // Emit liquidation event
        lockerstorage::emit_locker_liquidated_event(
            _locker_target_address,
            tx_context::sender(ctx),
            collateral_token,
            _collateral_amount,
            needed_telebtc,
            tx_context::epoch(ctx),
        );
        
       
        true
    }
    
    /// @notice Buys slashed collateral of a locker
    /// @param the_locker The locker reference
    /// @param _collateral_amount The amount of collateral to buy
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    /// @return The amount of TeleBTC needed to buy the collateral
    public fun buy_slashed_collateral_of_locker(
        _locker_target_address: address,
        _collateral_amount: u64,
        telebtc_coins: Coin<TELEBTC>,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext
    ): bool {
        // Check collateral amount is not zero
        assert!(_collateral_amount != 0, ERROR_ZERO_VALUE);
        // Check if system is paused
        assert!(!lockerstorage::is_paused(locker_cap), ERROR_IS_PAUSED);
        // Get locker from mapping
        let the_locker = lockerstorage::get_mut_locker_from_mapping(locker_cap, _locker_target_address);
        
        // Call helper function to calculate needed TeleBTC
        let needed_telebtc = lockerhelper::buy_slashed_collateral_of_locker(
            the_locker,
            _collateral_amount
        );
        
        // Validate that provided TeleBTC coins are sufficient
        let provided_telebtc = coin::value(&telebtc_coins);
        assert!(provided_telebtc >= needed_telebtc, ERROR_INSUFFICIENT_FUNDS);
        
        // Burn user's TeleBTC using telebtc module
        let burn_success = telebtc::burn(telebtc_cap, treasury_cap, telebtc_coins, ctx);
        assert!(burn_success, ERROR_BURN_FAILED);
        
        // Transfer collateral to buyer
        let collateral_token = lockerstorage::get_collateral_token(locker_cap, _locker_target_address);
        
        let locker_collateral_token_balance = lockerstorage::get_locker_collateral_token_balance(locker_cap, _locker_target_address);
       
        // Check if locker has sufficient collateral balance
        assert!(locker_collateral_token_balance >= _collateral_amount, ERROR_INSUFFICIENT_FUNDS);
        
        // Handle token transfers based on token type
        if (collateral_token == WBTC_ADDRESS) {
            // Transfer WBTC to buyer
            let buyer_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, _collateral_amount, ctx);
            transfer::public_transfer(buyer_coins, tx_context::sender(ctx));
        } else {
            // For other tokens (treat as ERC20 equivalent)
            // TODO: Implement generic token transfer logic
            // For now, just assert that we have sufficient balance
            assert!(false, ERROR_INSUFFICIENT_FUNDS);
        };
        
        // Emit slashed collateral sold event
        lockerstorage::emit_locker_slashed_collateral_sold_event(
            _locker_target_address,
            tx_context::sender(ctx),
            collateral_token,
            _collateral_amount,
            needed_telebtc,
            tx_context::epoch(ctx),
        );
        
        true
    }


    // Emergency functions only admin
    public fun emergency_withdraw(
        _token: address,
        _amount: u64,
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ) {
        // Check amount is not zero
        assert!(_amount != 0, ERROR_ZERO_VALUE);
        
        // Assert admin privileges
        lockerstorage::assert_admin(admin_cap, locker_cap, ctx);
        
        // Get admin address
        let admin_address = tx_context::sender(ctx);
        
        // Check if contract has sufficient collateral balance
        let contract_collateral_balance = lockerstorage::get_wbtc_collateral_balance(locker_cap);
        assert!(contract_collateral_balance >= _amount, ERROR_INSUFFICIENT_FUNDS);
        
        // Handle token withdrawals based on token type
        if (_token == WBTC_ADDRESS) {
            // Withdraw WBTC from vault and transfer to admin
            let wbtc_coins = lockerstorage::remove_wbtc_collateral_from_contract(locker_cap, _amount, ctx);
            transfer::public_transfer(wbtc_coins, admin_address);
        } else {
            // For other tokens (treat as ERC20 equivalent)
            // TODO: Implement generic token withdrawal logic
            // For now, just assert that we have sufficient balance
            assert!(false, ERROR_INSUFFICIENT_FUNDS);
        };
        
        // Emit emergency withdraw event
        lockerstorage::emit_emergency_withdraw_event(
            _token,
            _amount,
            admin_address,
            tx_context::epoch(ctx),
        );
    }

} 