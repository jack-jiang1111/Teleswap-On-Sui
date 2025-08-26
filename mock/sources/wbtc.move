#[allow(unused)]
// a mock version of wbtc, only for testing
// it is used to test the locker system
// it is not used in production
module teleswap::wbtc {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;

    // Error codes
    const EZERO_VALUE: u64 = 404;

    public struct WBTC has drop {}


    fun init(witness: WBTC, ctx: &mut TxContext) {
        // Create the coin type
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            8, // 8 decimals like real WBTC
            b"Wrapped Bitcoin",    // name
            b"WBTC",               // symbol
            b"Wrapped Bitcoin for testing", // description
            std::option::none(),   // no icon URL
            ctx
        );

        // Share the treasury cap so anyone can mint and burn
        transfer::public_share_object(treasury_cap);
        // Make the metadata immutable
        transfer::public_freeze_object(metadata);
    }

    // Minting function - anyone can mint for testing
    public fun mint(
        treasury_cap: &mut TreasuryCap<WBTC>,
        amount: u64,
        ctx: &mut TxContext
    ): Coin<WBTC> {
        assert!(amount > 0, EZERO_VALUE);
        coin::mint(treasury_cap, amount, ctx)
    }

    // Burning function - anyone can burn for testing
    public fun burn(
        treasury_cap: &mut TreasuryCap<WBTC>,
        coins: Coin<WBTC>,
        ctx: &mut TxContext
    ): bool {
        let amount = coin::value(&coins);
        assert!(amount > 0, EZERO_VALUE);
        let burned_amount = coin::burn(treasury_cap, coins);
        true
    }
} 