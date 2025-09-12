#[allow(unused_field, unused_variable, unused_use,unused_const)]
module teleswap::lockerstorage {
    use sui::event;
    use sui::table::{Self, Table};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::clock::{Self as clock, Clock};
    use teleswap::telebtc::{Self, TeleBTCCap, TELEBTC};
    use sui::coin::{Self, Coin, TreasuryCap};

    use std::bcs;
    use teleswap::price_oracle;
    use teleswap::wbtc::{WBTC};
    //debug event
    public struct DebugEvent has copy, drop {
        num1: u256,
        num2: u256,
        num3: u256,
        num4: u256,
        num5: u256,
    }
    // ============================================================================
    // CONSTANTS
    // ============================================================================

    // System constants
    const ONE_HUNDRED_PERCENT: u256 = 10000;
    const HEALTH_FACTOR: u256 = 10000;
    const UPPER_HEALTH_FACTOR: u256 = 12500;
    const MAX_LOCKER_FEE: u256 = 10000;
   


    // WBTC constants
    const WBTC_ADDRESS: address = @wbtc;
    //const WBTC_DECIMALS: u64 = 8;

    // Error constants
    const ERROR_NOT_ADMIN: u64 = 500;
    const ERROR_ALREADY_INITIALIZED: u64 = 501;
    const ERROR_ZERO_ADDRESS: u64 = 502;
    const ERROR_ZERO_VALUE: u64 = 503;
    const ERROR_INVALID_VALUE: u64 = 504;
    const ERROR_INSUFFICIENT_VAULT_BALANCE: u64 = 505;
    const ERROR_INVALID_GET: u64 = 506;
    const ERROR_IS_PAUSED: u64 = 507;
    const ERROR_IS_UNPAUSED: u64 = 508;
    const ERROR_NOT_LOCKER: u64 = 512;

    // ============================================================================
    // STRUCTS
    // ============================================================================

    /// Core locker structure containing all locker data
    public struct Locker has store, key {
        id: UID,
        locker_locking_script: vector<u8>,
        locker_script_type: u8,
        locker_rescue_script: vector<u8>,
        collateral_token_locked_amount: u256,
        net_minted: u256,
        slashing_telebtc_amount: u256,
        reserved_collateral_token_for_slash: u256,
        is_locker: bool,
        is_candidate: bool,
        is_script_hash: bool,
    }

    /// Library constants for locker operations
    public struct LockersLibConstants has store, key {
        id: UID,
        one_hundred_percent: u256,
        health_factor: u256,
        upper_health_factor: u256,
        max_locker_fee: u256,
    }

    /// Admin capability for locker management
    public struct LockerAdminCap has key, store {
        id: UID,
        initialized: bool,
    }

    /// Main locker capability containing all locker state
    public struct LockerCap has key, store {
        id: UID,
        admin_address: address,
        paused: bool,
        locker_percentage_fee: u256,
        collateral_ratio: u256,
        liquidation_ratio: u256,
        price_with_discount_ratio: u256,
        total_number_of_candidates: u64,
        total_number_of_lockers: u64,
        inactivation_delay: u64,    // inactivation delay in seconds
        lockers_mapping: Table<address, Locker>, // locker target address -> locker structure
        locker_inactivation_timestamp: Table<address, u64>, // locker target address -> u64
        locker_leaving_acceptance: Table<address, bool>, // locker target address -> bool
        get_locker_target_address: Table<vector<u8>, address>, // locker locking script -> locker target address
        lib_constants: LockersLibConstants,
        locker_reliability_factor: Table<address, u256>, // locker target address -> u256 (reliability factor)
        // WBTC vault storage - only lockercore can access these
        wbtc_vault: Balance<WBTC>, // WBTC collateral vault

        //-------------------------------------------
        // These are the mock variables, will be deleted after testing
        is_locker: bool,
        locker_target_address: address,
        burn_return: u64,
        slash_idle_locker_return: bool,
        slash_thief_locker_return: bool,
        price_modifier: u256,
    }

    // ============================================================================
    // EVENTS
    // ============================================================================

