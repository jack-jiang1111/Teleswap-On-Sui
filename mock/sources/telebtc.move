#[allow(unused)]
module teleswap::telebtc {
    // This is a mock contract for the telebtc contract
    // any address can mint and burn telebtc
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::table::{Self, Table};
    use sui::package::{Self, UpgradeCap};
    use sui::event;


    // Error codes
    const ENOT_OWNER: u64 = 400;
    const ENOT_BLACKLISTER: u64 = 401;
    const EALREADY_HAS_ROLE: u64 = 402;
    const EDOES_NOT_HAVE_ROLE: u64 = 403;
    const EZERO_VALUE: u64 = 404;
    const EBLACKLISTED: u64 = 405;
    const EMINT_LIMIT_EXCEEDED: u64 = 406;
    const EEPOCH_MINT_LIMIT_REACHED: u64 = 407;
    const EINVALID_ADMIN: u64 = 408;


    // Constants
    const INITIAL_MINT_LIMIT: u64 = 100000000000; // 10^11

    public struct TELEBTC has drop {}

    /// Admin control structure for the contract
    /// Stores owner address
    public struct TELEBTC_ADMIN has key, store {
        id: UID,
        owner: address
    }

    public struct TeleBTCCap has key,store {
        id: UID,
        blacklisters: Table<address, bool>,
        blacklisted: Table<address, bool>,
        max_mint_limit: u64,
        last_mint_limit: u64,
        epoch_length: u64,
        last_epoch: u64,
        adminAddress: address,  // Store admin address for verification
    }

    public struct MintEvent has copy, drop {
        amount: u64
    }

    public struct BurnEvent has copy, drop {
        amount: u64
    }

    public struct BlacklistEvent has copy, drop {
        account: address
    }

    public struct UnblacklistEvent has copy, drop {
        account: address
    }

    public struct RoleEvent has copy, drop {
        account: address,
        role_type: u8, // 1: minter, 2: burner, 3: blacklister
        is_added: bool
    }

    fun init(witness: TELEBTC, ctx: &mut TxContext) {
        // Create and transfer the admin object to the sender
        transfer::transfer(TELEBTC_ADMIN { 
            id: object::new(ctx),
            owner: tx_context::sender(ctx)
        }, tx_context::sender(ctx));

        let cap = TeleBTCCap {
            id: object::new(ctx),
            blacklisters: table::new(ctx),
            blacklisted: table::new(ctx),
            max_mint_limit: INITIAL_MINT_LIMIT,
            last_mint_limit: INITIAL_MINT_LIMIT,
            epoch_length: 1, // in sui mainnet, each epoch = 24hours
            last_epoch: 0,
            adminAddress: tx_context::sender(ctx),
        };

        // Create the coin type
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            8,
            b"TeleBTC",            // name
            b"tBTC",               // symbol
            b"Teleswap bitcoin", // description
            std::option::none(),   // no icon URL
            ctx
        );

