#[allow(unused)]
module teleswap::dummy_locker {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::balance::{Self, Balance};
    use teleswap::telebtc_mock::{Self, TeleBTCCap, TELEBTC_MOCK};

    /// Error codes
    const ENOT_LOCKER: u64 = 1;
    const EINVALID_AMOUNT: u64 = 2;

    /// The DummyLocker struct that holds the state
    public struct DummyLocker has key {
        id: UID,
        // Add any additional fields needed for the locker state
    }

    /// Capability for managing the locker and holding mock state
    public struct DummyLockerCap has key, store {
        id: UID,
        is_locker: bool,
        locker_target_address: address,
        burn_return: u64,
        slash_idle_locker_return: bool,
        slash_thief_locker_return: bool,
    }

    /// Initialize the dummy locker module and publish DummyLockerCap
    fun init(ctx: &mut TxContext) {
        let cap = DummyLockerCap {
            id: object::new(ctx),
            is_locker: true,
            locker_target_address: @0x0,
            burn_return: 0,
            slash_idle_locker_return: true,
            slash_thief_locker_return: true,
        };
        transfer::share_object(cap);
    }

    /// Setters for mock state
    public entry fun set_is_locker(cap: &mut DummyLockerCap, value: bool) {
        cap.is_locker = value;
    }
    public entry fun set_locker_target_address(cap: &mut DummyLockerCap, addr: address) {
        cap.locker_target_address = addr;
    }
    public entry fun set_burn_return(cap: &mut DummyLockerCap, amount: u64) {
        cap.burn_return = amount;
    }
    public entry fun set_slash_idle_locker_return(cap: &mut DummyLockerCap, value: bool) {
        cap.slash_idle_locker_return = value;
    }
    public entry fun set_slash_thief_locker_return(cap: &mut DummyLockerCap, value: bool) {
        cap.slash_thief_locker_return = value;
    }

    /// Use the cap for mock logic
    public fun is_locker(_locking_script: vector<u8>, cap: &DummyLockerCap): bool {
        cap.is_locker
    }
    public fun get_locker_target_address(_locking_script: vector<u8>, cap: &DummyLockerCap): address {
        cap.locker_target_address
    }

    /// Mint tokens for a locker
    public fun mint(
        _locking_script: vector<u8>,
        amount: u64,
        locker_cap: &mut DummyLockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC_MOCK>,
        receiver: address,
        ctx: &mut TxContext
    ): (Coin<TELEBTC_MOCK>, address) {
        // Call the telebtc mint function and return the minted coins
        let coins = telebtc_mock::mint(telebtc_cap, treasury_cap, receiver, amount, ctx);
        let locker_address = @0x0000000000000000000000000000000000000000000000000000000000000003; // just a place holder, will implement later when doing the locker contract
        (coins, locker_address)
    }

    public fun burn(
        _locker_locking_script: vector<u8>, 
        coins: Coin<TELEBTC_MOCK>, 
        telebtc_cap: &mut TeleBTCCap, 
        treasury_cap: &mut TreasuryCap<TELEBTC_MOCK>, 
        ctx: &mut TxContext,
        _cap: &DummyLockerCap
    ) {
        // Use cap.burn_return if needed for test assertions
        telebtc_mock::burn(telebtc_cap, treasury_cap, coins, ctx);
    }

    /// Placeholder for slashing idle locker
    public fun slash_idle_locker(
        locker_target_address: address,
        slasher_reward: u64,
        slasher_address: address,
        total_amount: u64,
        user_address: address,
        cap: &DummyLockerCap
    ): bool {
        cap.slash_idle_locker_return
    }
    public fun slash_thief_locker(
        locker_target_address: address,
        slasher_reward: u64,
        slasher_address: address,
        total_amount: u64,
        cap: &DummyLockerCap
    ): bool {
        cap.slash_thief_locker_return
    }
} 