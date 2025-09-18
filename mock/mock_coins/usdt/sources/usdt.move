// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

module bridged_usdt::usdt {
    use std::option;

    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};

    struct USDT has drop {}

    const DECIMAL: u8 = 6;
    const EZERO_VALUE: u64 = 404;
    fun init(otw: USDT, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            otw,
            DECIMAL,
            b"USDT",
            b"Tether",
            b"Bridged Tether token",
            option::none(),
            ctx
        );
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury_cap, tx_context::sender(ctx));
    }
        // Minting function - anyone can mint for testing
    public fun mint(
        treasury_cap: &mut TreasuryCap<USDT>,
        amount: u64,
        ctx: &mut TxContext
    ): Coin<USDT> {
        assert!(amount > 0, EZERO_VALUE);
        coin::mint(treasury_cap, amount, ctx)
    }

    // Burning function - anyone can burn for testing
    public fun burn(
        treasury_cap: &mut TreasuryCap<USDT>,
        coins: Coin<USDT>,
    ): bool {
        let amount = coin::value(&coins);
        assert!(amount > 0, EZERO_VALUE);
        coin::burn(treasury_cap, coins);
        true
    }
}