        // Share both the treasury cap and cap object so any minter can mint
        transfer::public_share_object(treasury_cap);
        // Make the metadata immutable and transfer it
        transfer::public_freeze_object(metadata);
        //transfer::public_transfer(metadata, tx_context::sender(ctx));
        // Share cap object
        transfer::public_share_object(cap);
    }

    // Role management functions
    public fun add_blacklister(cap: &mut TeleBTCCap, admin: &TELEBTC_ADMIN, new_blacklister: address, ctx: &mut TxContext) {
        assert!(admin.owner == cap.adminAddress, EINVALID_ADMIN);
        if(table::contains(&cap.blacklisters, new_blacklister)) {
            if(*table::borrow(&cap.blacklisters, new_blacklister)) {
                // already a blacklister
                abort EALREADY_HAS_ROLE
            } else {
                // set the table to true
                *table::borrow_mut(&mut cap.blacklisters, new_blacklister) = true;
            }
        } else {
            table::add(&mut cap.blacklisters, new_blacklister, true);
        };
        event::emit(RoleEvent { account: new_blacklister, role_type: 3, is_added: true });
    }

    public fun remove_blacklister(cap: &mut TeleBTCCap, admin: &TELEBTC_ADMIN, blacklister: address) {
        assert!(admin.owner == cap.adminAddress, EINVALID_ADMIN);
        if(table::contains(&cap.blacklisters, blacklister) && *table::borrow(&cap.blacklisters, blacklister)) {
            *table::borrow_mut(&mut cap.blacklisters, blacklister) = false;
        } else {
            abort EDOES_NOT_HAVE_ROLE
        };
        event::emit(RoleEvent { account: blacklister, role_type: 3, is_added: false });
    }

    // Blacklist management
    public fun blacklist(cap: &mut TeleBTCCap, target: address, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&cap.blacklisters, sender) && *table::borrow(&cap.blacklisters, sender), ENOT_BLACKLISTER);
        if(table::contains(&cap.blacklisted, target)) {
            if(*table::borrow(&cap.blacklisted, target)) {
                abort EALREADY_HAS_ROLE; // already blacklisted
            } else {
                *table::borrow_mut(&mut cap.blacklisted, target) = true;
            }
        } else {
            table::add(&mut cap.blacklisted, target, true);
        };
        event::emit(BlacklistEvent { account: target });
    }

    public fun unblacklist(cap: &mut TeleBTCCap, target: address, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&cap.blacklisters, sender) && *table::borrow(&cap.blacklisters, sender), ENOT_BLACKLISTER);
        if(table::contains(&cap.blacklisted, target) && *table::borrow(&cap.blacklisted, target)) {
            *table::borrow_mut(&mut cap.blacklisted, target) = false;
        } else {
            abort EDOES_NOT_HAVE_ROLE;
        };  
        event::emit(UnblacklistEvent { account: target });
    }

    // Minting and burning
    public fun mint(
        cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        amount: u64,
        ctx: &mut TxContext
    ): Coin<TELEBTC> {
        assert!(amount > 0, EZERO_VALUE);
        assert!(amount <= cap.max_mint_limit, EMINT_LIMIT_EXCEEDED);
        assert!(check_and_reduce_mint_limit(cap, amount, ctx), EEPOCH_MINT_LIMIT_REACHED);
        
        let coins = coin::mint(treasury_cap, amount, ctx);
        event::emit(MintEvent { amount });
        coins
    }

    public fun burn(
        cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        coins: Coin<TELEBTC>,
        ctx: &mut TxContext
    ):bool {
        let amount = coin::value(&coins);
        
        let burned_amount = coin::burn(treasury_cap, coins);
        event::emit(BurnEvent { amount: burned_amount });
        true
    }

    // Helper functions
    fun check_and_reduce_mint_limit(cap: &mut TeleBTCCap, amount: u64, ctx: &TxContext): bool {
        let current_epoch = tx_context::epoch(ctx);

        if (current_epoch == cap.last_epoch) {
            if (amount > cap.last_mint_limit) {
                return false;
            };
            cap.last_mint_limit = cap.last_mint_limit - amount;
        } else {
            cap.last_epoch = current_epoch;
            if (amount > cap.max_mint_limit) {
                return false;
            };
            cap.last_mint_limit = cap.max_mint_limit - amount;
        };

        true
    }

    // Admin functions
    /// Renounces admin ownership by transferring control to zero address
    public entry fun renounce_admin_ownership(
        cap: &mut TeleBTCCap,
        admin: TELEBTC_ADMIN,
        ctx: &TxContext
    ) {
        // Verify caller is admin
        assert!(cap.adminAddress == admin.owner, EINVALID_ADMIN);
        
        // Transfer admin control to zero address
        transfer::public_transfer(admin, @0x0);
    }

    /**
     * @dev change maximum mint limit per epoch.
     */
    public entry fun set_max_mint_limit(
        cap: &mut TeleBTCCap,
        admin: &TELEBTC_ADMIN,
        new_limit: u64
    ) {
        assert!(admin.owner == cap.adminAddress, EINVALID_ADMIN);
        cap.max_mint_limit = new_limit;
        // emit events NewMintLimit(maxMintLimit, _mintLimit);
    }

    /**
     * @dev change blocks number per epoch.
     */
    public entry fun set_epoch_length(
        cap: &mut TeleBTCCap,
        admin: &TELEBTC_ADMIN,
        new_length: u64
    ) {
        assert!(admin.owner == cap.adminAddress, EINVALID_ADMIN);
        assert!(new_length > 0, EZERO_VALUE);
        cap.epoch_length = new_length;
        // emit events NewEpochLength(epochLength, _length);
    }

    // helper function to check if an address is a blacklister
    public fun is_blacklister(cap: &TeleBTCCap, address: address): bool {
        if (table::contains(&cap.blacklisters, address)) {
            *table::borrow(&cap.blacklisters, address)
        } else {
            false
        }
    }

    // helper function to check if an address is blacklisted
    public fun is_blacklisted(cap: &TeleBTCCap, address: address): bool {
        if (table::contains(&cap.blacklisted, address)) {
            *table::borrow(&cap.blacklisted, address)
        } else {
            false
        }
    }
    /// Returns a zero value TeleBTC coin
    /// This is useful for testing and when you need to provide a coin with zero value
    public fun zero_coin(ctx: &mut TxContext): Coin<TELEBTC> {
        coin::zero(ctx)
    }
} 