    // Locker lifecycle events
    public struct RequestAddLockerEvent has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
    }

    public struct RevokeAddLockerRequestEvent has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
    }

    public struct RequestInactivateLockerEvent has copy, drop {
        locker_target_address: address,
        inactivation_timestamp: u64,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
        net_minted: u256,
    }

    public struct ActivateLockerEvent has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
        net_minted: u256,
    }

    public struct LockerAddedEvent has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
        reliability_factor: u256,
        adding_time: u64,
    }

    public struct LockerRemovedEvent has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_unlocked_amount: u256,
    }

    // Locker operation events
    public struct LockerSlashedEvent has copy, drop {
        locker_target_address: address,
        reward_amount: u256,
        reward_recipient: address,
        amount: u256,
        recipient: address,
        slashed_collateral_amount: u256,
        slash_time: u64,
        is_for_cc_burn: bool,
    }

    public struct LockerLiquidatedEvent has copy, drop {
        locker_target_address: address,
        liquidator_address: address,
        collateral_amount: u256,
        telebtc_amount: u256,
        liquidate_time: u64,
    }

    public struct LockerSlashedCollateralSoldEvent has copy, drop {
        locker_target_address: address,
        buyer_address: address,
        slashing_amount: u256,
        telebtc_amount: u256,
        slashing_time: u64,
    }

    public struct CollateralAddedEvent has copy, drop {
        locker_target_address: address,
        added_collateral: u256,
        total_collateral: u256,
        adding_time: u64,
    }

    public struct CollateralRemovedEvent has copy, drop {
        locker_target_address: address,
        removed_amount: u256,
        total_collateral_amount: u256,
        removing_time: u64,
    }

    public struct MintByLockerEvent has copy, drop {
        locker_target_address: address,
        receiver: address,
        minted_amount: u256,
        locker_fee: u256,
        minting_time: u64,
    }

    public struct BurnByLockerEvent has copy, drop {
        locker_target_address: address,
        burnt_amount: u256,
        locker_fee: u256,
        burning_time: u64,
    }

    public struct LockerPausedEvent has copy, drop {
        paused_by: address,
        pause_time: u64,
    }

    public struct LockerUnpausedEvent has copy, drop {
        unpaused_by: address,
        unpause_time: u64,
    }

    public struct NewLockerPercentageFeeEvent has copy, drop {
        old_locker_percentage_fee: u256,
        new_locker_percentage_fee: u256,
    }

    public struct NewReliabilityFactorEvent has copy, drop {
        locker_target_address: address,
        old_reliability_factor: u256,
        new_reliability_factor: u256,
    }

    public struct NewPriceWithDiscountRatioEvent has copy, drop {
        old_price_with_discount_ratio: u256,
        new_price_with_discount_ratio: u256,
    }


    public struct NewCollateralRatioEvent has copy, drop {
        old_collateral_ratio: u256,
        new_collateral_ratio: u256,
    }

    public struct NewLiquidationRatioEvent has copy, drop {
        old_liquidation_ratio: u256,
        new_liquidation_ratio: u256,
    }

    public struct EmergencyWithdrawEvent has copy, drop {
        amount: u256,
        admin: address,
        epoch: u64,
    }

    // Deposit collateral event
    public struct DepositCollateralEvent has copy, drop {
        amount: u256,
        depositor: address,
        epoch: u64,
    }

    // Withdraw collateral event
    public struct WithdrawCollateralEvent has copy, drop {
        amount: u256,
        withdrawer: address,
        epoch: u64,
    }

    

    // ============================================================================
    // INITIALIZATION FUNCTIONS
    // ============================================================================

    /// @notice Initializes the module and creates admin capability
    /// @param ctx Transaction context
    fun init(ctx: &mut TxContext) {
        let admin_cap = LockerAdminCap {
            id: object::new(ctx),
            initialized: false,
        };
        transfer::public_transfer(admin_cap, tx_context::sender(ctx));
    }

    /// @notice Initializes the locker contract with all configuration parameters
    /// @dev Can only be called once. Shares the LockerCap object for protocol use
    /// @param admin_cap The admin capability object (must be mutable reference)
    /// @param locker_percentage_fee Locker fee percentage
    /// @param collateral_ratio Collateral ratio
    /// @param liquidation_ratio Liquidation ratio
    /// @param price_with_discount_ratio Price discount ratio
    /// @param ctx The transaction context
    public fun initialize(
        admin_cap: &mut LockerAdminCap,
        locker_percentage_fee: u256,
        collateral_ratio: u256,
        liquidation_ratio: u256,
        price_with_discount_ratio: u256,
        ctx: &mut TxContext
    ) {
        // Check if already initialized
        assert!(!admin_cap.initialized, ERROR_ALREADY_INITIALIZED);
        
        // Set initialized flag
        admin_cap.initialized = true;

        // Create lib constants
        let lib_constants = LockersLibConstants {
            id: object::new(ctx),
            one_hundred_percent: ONE_HUNDRED_PERCENT,
            health_factor: HEALTH_FACTOR,
            upper_health_factor: UPPER_HEALTH_FACTOR,
            max_locker_fee: MAX_LOCKER_FEE,
        };


        // Create the main locker capability object
        let locker_cap = LockerCap {
            id: object::new(ctx),
            admin_address: tx_context::sender(ctx),
            paused: false,
            locker_percentage_fee,
            collateral_ratio,
            liquidation_ratio,
            price_with_discount_ratio,
            total_number_of_candidates: 0,
            total_number_of_lockers: 0,
            inactivation_delay: 86400,
            lockers_mapping: table::new(ctx),
            locker_inactivation_timestamp: table::new(ctx),
            locker_leaving_acceptance: table::new(ctx),
            get_locker_target_address: table::new(ctx),
            lib_constants,
            locker_reliability_factor: table::new(ctx),
            // Initialize WBTC vault storage
            wbtc_vault: balance::zero(),

            //-------------------------------------------
            // These are the mock variables, will be deleted after testing
            is_locker: true,
            locker_target_address: @0x0,
            burn_return: 0,
            slash_idle_locker_return: true,
            slash_thief_locker_return: true,
            price_modifier: 10000,
        };

        // Share the locker capability object
        transfer::public_share_object(locker_cap);
    }

    // ============================================================================
    // ADMIN FUNCTIONS
    // ============================================================================

    /// @notice Checks if the caller is the admin
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    public(package) fun assert_admin(admin_cap: &LockerAdminCap, locker_cap: &LockerCap, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == locker_cap.admin_address, ERROR_NOT_ADMIN);
    }

    /// @notice Pauses the locker system (admin only)
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    public fun pause_locker(admin_cap: &LockerAdminCap, locker_cap: &mut LockerCap, ctx: &TxContext) {
        assert_admin(admin_cap, locker_cap, ctx);
        assert!(!locker_cap.paused, ERROR_IS_PAUSED);
        locker_cap.paused = true;
        event::emit(LockerPausedEvent {
            paused_by: tx_context::sender(ctx),
            pause_time: tx_context::epoch(ctx),
        });
    }

    /// @notice Unpauses the locker system (admin only)
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param ctx Transaction context
    public fun unpause_locker(admin_cap: &LockerAdminCap, locker_cap: &mut LockerCap, ctx: &TxContext) {
        assert_admin(admin_cap, locker_cap, ctx);
        assert!(locker_cap.paused, ERROR_IS_UNPAUSED);
        locker_cap.paused = false;
        event::emit(LockerUnpausedEvent {
            unpaused_by: tx_context::sender(ctx),
            unpause_time: tx_context::epoch(ctx),
        });
    }

    /// @notice Checks if locker is paused
    /// @param locker_cap The locker capability object
    /// @return True if locker is paused
    public fun is_paused(locker_cap: &LockerCap): bool {
        locker_cap.paused
    }

    // ============================================================================
    // LOCKER CREATION AND MANAGEMENT
    // ============================================================================

    /// @notice Creates a new Locker instance
    /// @param locker_locking_script The locking script for the locker
    /// @param locker_script_type The type of script
    /// @param locker_rescue_script The rescue script for the locker
    /// @param collateral_token_locked_amount Amount of collateral locked
    /// @param ctx Transaction context
    /// @return New Locker instance
    public(package) fun create_locker(
        locker_locking_script: vector<u8>,
        locker_script_type: u8,
        locker_rescue_script: vector<u8>,
        collateral_token_locked_amount: u256,
        ctx: &mut TxContext
    ): Locker {
        Locker {
            id: object::new(ctx),
            locker_locking_script,
            locker_script_type,
            locker_rescue_script,
            collateral_token_locked_amount,
            net_minted: 0,
            slashing_telebtc_amount: 0,
            reserved_collateral_token_for_slash: 0,
            is_locker: false,
            is_candidate: true,
            is_script_hash: false,
        }
    }

    /// @notice Adds a locker to the lockers mapping table
    /// @dev This function adds a new locker entry to the lockers mapping
    /// @param locker_cap The locker capability object
    /// @param locker_target_address Target address of the locker
    /// @param locker The locker object to add
    public(package) fun add_locker_to_mapping(locker_cap: &mut LockerCap, locker_target_address: address, locker: Locker) {
        table::add(&mut locker_cap.lockers_mapping, locker_target_address, locker);
    }

    /// @notice Removes a locker from the mapping
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The locker target address to remove
    /// @return The removed locker
    public(package) fun remove_locker_from_mapping(
        locker_cap: &mut LockerCap,
        locker_target_address: address
    ): Locker {
        table::remove(&mut locker_cap.lockers_mapping, locker_target_address)
    }

    /// @notice Increments the total number of candidates
    /// @dev This function increases the total count of locker candidates by one
    /// @param locker_cap The locker capability object
    public(package) fun increment_total_candidates(locker_cap: &mut LockerCap) {
        locker_cap.total_number_of_candidates = locker_cap.total_number_of_candidates + 1;
    }

    /// @notice Decrements the total number of candidates
    /// @param locker_cap The locker capability object
    public(package) fun decrement_total_candidates(locker_cap: &mut LockerCap) {
        assert!(locker_cap.total_number_of_candidates > 0, ERROR_INVALID_VALUE);
        locker_cap.total_number_of_candidates = locker_cap.total_number_of_candidates - 1;
    }

    /// @notice Increments the total number of lockers
    /// @param locker_cap The locker capability object
    public(package) fun increment_total_lockers(locker_cap: &mut LockerCap) {
        locker_cap.total_number_of_lockers = locker_cap.total_number_of_lockers + 1;
    }

    /// @notice Sets the locker target address mapping
    /// @param locker_cap The locker capability object
    /// @param locker_locking_script The locker locking script
    /// @param locker_target_address The locker target address
    public(package) fun set_locker_target_address_mapping(
        locker_cap: &mut LockerCap,
        locker_locking_script: vector<u8>,
        locker_target_address: address
    ) {
        table::add(&mut locker_cap.get_locker_target_address, locker_locking_script, locker_target_address);
    }

    /// @notice Deletes a locker by extracting its UID
    /// @param locker The locker to delete
    public(package) fun delete_locker(locker: Locker) {
        let Locker { id, .. } = locker;
        object::delete(id);
    }

    /// @notice Increments the total number of lockers
    /// @param locker_cap The locker capability object
    public(package) fun decrement_total_lockers(locker_cap: &mut LockerCap) {
        assert!(locker_cap.total_number_of_lockers > 0, ERROR_INVALID_VALUE);
        locker_cap.total_number_of_lockers = locker_cap.total_number_of_lockers - 1;
    }

    // ============================================================================
    // STATUS AND TIMESTAMP MANAGEMENT
    // ============================================================================

    /// @notice Gets the locker inactivation timestamp
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The locker target address
    /// @return The inactivation timestamp
    public(package) fun get_locker_inactivation_timestamp(
        locker_cap: &LockerCap,
        locker_target_address: address
    ): u64 {
        assert!(table::contains(&locker_cap.locker_inactivation_timestamp, locker_target_address), ERROR_INVALID_GET);
        *table::borrow(&locker_cap.locker_inactivation_timestamp, locker_target_address)
    }

    /// @notice Sets the locker inactivation timestamp
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The locker target address
    /// @param timestamp The inactivation timestamp
    public(package) fun set_locker_inactivation_timestamp(
        locker_cap: &mut LockerCap,
        locker_target_address: address,
        timestamp: u64
    ) {
        // Update the locker collateral token mapping (overwrites if key exists)
        if (table::contains(&locker_cap.locker_inactivation_timestamp, locker_target_address)) {
            table::remove(&mut locker_cap.locker_inactivation_timestamp, locker_target_address);
        };
        table::add(&mut locker_cap.locker_inactivation_timestamp, locker_target_address, timestamp);
    }

    /// @notice Gets the inactivation delay from lib constants
    /// @param locker_cap The locker capability object
    /// @return The inactivation delay in seconds
    public fun get_inactivation_delay(locker_cap: &LockerCap): u64 {
        // For now, return a default value.
        locker_cap.inactivation_delay
    }

    /// @notice Sets the candidate status of a locker
    /// @param locker The locker to update
    /// @param is_candidate The new candidate status
    public(package) fun set_locker_candidate_status(locker: &mut Locker, is_candidate: bool) {
        locker.is_candidate = is_candidate;
    }

    /// @notice Sets the locker status of a locker
    /// @param locker The locker to update
    /// @param is_locker The new locker status
    public(package) fun set_locker_status(locker: &mut Locker, is_locker: bool) {
        locker.is_locker = is_locker;
    }

    /// @notice Gets the net minted amount for a locker
    /// @param locker The locker
    /// @return The net minted amount
    public fun get_locker_net_minted(locker: &Locker): u256 {
        locker.net_minted
    }

    /// @notice Removes the locker target address mapping
    /// @param locker_cap The locker capability object
    /// @param locker_locking_script The locker locking script
    public(package) fun remove_locker_target_address_mapping(
        locker_cap: &mut LockerCap,
        locker_locking_script: vector<u8>
    ) {
        table::remove(&mut locker_cap.get_locker_target_address, locker_locking_script);
    }

    // ============================================================================
    // LOCKER GETTER FUNCTIONS
    // ============================================================================

    /// @notice Gets slashing TeleBTC amount
    /// @param locker Reference to locker
    /// @return Slashing TeleBTC amount
    public fun get_slashing_telebtc_amount(locker: &Locker): u256 {
        locker.slashing_telebtc_amount
    }

    /// @notice Gets reserved collateral token for slash
    /// @param locker Reference to locker
    /// @return Reserved collateral token for slash
    public fun get_reserved_collateral_token_for_slash(locker: &Locker): u256 {
        locker.reserved_collateral_token_for_slash
    }

    /// @notice Gets if locker struct is active
    /// @param locker Reference to locker
    /// @return True if locker is active
    public fun is_locker_struct_active(locker: &Locker): bool {
        locker.is_locker
    }

    // ============================================================================
    // LOCKER SETTER FUNCTIONS && GETTER FUNCTIONS
    // ============================================================================

    /// @notice Updates slashing TeleBTC amount
    /// @param locker Reference to locker
    /// @param new_amount New slashing TeleBTC amount
    public(package) fun set_slashing_telebtc_amount(locker: &mut Locker, new_amount: u256) {
        locker.slashing_telebtc_amount = new_amount;
    }

    /// @notice Updates reserved collateral token for slash
    /// @param locker Reference to locker
    /// @param new_amount New reserved collateral token for slash
    public(package) fun set_reserved_collateral_token_for_slash(locker: &mut Locker, new_amount: u256) {
        locker.reserved_collateral_token_for_slash = new_amount;
    }

    /// @notice Sets collateral token locked amount
    /// @param locker The locker to update
    /// @param new_amount New collateral token locked amount
    public(package) fun set_collateral_token_locked_amount(locker: &mut Locker, new_amount: u256) {
        locker.collateral_token_locked_amount = new_amount;
    }

    /// @notice Sets net minted amount
    /// @param locker The locker to update
    /// @param new_amount New net minted amount
    public(package) fun set_net_minted(locker: &mut Locker, new_amount: u256) {
        locker.net_minted = new_amount;
    }

    /// @notice Gets collateral token locked amount
    /// @param locker The locker to get amount from
    /// @return Collateral token locked amount
    public fun get_collateral_token_locked_amount(locker: &Locker): u256 {
        locker.collateral_token_locked_amount
    }

    /// @notice Gets net minted amount
    /// @param locker The locker to get amount from
    /// @return Net minted amount
    public fun get_net_minted(locker: &Locker): u256 {
        locker.net_minted
    }

    /// @notice Gets is_locker flag
    /// @param locker The locker to get flag from
    /// @return Is locker flag
    public fun get_is_locker(locker: &Locker): bool {
        locker.is_locker
    }

    /// @notice Gets one hundred percent from constants
    /// @param constants The constants to get value from
    /// @return One hundred percent value
    public fun get_one_hundred_percent(constants: &LockersLibConstants): u256 {
        constants.one_hundred_percent
    }

    /// @notice Gets health factor from constants
    /// @param constants The constants to get value from
    /// @return Health factor value
    public fun get_health_factor(constants: &LockersLibConstants): u256 {
        constants.health_factor
    }

    /// @notice Gets liquidation ratio from params
    /// @param params The params to get value from
    /// @return Liquidation ratio value
    public fun get_liquidation_ratio(locker_cap: &LockerCap): u256 {
        locker_cap.liquidation_ratio
    }

    /// @notice Gets collateral ratio from params
    /// @param params The params to get value from
    /// @return Collateral ratio value
    public fun get_collateral_ratio(locker_cap: &LockerCap): u256 {
        locker_cap.collateral_ratio
    }

    /// @notice Gets lib constants from locker cap
    /// @param locker_cap The locker capability object
    /// @return Reference to lib constants
    public fun get_lib_constants(locker_cap: &LockerCap): &LockersLibConstants {
        &locker_cap.lib_constants
    }

    /// @notice Gets locker percentage fee
    /// @param locker_cap The locker capability object
    /// @return Locker percentage fee
    public fun locker_percentage_fee(locker_cap: &LockerCap): u256 {
        locker_cap.locker_percentage_fee
    }

    /// @notice Gets collateral ratio
    /// @param locker_cap The locker capability object
    /// @return Collateral ratio
    public fun collateral_ratio(locker_cap: &LockerCap): u256 {
        locker_cap.collateral_ratio
    }

    /// @notice Gets liquidation ratio
    /// @param locker_cap The locker capability object
    /// @return Liquidation ratio
    public fun liquidation_ratio(locker_cap: &LockerCap): u256 {
        locker_cap.liquidation_ratio
    }

    /// @notice Gets price with discount ratio
    /// @param locker_cap The locker capability object
    /// @return Price with discount ratio
    public fun price_with_discount_ratio(locker_cap: &LockerCap): u256 {
        locker_cap.price_with_discount_ratio
    }

    /// @notice Gets total number of candidates
    /// @param locker_cap The locker capability object
    /// @return Total number of candidates
    public fun total_number_of_candidates(locker_cap: &LockerCap): u64 {
        locker_cap.total_number_of_candidates
    }

    /// @notice Gets total number of lockers
    /// @param locker_cap The locker capability object
    /// @return Total number of lockers
    public fun total_number_of_lockers(locker_cap: &LockerCap): u64 {
        locker_cap.total_number_of_lockers
    }

    /// @notice Gets locker target address
    /// @param _locker_locking_script Locker locking script
    /// @param locker_cap The locker capability object
    /// @return Locker target address
    public fun get_locker_target_address(_locker_locking_script: vector<u8>, locker_cap: &LockerCap): address {
        // Get the locker target address from the table
        assert!(table::contains(&locker_cap.get_locker_target_address, _locker_locking_script), ERROR_INVALID_GET);
        *table::borrow(&locker_cap.get_locker_target_address, _locker_locking_script)
    }

    /// @notice Checks if address is a locker
    /// @param locker_cap The locker capability object
    /// @param _locker_locking_script Locker locking script
    /// @return True if is locker
    public fun is_locker(locker_cap: &LockerCap, _locker_locking_script: vector<u8>): bool {
        // Get the locker target address from the locking script
        let locker_target_address = get_locker_target_address(_locker_locking_script, locker_cap);
        
        // Check if the locker exists and is a locker
        if (locker_target_address != @0x0 && table::contains(&locker_cap.lockers_mapping, locker_target_address)) {
            let locker = table::borrow(&locker_cap.lockers_mapping, locker_target_address);
            locker.is_locker
        } else {
            false
        }
    }

    /// @notice Checks if address is a locker
    /// @param locker_cap The locker capability object
    /// @param _locker_locking_script Locker locking script
    /// @return True if is locker
    public fun is_locker_by_address(locker_cap: &LockerCap, locker_target_address: address): bool {
        // Check if the locker exists and is a locker
        if (locker_target_address != @0x0 && table::contains(&locker_cap.lockers_mapping, locker_target_address)) {
            let locker = table::borrow(&locker_cap.lockers_mapping, locker_target_address);
            locker.is_locker
        } else {
            false
        }
    }

    /// @notice Checks if locker is active
    /// @param locker_cap The locker capability object
    /// @param _locker_target_address Locker target address
    /// @param ctx Transaction context
    /// @return True if locker is active
    public fun is_locker_active(locker_cap: &LockerCap, _locker_target_address: address, clock: &Clock, ctx: &TxContext): bool {
        // Check if the locker has an inactivation timestamp
        if (table::contains(&locker_cap.locker_inactivation_timestamp, _locker_target_address)) {
            let inactivation_timestamp = table::borrow(&locker_cap.locker_inactivation_timestamp, _locker_target_address);
            // If inactivation timestamp is 0, locker is active
            
            if (*inactivation_timestamp == 0) {
                true
            } else {
                // Compare with current timestamp
                let current_timestamp =  clock::timestamp_ms(clock);
                *inactivation_timestamp > current_timestamp
            }
        } else {
            // If no inactivation timestamp exists, locker is active
            true
        }
    }

    /// @notice Checks if a locker exists in the mapping
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The target address to check
    /// @return True if locker exists
    public fun locker_exists(locker_cap: &LockerCap, locker_target_address: address): bool {
        table::contains(&locker_cap.lockers_mapping, locker_target_address)
    }

    /// @notice Gets a locker from the mapping
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The target address
    /// @return Reference to the locker
    public fun get_locker_from_mapping(locker_cap: &LockerCap, locker_target_address: address): &Locker {
        assert!(table::contains(&locker_cap.lockers_mapping, locker_target_address), ERROR_NOT_LOCKER);
        table::borrow(&locker_cap.lockers_mapping, locker_target_address)
    }

    /// @notice Gets a mutable locker from the mapping
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The target address
    /// @return Mutable reference to the locker
    public(package) fun get_mut_locker_from_mapping(locker_cap: &mut LockerCap, locker_target_address: address): &mut Locker {
        assert!(table::contains(&locker_cap.lockers_mapping, locker_target_address), ERROR_NOT_LOCKER);
        table::borrow_mut(&mut locker_cap.lockers_mapping, locker_target_address)
    }

    /// @notice Gets locker rescue script
    /// @param the_locker The locker reference
    /// @return Locker rescue script
    public fun get_locker_rescue_script(the_locker: &Locker): vector<u8> {
        the_locker.locker_rescue_script
    }

    /// @notice Gets locker script type
    /// @param the_locker The locker reference
    /// @return Locker script type
    public fun get_locker_script_type(the_locker: &Locker): u8 {
        the_locker.locker_script_type
    }

    /// @notice Gets locker locking script
    /// @param the_locker The locker reference
    /// @return Locker locking script
    public fun get_locker_locking_script(the_locker: &Locker): vector<u8> {
        the_locker.locker_locking_script
    }

    /// @notice Checks if a locker is a candidate
    /// @dev This function checks if a locker object is marked as a candidate
    /// @param locker Reference to the locker object
    /// @return True if the locker is a candidate, false otherwise
    public fun is_locker_candidate(locker: &Locker): bool {
        locker.is_candidate
    }

    /// @notice Gets the reliability factor for a locker
    /// @dev This function returns the reliability factor assigned to a specific locker
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The target address of the locker
    /// @return The reliability factor for the locker
    public fun get_reliability_factor(locker_cap: &LockerCap, locker_target_address: address): u256 {
        assert!(table::contains(&locker_cap.locker_reliability_factor, locker_target_address), ERROR_INVALID_GET);
        *table::borrow(&locker_cap.locker_reliability_factor, locker_target_address)
    }

    /// @notice Gets the WBTC collateral balance of the locker contract
    /// @param locker_cap The locker capability object
    /// @return The WBTC collateral balance
    public fun get_wbtc_collateral_balance(locker_cap: &LockerCap): u256 {
        balance::value(&locker_cap.wbtc_vault) as u256
    }

    /// @notice Gets the collateral balance of the locker contract for a specific token
    /// @param locker_cap The locker capability object
    /// @param locker_target_address The target address (including SUI @0x1)
    /// @return The collateral balance
    public fun get_locker_collateral_token_balance(locker_cap: &LockerCap, locker_target_address: address): u256 {
        let locker = get_locker_from_mapping(locker_cap, locker_target_address);
        locker.collateral_token_locked_amount
    }

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================

    /// @notice Extracts UID from LockersLibConstants struct
    /// @param constants The constants struct
    /// @return The UID
    public fun extract_uid_from_constants(constants: LockersLibConstants): UID {
        let LockersLibConstants { id, .. } = constants;
        id
    }

    // ============================================================================
    // CALCULATION FUNCTIONS
    // ============================================================================

    /// @notice Calculates health factor for a locker
    /// @param locker_target_address Locker target address
    /// @param locker_cap The locker capability object
    /// @param _reliability_factor Reliability factor
    /// @return Health factor value
    public fun calculate_health_factor(
        locker_target_address: address,
        locker_cap: &mut LockerCap,
        _reliability_factor: u256
    ): u256 {

        let one_hundred_percent = locker_cap.lib_constants.one_hundred_percent;
        let liquidation_ratio = locker_cap.liquidation_ratio;
        let price_modifier = locker_cap.price_modifier;// default 100% since wbtc is 1:1 with telebtc

        let the_locker = get_mut_locker_from_mapping(locker_cap, locker_target_address);
        let numerator = (price_modifier * the_locker.collateral_token_locked_amount) * 
                       (one_hundred_percent * one_hundred_percent);
        
        let denominator = 1+ (the_locker.net_minted) * 
                         (liquidation_ratio) * 
                         (_reliability_factor);
        (numerator / denominator)
    }

    /// @notice Calculates needed TeleBTC to buy collateral
    /// @param locker_cap The locker capability object
    /// @param _collateral_amount Amount of collateral
    /// @param _price_of_collateral Price of collateral
    /// @return Amount of TeleBTC needed
    public fun needed_telebtc_to_buy_collateral(
        locker_cap: &LockerCap,
        _collateral_amount: u256,
        _price_of_collateral: u256
    ): u256 {
        let numerator = _collateral_amount * _price_of_collateral * locker_cap.price_with_discount_ratio;
        let denominator = locker_cap.lib_constants.one_hundred_percent * std::u256::pow(10, 8);
        numerator / denominator
    }
    
    /// @notice Calculates the price of one unit of collateral in BTC
    /// By default, the current price orcale will just return the same amount as input (since its WBTC)
    /// @dev This function uses the price oracle to get the equivalent BTC value of one unit of collateral
    /// @param locker_cap The locker capability object
    /// @return Price in BTC
    public fun price_of_one_unit_of_collateral_in_btc(
        locker_cap: &LockerCap
    ): u256 {
        // by deafult this should return 10^8, represent 1 WBTC     
        std::u256::pow(10, 8) * locker_cap.price_modifier /locker_cap.lib_constants.one_hundred_percent
    }

    /// @notice Gets locker capacity
    /// @param the_locker The locker to get capacity for
    /// @param locker_cap The locker capability object
    /// @param _locker_target_address Locker target address
    /// @param _locker_reliability_factor Locker reliability factor
    /// @return Locker capacity
    public fun get_locker_capacity(
        locker_cap: &LockerCap,
        _locker_target_address: address,
    ): u256 {
        // Check if locker target address is not zero
        assert!(_locker_target_address != @0x0, ERROR_ZERO_ADDRESS);
        let the_locker = get_locker_from_mapping(locker_cap, _locker_target_address);

        let _locker_reliability_factor = get_reliability_factor(locker_cap, _locker_target_address);
        let locker_collateral_in_telebtc = (the_locker.collateral_token_locked_amount) * 
                                          (locker_cap.lib_constants.one_hundred_percent) * 
                                          (locker_cap.lib_constants.one_hundred_percent) / 
                                          ((locker_cap.collateral_ratio) * (_locker_reliability_factor));
        
        // unit is in satoshi 
        if (locker_collateral_in_telebtc > (the_locker.net_minted)) {
            locker_collateral_in_telebtc - (the_locker.net_minted)
        } else {
            0
        }
    }

    /// @notice Calculates maximum buyable collateral for a locker
    /// @param locker_target_address Locker target address
    /// @param locker_cap The locker capability object
    /// @param _price_of_one_unit_of_collateral Price of one unit of collateral
    /// @param _reliability_factor Reliability factor
    /// @return Maximum buyable collateral amount
    public fun maximum_buyable_collateral(
        locker_target_address: address,
        locker_cap: &mut LockerCap,
        _price_of_one_unit_of_collateral: u256,
        _reliability_factor: u256
    ): u256 {
        // Extract all values from locker_cap before getting mutable reference
        let upper_health_factor = locker_cap.lib_constants.upper_health_factor;
        let one_hundred_percent = locker_cap.lib_constants.one_hundred_percent;
        let liquidation_ratio = locker_cap.liquidation_ratio;
        let price_with_discount_ratio = locker_cap.price_with_discount_ratio;
        
        let telebtc_decimal: u8 = 8;
        let the_locker = get_mut_locker_from_mapping(locker_cap, locker_target_address);
        let antecedent = ((upper_health_factor ) * 
                          (the_locker.net_minted ) * 
                          (liquidation_ratio ) * 
                          (_reliability_factor ) * 
                          (std::u256::pow(10, 8))) / (one_hundred_percent) - 
                        ((the_locker.collateral_token_locked_amount) * 
                         (_price_of_one_unit_of_collateral) * 
                         (std::u256::pow(10, telebtc_decimal)));
        
        let consequent = ((upper_health_factor) * 
                          (liquidation_ratio) * 
                          (_reliability_factor) * 
                          (_price_of_one_unit_of_collateral) * 
                          (price_with_discount_ratio)) / 
                         ((one_hundred_percent) * (one_hundred_percent)) - 
                        ((_price_of_one_unit_of_collateral) * (std::u256::pow(10, telebtc_decimal)));
        
        (antecedent / consequent)
    }

    // ============================================================================
    // EVENT EMITTER FUNCTIONS
    // ============================================================================

    /// @notice Emits MintByLockerEvent
    /// @dev Centralized event emission for TeleBTC minting events by lockers
    /// @param locker_target_address Target address of the locker that performed the mint
    /// @param receiver Address of the receiver of the minted TeleBTC
    /// @param minted_amount Amount of TeleBTC minted
    /// @param locker_fee Fee charged by the locker for the minting operation
    /// @param minting_time Timestamp when the minting occurred
    public(package) fun emit_mint_by_locker_event(
        locker_target_address: address,
        receiver: address,
        minted_amount: u256,
        locker_fee: u256,
        minting_time: u64
    ) {
        event::emit(MintByLockerEvent {
            locker_target_address,
            receiver,
            minted_amount,
            locker_fee,
            minting_time,
        });
    }

    /// @notice Emits BurnByLockerEvent
    /// @dev Centralized event emission for TeleBTC burning events by lockers
    /// @param locker_target_address Target address of the locker that performed the burn
    /// @param burnt_amount Amount of TeleBTC burnt
    /// @param locker_fee Fee charged by the locker for the burning operation
    /// @param burning_time Timestamp when the burning occurred
    public(package) fun emit_burn_by_locker_event(
        locker_target_address: address,
        burnt_amount: u256,
        locker_fee: u256,
        burning_time: u64
    ) {
        event::emit(BurnByLockerEvent {
            locker_target_address,
            burnt_amount,
            locker_fee,
            burning_time,
        });
    }

    /// @notice Emits LockerSlashedEvent
    /// @param locker_target_address The locker target address
    /// @param reward_amount The reward amount
    /// @param reward_recipient The reward recipient
    /// @param amount The amount
    /// @param recipient The recipient
    /// @param slashed_collateral_amount The slashed collateral amount
    /// @param slash_time The slash time
    /// @param is_for_cc_burn Whether it's for CC burn
    public(package) fun emit_locker_slashed_event(
        locker_target_address: address,
        reward_amount: u256,
        reward_recipient: address,
        amount: u256,
        recipient: address,
        slashed_collateral_amount: u256,
        slash_time: u64,
        is_for_cc_burn: bool
    ) {
        event::emit(LockerSlashedEvent {
            locker_target_address,
            reward_amount,
            reward_recipient,
            amount,
            recipient,
            slashed_collateral_amount,
            slash_time,
            is_for_cc_burn,
        });
    }

    /// @notice Emits LockerLiquidatedEvent
    /// @param locker_target_address The locker target address
    /// @param liquidator_address The liquidator address
    /// @param collateral_amount The collateral amount
    /// @param telebtc_amount The TeleBTC amount
    /// @param liquidate_time The liquidate time
    public(package) fun emit_locker_liquidated_event(
        locker_target_address: address,
        liquidator_address: address,
        collateral_amount: u256,
        telebtc_amount: u256,
        liquidate_time: u64
    ) {
        event::emit(LockerLiquidatedEvent {
            locker_target_address,
            liquidator_address,
            collateral_amount,
            telebtc_amount,
            liquidate_time,
        });
    }

    /// @notice Emits LockerSlashedCollateralSoldEvent
    /// @param locker_target_address The locker target address
    /// @param buyer_address The buyer address  
    /// @param slashing_amount The slashing amount
    /// @param telebtc_amount The TeleBTC amount
    /// @param slashing_time The slashing time
    public(package) fun emit_locker_slashed_collateral_sold_event(
        locker_target_address: address,
        buyer_address: address,
        slashing_amount: u256,
        telebtc_amount: u256,
        slashing_time: u64
    ) {
        event::emit(LockerSlashedCollateralSoldEvent {
            locker_target_address,
            buyer_address,
            slashing_amount,
            telebtc_amount,
            slashing_time,
        });
    }

    /// @notice Emits EmergencyWithdrawEvent
    /// @param amount The amount withdrawn
    /// @param admin The admin address
    /// @param epoch The epoch
    public(package) fun emit_emergency_withdraw_event(
        amount: u256,
        admin: address,
        epoch: u64
    ) {
        event::emit(EmergencyWithdrawEvent {
            amount,
            admin,
            epoch,
        });
    }

    /// @notice Emits DepositCollateralEvent
    /// @param amount The amount deposited
    /// @param depositor The depositor address
    /// @param epoch The epoch
    public(package) fun emit_deposit_collateral_event(
        amount: u256,
        depositor: address,
        epoch: u64
    ) {
        event::emit(DepositCollateralEvent {
            amount,
            depositor,
            epoch,
        });
    }

    /// @notice Emits WithdrawCollateralEvent
    /// @param amount The amount withdrawn
    /// @param withdrawer The withdrawer address
    /// @param epoch The epoch
    public(package) fun emit_withdraw_collateral_event(
        amount: u256,
        withdrawer: address,
        epoch: u64
    ) {
        event::emit(WithdrawCollateralEvent {
            amount,
            withdrawer,
            epoch,
        });
    }

    /// @notice Emits RequestAddLockerEvent
    /// @param locker_target_address Target address for the locker
    /// @param locker_locking_script Locker locking script
    public(package) fun emit_request_add_locker_event(
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
    ) {
        event::emit(RequestAddLockerEvent {
            locker_target_address,
            locker_locking_script,
            collateral_token_locked_amount,
        });
    }

    /// @notice Emits RevokeAddLockerRequestEvent
    /// @param locker_target_address The locker target address
    /// @param locker_locking_script The locker locking script
    /// @param collateral_token_locked_amount The amount of collateral locked
    public(package) fun emit_revoke_add_locker_request_event(
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
    ) {
        event::emit(RevokeAddLockerRequestEvent {
            locker_target_address,
            locker_locking_script,
            collateral_token_locked_amount,
        });
    }

    /// @notice Emits RequestInactivateLockerEvent
    /// @param locker_target_address The locker target address
    /// @param inactivation_timestamp The inactivation timestamp
    /// @param locker_locking_script The locker locking script
    /// @param collateral_token_locked_amount The amount of collateral locked
    /// @param net_minted The net minted amount
    public(package) fun emit_request_inactivate_locker_event(
        locker_target_address: address,
        inactivation_timestamp: u64,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
        net_minted: u256,
    ) {
        event::emit(RequestInactivateLockerEvent {
            locker_target_address,
            inactivation_timestamp,
            locker_locking_script,
            collateral_token_locked_amount,
            net_minted,
        });
    }

    /// @notice Emits ActivateLockerEvent
    /// @param locker_target_address The locker target address
    /// @param locker_locking_script The locker locking script
    /// @param collateral_token_locked_amount The amount of collateral locked
    /// @param net_minted The net minted amount
    public(package) fun emit_activate_locker_event(
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
        net_minted: u256,
    ) {
        event::emit(ActivateLockerEvent {
            locker_target_address,
            locker_locking_script,
            collateral_token_locked_amount,
            net_minted,
        });
    }

    /// @notice Emits LockerAddedEvent
    /// @param locker_target_address The locker target address
    /// @param locker_locking_script The locker locking script  
    /// @param collateral_token_locked_amount The amount of collateral locked
    /// @param reliability_factor The reliability factor
    /// @param adding_time The adding time
    public(package) fun emit_locker_added_event(
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_locked_amount: u256,
        reliability_factor: u256,
        adding_time: u64,
    ) {
        event::emit(LockerAddedEvent {
            locker_target_address,
            locker_locking_script,
            collateral_token_locked_amount,
            reliability_factor,
            adding_time,
        });
    }

    /// @notice Emits LockerRemovedEvent
    /// @param locker_target_address The locker target address
    /// @param locker_locking_script The locker locking script
    /// @param collateral_token_unlocked_amount The amount of collateral unlocked
    public(package) fun emit_locker_removed_event(
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        collateral_token_unlocked_amount: u256,
    ) {
        event::emit(LockerRemovedEvent {
            locker_target_address,
            locker_locking_script,
            collateral_token_unlocked_amount,
        });
    }

    /// @notice Emits CollateralAddedEvent
    /// @param locker_target_address The locker target address
    /// @param added_collateral The amount of collateral added
    /// @param total_collateral The total collateral amount
    /// @param adding_time The adding time
    public(package) fun emit_collateral_added_event(
        locker_target_address: address,
        added_collateral: u256,
        total_collateral: u256,
        adding_time: u64,
    ) {
        event::emit(CollateralAddedEvent {
            locker_target_address,
            added_collateral,
            total_collateral,
            adding_time,
        });
    }

    /// @notice Emits CollateralRemovedEvent
    /// @dev Centralized event emission for collateral removal events
    /// @param locker_target_address Target address of the locker
    /// @param removed_amount Amount of collateral removed
    /// @param total_collateral_amount Total amount of collateral after removal
    /// @param timestamp Timestamp when the collateral was removed
    public(package) fun emit_collateral_removed_event(
        locker_target_address: address,
        removed_amount: u256,
        total_collateral_amount: u256,
        removing_time: u64,
    ) {
        event::emit(CollateralRemovedEvent {
            locker_target_address,
            removed_amount,
            total_collateral_amount,
            removing_time,
        });
    }

    // ============================================================================
    // ADMIN SETTER FUNCTIONS
    // ============================================================================

    /// @notice Sets locker percentage fee
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param _locker_percentage_fee New locker percentage fee
    /// @param ctx Transaction context
    public fun set_locker_percentage_fee(
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        _locker_percentage_fee: u256,
        ctx: &mut TxContext
    ) {
        // Check admin permissions
        assert_admin(admin_cap, locker_cap, ctx);
        
        // Check if fee is not greater than max locker fee
        assert!(_locker_percentage_fee <= MAX_LOCKER_FEE, ERROR_INVALID_VALUE);
        
        // Emit event for fee change
        event::emit(NewLockerPercentageFeeEvent {
            old_locker_percentage_fee: locker_cap.locker_percentage_fee,
            new_locker_percentage_fee: _locker_percentage_fee,
        });
        
        // Update the locker percentage fee
        locker_cap.locker_percentage_fee = _locker_percentage_fee;
    }

    /// @notice Sets price with discount ratio
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param _price_with_discount_ratio New price with discount ratio
    /// @param ctx Transaction context
    public fun set_price_with_discount_ratio(
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        _price_with_discount_ratio: u256,
        ctx: &mut TxContext
    ) {
        // Check admin permissions
        assert_admin(admin_cap, locker_cap, ctx);
        
        // Check if ratio is not greater than one hundred percent
        assert!(_price_with_discount_ratio <= ONE_HUNDRED_PERCENT, ERROR_INVALID_VALUE);
        
        // Emit event for ratio change
        event::emit(NewPriceWithDiscountRatioEvent {
            old_price_with_discount_ratio: locker_cap.price_with_discount_ratio,
            new_price_with_discount_ratio: _price_with_discount_ratio,
        });
        
        // Update the price with discount ratio
        locker_cap.price_with_discount_ratio = _price_with_discount_ratio;
    }

    /// @notice Sets locker reliability factor
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param _locker_target_address Locker target address
    /// @param _reliability_factor New reliability factor
    /// @param ctx Transaction context
    public fun set_locker_reliability_factor(
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        _locker_target_address: address,
        _reliability_factor: u256,
        ctx: &mut TxContext
    ) {
        // Check admin permissions
        assert_admin(admin_cap, locker_cap, ctx);
        
        // Check if reliability factor is not zero
        assert!(_reliability_factor != 0, ERROR_ZERO_VALUE);
        
        // Get the old reliability factor for the event
        let old_reliability_factor = if (table::contains(&locker_cap.locker_reliability_factor, _locker_target_address)) {
            *table::borrow(&locker_cap.locker_reliability_factor, _locker_target_address)
        } else {
            0
        };
        
        // Update the locker reliability factor (overwrites if key exists)
        if (table::contains(&locker_cap.locker_reliability_factor, _locker_target_address)) {
            table::remove(&mut locker_cap.locker_reliability_factor, _locker_target_address);
        };
        table::add(&mut locker_cap.locker_reliability_factor, _locker_target_address, _reliability_factor);
        
        // Emit event for reliability factor change
        event::emit(NewReliabilityFactorEvent {
            locker_target_address: _locker_target_address,
            old_reliability_factor,
            new_reliability_factor: _reliability_factor,
        });
    }

    /// @notice Sets collateral ratio
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param _collateral_ratio New collateral ratio
    /// @param ctx Transaction context
    public fun set_collateral_ratio(
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        _collateral_ratio: u256,
        ctx: &mut TxContext
    ) {
        // Check admin permissions
        assert_admin(admin_cap, locker_cap, ctx);
        
        // Check if collateral ratio is greater than liquidation ratio
        assert!(_collateral_ratio > locker_cap.liquidation_ratio, ERROR_INVALID_VALUE);
        
        // Emit event for collateral ratio change
        event::emit(NewCollateralRatioEvent {
            old_collateral_ratio: locker_cap.collateral_ratio,
            new_collateral_ratio: _collateral_ratio,
        });
        
        // Update the collateral ratio
        locker_cap.collateral_ratio = _collateral_ratio;
    }

    /// @notice Sets liquidation ratio
    /// @param admin_cap The admin capability object
    /// @param locker_cap The locker capability object
    /// @param _liquidation_ratio New liquidation ratio
    /// @param ctx Transaction context
    public fun set_liquidation_ratio(
        admin_cap: &LockerAdminCap,
        locker_cap: &mut LockerCap,
        _liquidation_ratio: u256,
        ctx: &mut TxContext
    ) {
        // Check admin permissions
        assert_admin(admin_cap, locker_cap, ctx);
        
        // Check if collateral ratio is greater than liquidation ratio
        assert!(locker_cap.collateral_ratio > _liquidation_ratio, ERROR_INVALID_VALUE);
        
        // Emit event for liquidation ratio change
        event::emit(NewLiquidationRatioEvent {
            old_liquidation_ratio: locker_cap.liquidation_ratio,
            new_liquidation_ratio: _liquidation_ratio,
        });
        
        // Update the liquidation ratio
        locker_cap.liquidation_ratio = _liquidation_ratio;
    }

    /// @notice Sets the inactivation delay
    /// @param locker_cap The locker capability object
    /// @param admin_cap The admin capability object
    /// @param _inactivation_delay The inactivation delay in seconds
    /// @param ctx Transaction context
    /// @return The inactivation delay in seconds
    public fun set_inactivation_delay(locker_cap: &mut LockerCap,admin_cap: &LockerAdminCap, _inactivation_delay: u64, ctx: &mut TxContext) {
        // Check admin permissions
        assert_admin(admin_cap, locker_cap, ctx);
        locker_cap.inactivation_delay = _inactivation_delay;
    }

    // ============================================================================
    // SECURE COIN MANAGEMENT FUNCTIONS (ONLY ACCESSIBLE BY LOCKERCORE)
    // ============================================================================

    /// @notice Adds WBTC collateral to the locker contract (only lockercore can call)
    /// @param locker_cap The locker capability object
    /// @param coins The WBTC coins to add
    public(package) fun add_wbtc_collateral_to_contract(locker_cap: &mut LockerCap, coins: Coin<WBTC>) {
        // Add WBTC coins to the vault
        let coin_value = coin::value(&coins) as u256;
        balance::join(&mut locker_cap.wbtc_vault, coin::into_balance(coins));
        
        // Emit deposit event
        event::emit(DepositCollateralEvent {
            amount: coin_value as u256,
            depositor: @0x0, // placeholder for telebtc address
            epoch: 0, // placeholder for epoch
        });
    }

    /// @notice Removes WBTC collateral from the locker contract (only lockercore can call)
    /// @param locker_cap The locker capability object
    /// @param amount Amount of WBTC to remove from the vault
    /// @param ctx Transaction context
    /// @return The removed WBTC coins
    public(package) fun remove_wbtc_collateral_from_contract(locker_cap: &mut LockerCap, amount: u256, ctx: &mut TxContext): Coin<WBTC> {
        // Check if vault has sufficient balance
        assert!((balance::value(&locker_cap.wbtc_vault) as u256) >= amount, ERROR_INSUFFICIENT_VAULT_BALANCE);
        
        // Split coins from vault
        let coins = coin::from_balance(balance::split(&mut locker_cap.wbtc_vault, amount as u64), ctx);
        
        // Emit withdraw event
        event::emit(WithdrawCollateralEvent {
            amount,
            withdrawer: @0x0, // placeholder for telebtc address
            epoch: 0, // placeholder for epoch
        });
        
        coins
    }

    
    // Test only functions, will need to be removed in real deployment
    /// @notice Sets net minted amount
    /// @param locker The locker to update
    /// @param new_amount New net minted amount
    public fun set_net_minted_admin(admin_cap: &LockerAdminCap, locker_cap: &mut LockerCap, new_amount: u64,locker_target_address: address, ctx: &mut TxContext) {
        assert_admin(admin_cap, locker_cap, ctx);
        let locker = table::borrow_mut(&mut locker_cap.lockers_mapping, locker_target_address);
        locker.net_minted = new_amount as u256;
    }
    /// Setters for mock state
    public entry fun set_is_locker(cap: &mut LockerCap, value: bool) {
        cap.is_locker = value;
    }
    public entry fun set_locker_target_address(cap: &mut LockerCap, addr: address) {
        cap.locker_target_address = addr;
    }
    public entry fun set_burn_return(cap: &mut LockerCap, amount: u64) {
        cap.burn_return = amount;
    }
    public entry fun set_slash_idle_locker_return(cap: &mut LockerCap, value: bool) {
        cap.slash_idle_locker_return = value;
    }
    public entry fun set_slash_thief_locker_return(cap: &mut LockerCap, value: bool) {
        cap.slash_thief_locker_return = value;
    }
    public entry fun set_price_modifier(cap: &mut LockerCap, value: u256) {
        cap.price_modifier = value;
    }

    /// Use the cap for mock logic
    public fun is_locker_mock(_locking_script: vector<u8>, cap: &LockerCap): bool {
        cap.is_locker
    }
    public fun get_locker_target_address_mock(_locking_script: vector<u8>, cap: &LockerCap): address {
        cap.locker_target_address
    }
    /// Mint tokens for a locker
    public fun mint_mock(
        _locking_script: vector<u8>,
        amount: u64,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        ctx: &mut TxContext
    ): (Coin<TELEBTC>, address) {
        // Call the telebtc mint function and return the minted coins
        let coins = telebtc::mint(telebtc_cap, treasury_cap, amount, ctx);
        let locker_address = @0x0000000000000000000000000000000000000000000000000000000000000003; // just a place holder, will implement later when doing the locker contract
        (coins, locker_address)
    }

    public fun burn_mock(
        _locker_locking_script: vector<u8>, 
        coins: Coin<TELEBTC>, 
        telebtc_cap: &mut TeleBTCCap, 
        treasury_cap: &mut TreasuryCap<TELEBTC>, 
        ctx: &mut TxContext,
        _cap: &LockerCap
    ) {
        // Use cap.burn_return if needed for test assertions
        telebtc::burn(telebtc_cap, treasury_cap, coins, ctx);
    }

    /// Placeholder for slashing idle locker
    public fun slash_idle_locker_mock(
        locker_target_address: address,
        slasher_reward: u64,
        slasher_address: address,
        total_amount: u64,
        user_address: address,
        cap: &LockerCap
    ): bool {
        cap.slash_idle_locker_return
    }
    public fun slash_thief_locker_mock(
        locker_target_address: address,
        slasher_reward: u64,
        slasher_address: address,
        total_amount: u64,
        cap: &LockerCap
    ): bool {
        cap.slash_thief_locker_return
    }
} 