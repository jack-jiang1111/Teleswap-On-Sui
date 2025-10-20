#[allow(unused,deprecated_usage)]
module teleswap::dexconnector {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;

    use cetus_clmm::pool;
    use cetus_clmm::config::GlobalConfig;
    use std::type_name;
    
    // Import coin types
    use teleswap::telebtc::{Self, TELEBTC, TeleBTCCap};
    use bridged_btc::btc::BTC;
    use sui::sui::SUI;
    use bridged_usdc::usdc::USDC;
    use bridged_usdt::usdt::USDT;
    use sui::clock::Clock;
    use sui::balance::{Self, Balance};

    // Error codes
    const EZERO_ADDRESS: u64 = 421;
    const EINVALID_AMOUNT: u64 = 422;
    const EINVALID_PATH: u64 = 423;
    const ESWAP_FAILED: u64 = 424;
    const EINVALID_DEADLINE: u64 = 425;
    const EPOOL_NOT_FOUND: u64 = 426;
    const EINSUFFICIENT_LIQUIDITY: u64 = 427;
    const EUNSUPPORTED_PATH: u64 = 428;
    const EPOOL_NOT_INITIALIZED: u64 = 429;
    const EINVALID_INPUT_AMOUNT: u64 = 430;
    const ENOT_ENOUGH_COINS: u64 = 431;
    const EINVALID_TARGET_TOKEN: u64 = 432;
    const EINVALID_INPUT_LIST_LENGTH: u64 = 433;

    // Constants
    const MAX_SQRT_PRICE_X64: u128 = 79226673515401279992447579055;
    const MIN_SQRT_PRICE_X64: u128 = 4295048016;
    

    /// Emitted when a swap completes successfully.
    /// - user: transaction sender
    /// - input_token/output_token: type names of tokens
    /// - input_amount/output_amount: amounts swapped
    /// - timestamp: ms from clock
    public struct SwapExecuted has copy, drop {
        user: address,
        input_token: std::type_name::TypeName,
        output_token: std::type_name::TypeName,
        input_amount: u64,
        output_amount: u64,
        timestamp: u64,
    }

    /// Emitted when a swap attempt fails prior to completion.
    /// - user: transaction sender
    /// - input/output_token: token type names
    /// - input_amount: attempted input
    /// - reason: failure code
    /// - timestamp: ms from clock
    public struct SwapFailed has copy, drop {
        user: address,
        input_token: std::type_name::TypeName,
        output_token: std::type_name::TypeName,
        input_amount: u64,
        reason: vector<u8>,
        timestamp: u64,
    }

    /// Helper function to check if two types are the same
    /// This is used for generic type checking in Move
    fun is_same<T1, T2>(): bool {
        type_name::get<T1>() == type_name::get<T2>()
    }

    fun merge_and_split<T>(mut coins: vector<Coin<T>>, amount: u64, ctx: &mut TxContext): (Coin<T>, Coin<T>) {
        let merged_coin = merge_coins(coins, ctx);
        if(coin::value(&merged_coin) == 0) {
            // not this coin type, just return zero coins
            (merged_coin, coin::zero<T>(ctx))
        }
        else if(coin::value(&merged_coin) < amount) {
            // not enough coins, abort with error code ENOT_ENOUGH_COINS
            abort ENOT_ENOUGH_COINS
        }
        else{
            // enough coins, split the coin
            let (split_coin, remaining_coin) = split_coin(merged_coin, amount, ctx);
            (split_coin, remaining_coin)
        }
    }

    /// Helper function to merge all coins of a specific type into one
    fun merge_coins<T>(mut coins: vector<Coin<T>>, ctx: &mut TxContext): Coin<T> {
        if (std::vector::length(&coins) == 0) {
            // Consume the empty vector
            std::vector::destroy_empty(coins);
            coin::zero<T>(ctx)
        } else if (std::vector::length(&coins) == 1) {
            let result = std::vector::pop_back(&mut coins);
            // Consume the now-empty vector
            std::vector::destroy_empty(coins);
            result
        } else {
            let mut result = std::vector::pop_back(&mut coins);
            while (std::vector::length(&coins) > 0) {
                let next_coin = std::vector::pop_back(&mut coins);
                coin::join(&mut result, next_coin);
            };
            // Consume the now-empty vector
            std::vector::destroy_empty(coins);
            result
        }
    }

    /// Helper function to merge two coins
    fun merge_two_coins<T>(mut coin_a: Coin<T>, coin_b: Coin<T>, ctx: &mut TxContext): Coin<T> {
        coin::join(&mut coin_a, coin_b);
        coin_a
    }

    /// Helper function to split a coin and return the split amount and remaining coin
    fun split_coin<T>(mut coin: Coin<T>, amount: u64, ctx: &mut TxContext): (Coin<T>, Coin<T>) {
        let split_coin = coin::split(&mut coin, amount, ctx);
        (split_coin, coin)
    }

    /// Exact-in quote helper function
    /// Calculates the output amount for a given input amount using Cetus CLMM pool
    /// 
    /// Parameters:
    /// - p: Reference to the pool for the token pair
    /// - input_amount: Amount of INPUT_TOKEN provided
    /// - min_output_amount: Minimum acceptable output amount (for slippage protection)
    /// - a_to_b: Direction flag - true for INPUT_TOKEN->OUTPUT_TOKEN, false for OUTPUT_TOKEN->INPUT_TOKEN
    /// 
    /// Returns: (bool, u64) - (success_flag, output_amount)
    fun getOutputAmount<TOKEN_A, TOKEN_B>(
        p: &pool::Pool<TOKEN_A, TOKEN_B>,
        input_amount: u64,
        min_output_amount: u64,
        a_to_b: bool
    ): (bool, u64) {
        if (input_amount == 0) { return (false, 0) };
        let res = pool::calculate_swap_result<TOKEN_A, TOKEN_B>(
            p,
            a_to_b,
            /* by_amount_in */ true,
            input_amount,
        );
        let out = pool::calculated_swap_result_amount_out(&res);
        let exceeded = pool::calculated_swap_result_is_exceed(&res); // if the swap exceed the pool boundary
        if (out < min_output_amount || exceeded) { return (false, out) };
        (true, out)
    }

    /// Get quote for selling TELEBTC to target token
    /// This function calculates how much of the target token you can get for a given amount of TELEBTC
    /// Supports multi-hop swaps through WBTC and USDC as intermediate tokens
    /// 
    /// Parameters:
    /// - pool_usdc_sui: Pool for USDC-SUI trading
    /// - pool_usdc_usdt: Pool for USDC-USDT trading  
    /// - pool_usdc_wbtc: Pool for USDC-WBTC trading
    /// - pool_telebtc_wbtc: Pool for TELEBTC-WBTC trading
    /// - input_amount: Amount of TELEBTC to sell
    /// - min_output_amount: Minimum acceptable output amount
    /// 
    /// Returns: (bool, u64) - (success_flag, output_amount)
    public fun getQuoteSellTelebtc<TargetToken>(
        pool_usdc_sui: &pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &pool::Pool<TELEBTC, BTC>,
        input_amount: u64, // amount of telebtc provided
        min_output_amount: u64, // min amount of target token to get
    ): (bool, u64) {
        if (is_same<TargetToken, BTC>()) {
            // Direct swap: TELEBTC -> WBTC
            return getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, input_amount, min_output_amount, true)
        };
        if (is_same<TargetToken, USDC>()) {
            // Two-hop swap: TELEBTC -> WBTC -> USDC
            let (status1, out1) = getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            return getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, min_output_amount, false);
        };
        if (is_same<TargetToken, SUI>()) {
            // Three-hop swap: TELEBTC -> WBTC -> USDC -> SUI
            let (status1, out1) = getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            if (!status2) { return (false, 0) };
            return getOutputAmount<USDC, SUI>(pool_usdc_sui, out2, min_output_amount, true);
        };
        if (is_same<TargetToken, USDT>()) {
            // Three-hop swap: TELEBTC -> WBTC -> USDC -> USDT
            let (status1, out1) = getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            if (!status2) { return (false, 0) };
            return getOutputAmount<USDC, USDT>(pool_usdc_usdt, out2, min_output_amount, true);
        };
        (false, 0)
    }

    /// Get quote for buying TELEBTC with input token
    /// This function calculates how much TELEBTC you can get for a given amount of input token
    /// Used in burn router functions for reverse swaps
    /// 
    /// Parameters:
    /// - pool_usdc_sui: Pool for USDC-SUI trading
    /// - pool_usdc_usdt: Pool for USDC-USDT trading
    /// - pool_usdc_wbtc: Pool for USDC-WBTC trading  
    /// - pool_telebtc_wbtc: Pool for TELEBTC-WBTC trading
    /// - input_amount: Amount of input token to spend
    /// - min_output_amount: Minimum acceptable TELEBTC amount
    /// 
    /// Returns: (bool, u64) - (success_flag, output_amount)
    public fun getQuoteBuyTelebtc<InputToken>(
        pool_usdc_sui: &pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &pool::Pool<TELEBTC, BTC>,
        input_amount: u64, // amount of input token provided
        min_output_amount: u64, // min amount of telebtc to get
    ): (bool, u64) {
        if (is_same<InputToken, BTC>()) {
            // Direct swap: BTC -> TELEBTC
            return getOutputAmount<TELEBTC,BTC>(pool_telebtc_wbtc, input_amount, min_output_amount, false);
        };
        if (is_same<InputToken, USDC>()) {
            // Two-hop swap: USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            return getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, out1, min_output_amount, false);
        };
        if (is_same<InputToken, SUI>()) {
            // Three-hop swap: SUI -> USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, SUI>(pool_usdc_sui, input_amount, 0, false);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, true);
            if (!status2) { return (false, 0) };
            return getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, out2, min_output_amount, false);
        };
        if (is_same<InputToken, USDT>()) {
            // Three-hop swap: USDT -> USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, USDT>(pool_usdc_usdt, input_amount, 0, false);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            if (!status2) { return (false, 0) };
            return getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, out2, min_output_amount, false);
        };
        (false, 0)
    }

    /// Generic flash swap function using Cetus CLMM
    /// Performs a flash swap between two token types with automatic amount calculation
    /// 
    /// Parameters:
    /// - config: Global configuration for Cetus CLMM
    /// - pool: Reference to the pool for the token pair
    /// - coin_a: First token coin
    /// - coin_b: Second token coin  
    /// - a2b: Direction flag - true for coin_a->coin_b, false for coin_b->coin_a
    /// - clock: Sui clock for transaction timing
    /// - ctx: Transaction context
    /// 
    /// Returns: (Coin<CoinTypeA>, Coin<CoinTypeB>) - Updated coins after swap
    fun swap<CoinTypeA, CoinTypeB>(
        config: &GlobalConfig,
        pool: &mut pool::Pool<CoinTypeA, CoinTypeB>,
        mut coin_a: Coin<CoinTypeA>,
        mut coin_b: Coin<CoinTypeB>,
        a2b: bool,
        clock: &sui::clock::Clock,
        ctx: &mut TxContext
    ):(Coin<CoinTypeA>, Coin<CoinTypeB>) {
        let amount = if (a2b) coin::value(&coin_a) else coin::value(&coin_b);
        // Set appropriate sqrt_price_limit based on swap direction
        let sqrt_price_limit = if (a2b) MIN_SQRT_PRICE_X64 else MAX_SQRT_PRICE_X64; // use cetus default limit, since we have check output amount slippage at the end of the main swap
        let (receive_a, receive_b, flash_receipt) = pool::flash_swap<CoinTypeA, CoinTypeB>(
            config,
            pool,
            a2b,
            true,
            amount,
            sqrt_price_limit,
            clock
        );
        let (in_amount, out_amount) = (
            pool::swap_pay_amount(&flash_receipt),
            if (a2b) balance::value(&receive_b) else balance::value(&receive_a)
        );

        // Pay for flash swap
        let (pay_coin_a, pay_coin_b) = if (a2b) {
            (coin::into_balance(coin::split(&mut coin_a, in_amount, ctx)), balance::zero<CoinTypeB>())
        } else {
            (balance::zero<CoinTypeA>(), coin::into_balance(coin::split(&mut coin_b, in_amount, ctx)))
        };

        coin::join(&mut coin_b, coin::from_balance(receive_b, ctx));
        coin::join(&mut coin_a, coin::from_balance(receive_a, ctx));

        pool::repay_flash_swap<CoinTypeA, CoinTypeB>(
            config,
            pool,
            pay_coin_a,
            pay_coin_b,
            flash_receipt
        );

        // Return the updated coins
        (coin_a, coin_b)
    }

    /// Main swap function that handles all token swaps with coin lists
    /// Supports both directions: tokens -> TELEBTC and TELEBTC -> tokens
    /// Implements multi-hop swaps through WBTC and USDC as intermediate tokens
    /// 
    /// Parameters:
    /// - config: Global configuration for Cetus CLMM
    /// - pool_usdc_sui: Pool for USDC-SUI trading
    /// - pool_usdc_usdt: Pool for USDC-USDT trading
    /// - pool_usdc_wbtc: Pool for USDC-WBTC trading
    /// - pool_telebtc_wbtc: Pool for TELEBTC-WBTC trading
    /// - input_amount: Amount of input token provided
    /// - min_output_amount: Minimum acceptable output amount
    /// - telebtc_coins: List of TELEBTC coins (empty if not swapping TELEBTC)
    /// - wbtc_coins: List of WBTC coins (empty if not swapping WBTC)
    /// - sui_coins: List of SUI coins (empty if not swapping SUI)
    /// - usdt_coins: List of USDT coins (empty if not swapping USDT)
    /// - usdc_coins: List of USDC coins (empty if not swapping USDC)
    /// - clock: Sui clock for transaction timing
    /// - ctx: Transaction context
    /// 
    /// Returns: (bool, Coin<TELEBTC>, Coin<WBTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) - Success flag and updated coins
    public fun mainSwapTokens<TargetToken>(
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        input_amount: u64, // amount of input token provided
        min_output_amount: u64, // min amount of telebtc to get
        mut telebtc_coins: vector<Coin<TELEBTC>>,
        mut wbtc_coins: vector<Coin<BTC>>,
        mut sui_coins: vector<Coin<SUI>>,
        mut usdt_coins: vector<Coin<USDT>>,
        mut usdc_coins: vector<Coin<USDC>>,
        clock: &sui::clock::Clock,
        ctx: &mut TxContext
    ):(bool, Coin<TELEBTC>, Coin<BTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) {
        let user = sui::tx_context::sender(ctx);
        let timestamp = sui::clock::timestamp_ms(clock);
        
        
        // Assure only one token is being swapped based on non-empty coin lists
        let input_token_count = if (std::vector::length(&wbtc_coins) > 0) 1 else 0 + 
                                if (std::vector::length(&sui_coins) > 0) 1 else 0 + 
                                if (std::vector::length(&usdt_coins) > 0) 1 else 0 + 
                                if (std::vector::length(&usdc_coins) > 0) 1 else 0 +
                                if (std::vector::length(&telebtc_coins) > 0) 1 else 0;
        assert!(input_token_count == 1, EINVALID_INPUT_LIST_LENGTH);

        // merge all coins if there are multiple coins
        // the first coin is the input coin, the second coin is the remaining coin
        // if not the swap type, then both coins are zero
        let (wbtc_coin,remaining_wbtc_coin) = merge_and_split<BTC>(wbtc_coins, input_amount, ctx);
        let (sui_coin,remaining_sui_coin) = merge_and_split<SUI>(sui_coins, input_amount, ctx);
        let (usdt_coin,remaining_usdt_coin) = merge_and_split<USDT>(usdt_coins, input_amount, ctx);
        let (usdc_coin,remaining_usdc_coin) = merge_and_split<USDC>(usdc_coins, input_amount, ctx);
        let (telebtc_coin,remaining_telebtc_coin) = merge_and_split<TELEBTC>(telebtc_coins, input_amount, ctx);
        
        if(is_same<TargetToken, TELEBTC>()) {
            // Direction: Other tokens -> TELEBTC
            assert!(coin::value(&telebtc_coin) == 0, EINVALID_AMOUNT);

            // Determine which token is being swapped and merge coins
            let input_token_type: std::type_name::TypeName;

            // Get quote for the swap
            let (status, quote_amount) = if (coin::value(&wbtc_coin) > 0) {
                input_token_type = type_name::get<BTC>();
                getQuoteBuyTelebtc<BTC>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else if (coin::value(&sui_coin) > 0) {
                input_token_type = type_name::get<SUI>();
                getQuoteBuyTelebtc<SUI>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else if (coin::value(&usdt_coin) > 0) {
                input_token_type = type_name::get<USDT>();
                getQuoteBuyTelebtc<USDT>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else if (coin::value(&usdc_coin) > 0) {
                input_token_type = type_name::get<USDC>();
                getQuoteBuyTelebtc<USDC>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else {
                abort ENOT_ENOUGH_COINS;
                (false, 0)
            };

            if (!status) {
                // Slippage issue, return the original coins and emit failure event
                event::emit(SwapFailed {
                    user,
                    input_token: input_token_type,
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    reason: b"0003slippage_too_high",
                    timestamp,
                });
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                // swap failed, return the original coins (merged coins)
                return (false, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            };

            // Execute the swap based on input token type
            if(coin::value(&wbtc_coin) > 0) {
                // Direct swap: WBTC -> TELEBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_coin, wbtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<BTC>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(coin::value(&usdc_coin) > 0) {
                // Two-hop swap: USDC -> WBTC -> TELEBTC
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, wbtc_coin, true, clock, ctx);
                let (return_telebtc_coin,return_wbtc_coin) = swap<TELEBTC,BTC>(config, pool_telebtc_wbtc, telebtc_coin, return_wbtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<USDC>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });

                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(coin::value(&sui_coin) > 0) {
                // Three-hop swap: SUI -> USDC -> WBTC -> TELEBTC
                let (return_usdc_coin,return_sui_coin) = swap<USDC,SUI>(config, pool_usdc_sui, usdc_coin, sui_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, return_usdc_coin, wbtc_coin, true, clock, ctx);
                let (return_telebtc_coin,return_wbtc_coin) = swap<TELEBTC,BTC>(config, pool_telebtc_wbtc, telebtc_coin, return_wbtc_coin, false, clock, ctx);
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<SUI>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),   
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(return_sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(coin::value(&usdt_coin) > 0) {
                // Three-hop swap: USDT -> USDC -> WBTC -> TELEBTC
                let (return_usdc_coin,return_usdt_coin) = swap<USDC,USDT>(config, pool_usdc_usdt, usdc_coin, usdt_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, return_usdc_coin, wbtc_coin, true, clock, ctx);
                let (return_telebtc_coin,return_wbtc_coin) = swap<TELEBTC,BTC>(config, pool_telebtc_wbtc, telebtc_coin, return_wbtc_coin, false, clock, ctx);
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<USDT>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(return_usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else{
                abort EINVALID_TARGET_TOKEN
            }
        }
        else{
            // Direction: TELEBTC -> Other tokens
            // Get quote for selling TELEBTC to get target token
            let (status, amount) = getQuoteSellTelebtc<TargetToken>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount);
            if (!status) {
                // Slippage issue, return the original coins and emit failure event
                event::emit(SwapFailed {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<TargetToken>(),
                    input_amount,
                    reason: b"0002slippage_too_high",
                    timestamp,
                });

                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (false, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            };
            
            // Validate coin amounts - only TELEBTC should have non-zero amount
            let telebtc_amount = coin::value(&telebtc_coin);
            let wbtc_amount = coin::value(&wbtc_coin);
            let sui_amount = coin::value(&sui_coin);
            let usdt_amount = coin::value(&usdt_coin);
            let usdc_amount = coin::value(&usdc_coin);


            assert!(telebtc_amount > 0, EINVALID_AMOUNT);
            assert!(wbtc_amount == 0, EINVALID_AMOUNT);
            assert!(sui_amount == 0, EINVALID_AMOUNT);
            assert!(usdt_amount == 0, EINVALID_AMOUNT);
            assert!(usdc_amount == 0, EINVALID_AMOUNT);
            assert!(telebtc_amount == input_amount, EINVALID_AMOUNT);

            // Execute the swap based on target token type
            if(is_same<TargetToken, BTC>()) {
                // Direct swap: TELEBTC -> WBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_coin, wbtc_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<BTC>(),
                    input_amount,
                    output_amount: coin::value(&return_wbtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(is_same<TargetToken, USDC>()) {
                // Two-hop swap: TELEBTC -> WBTC -> USDC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_coin, wbtc_coin, true, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, return_wbtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<USDC>(),
                    input_amount,
                    output_amount: coin::value(&return_usdc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(is_same<TargetToken, SUI>()) {
                // Three-hop swap: TELEBTC -> WBTC -> USDC -> SUI
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_coin, wbtc_coin, true, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_sui_coin) = swap<USDC,SUI>(config, pool_usdc_sui, return_usdc_coin, sui_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<SUI>(),
                    input_amount,
                    output_amount: coin::value(&return_sui_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(return_sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(is_same<TargetToken, USDT>()) {
                // Three-hop swap: TELEBTC -> WBTC -> USDC -> USDT
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_coin, wbtc_coin, true, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_usdt_coin) = swap<USDC,USDT>(config, pool_usdc_usdt, return_usdc_coin, usdt_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<USDT>(),
                    input_amount,
                    output_amount: coin::value(&return_usdt_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(return_usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else{
                abort EINVALID_TARGET_TOKEN
            }
        };
        
        // quick merge all coins and return them
        let merged_telebtc_coin = merge_two_coins(telebtc_coin, remaining_telebtc_coin, ctx);
        let merged_wbtc_coin = merge_two_coins(wbtc_coin, remaining_wbtc_coin, ctx);
        let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
        let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
        let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);

        // This should not be reached
        return (false, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
    }

    // The below code is for the reverse case (ascii telebtc is smaller than ascii btc), so the pool is <BTC,TELEBTC>

    /// Get quote for selling TELEBTC to target token
    /// This function calculates how much of the target token you can get for a given amount of TELEBTC
    /// Supports multi-hop swaps through WBTC and USDC as intermediate tokens
    /// 
    /// Parameters:
    /// - pool_usdc_sui: Pool for USDC-SUI trading
    /// - pool_usdc_usdt: Pool for USDC-USDT trading  
    /// - pool_usdc_wbtc: Pool for USDC-WBTC trading
    /// - pool_telebtc_wbtc: Pool for TELEBTC-WBTC trading
    /// - input_amount: Amount of TELEBTC to sell
    /// - min_output_amount: Minimum acceptable output amount
    /// 
    /// Returns: (bool, u64) - (success_flag, output_amount)
    public fun getQuoteSellTelebtc_rev<TargetToken>(
        pool_usdc_sui: &pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &pool::Pool<BTC, TELEBTC>,
        input_amount: u64, // amount of telebtc provided
        min_output_amount: u64, // min amount of target token to get
    ): (bool, u64) {
        if (is_same<TargetToken, BTC>()) {
            // Direct swap: TELEBTC -> WBTC (using reverse pool)
            return getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, input_amount, min_output_amount, true)
        };
        if (is_same<TargetToken, USDC>()) {
            // Two-hop swap: TELEBTC -> WBTC -> USDC
            let (status1, out1) = getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            return getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, min_output_amount, false);
        };
        if (is_same<TargetToken, SUI>()) {
            // Three-hop swap: TELEBTC -> WBTC -> USDC -> SUI
            let (status1, out1) = getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            if (!status2) { return (false, 0) };
            return getOutputAmount<USDC, SUI>(pool_usdc_sui, out2, min_output_amount, true);
        };
        if (is_same<TargetToken, USDT>()) {
            // Three-hop swap: TELEBTC -> WBTC -> USDC -> USDT
            let (status1, out1) = getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            if (!status2) { return (false, 0) };
            return getOutputAmount<USDC, USDT>(pool_usdc_usdt, out2, min_output_amount, true);
        };
        (false, 10) //for testing only
    }

    /// Get quote for buying TELEBTC with input token
    /// This function calculates how much TELEBTC you can get for a given amount of input token
    /// Used in burn router functions for reverse swaps
    /// 
    /// Parameters:
    /// - pool_usdc_sui: Pool for USDC-SUI trading
    /// - pool_usdc_usdt: Pool for USDC-USDT trading
    /// - pool_usdc_wbtc: Pool for USDC-WBTC trading  
    /// - pool_telebtc_wbtc: Pool for TELEBTC-WBTC trading
    /// - input_amount: Amount of input token to spend
    /// - min_output_amount: Minimum acceptable TELEBTC amount
    /// 
    /// Returns: (bool, u64) - (success_flag, output_amount)
    public fun getQuoteBuyTelebtc_rev<InputToken>(
        pool_usdc_sui: &pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &pool::Pool<BTC, TELEBTC>,
        input_amount: u64, // amount of input token provided
        min_output_amount: u64, // min amount of telebtc to get
    ): (bool, u64) {
        if (is_same<InputToken, BTC>()) {
            // Direct swap: BTC -> TELEBTC
            return getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, input_amount, min_output_amount, true);
        };
        if (is_same<InputToken, USDC>()) {
            // Two-hop swap: USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, input_amount, 0, true);
            if (!status1) { return (false, 0) };
            return getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, out1, min_output_amount, true);
        };
        if (is_same<InputToken, SUI>()) {
            // Three-hop swap: SUI -> USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, SUI>(pool_usdc_sui, input_amount, 0, false);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, true);
            if (!status2) { return (false, 0) };
            return getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, out2, min_output_amount, true);
        };
        if (is_same<InputToken, USDT>()) {
            // Three-hop swap: USDT -> USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, USDT>(pool_usdc_usdt, input_amount, 0, false);
            if (!status1) { return (false, 0) };
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            if (!status2) { return (false, 0) };
            return getOutputAmount<BTC, TELEBTC>(pool_telebtc_wbtc, out2, min_output_amount, true);
        };
        (false, 0)
    }


    /// Main swap function that handles all token swaps
    /// Supports both directions: tokens -> TELEBTC and TELEBTC -> tokens
    /// Implements multi-hop swaps through WBTC and USDC as intermediate tokens
    /// 
    /// Parameters:
    /// - config: Global configuration for Cetus CLMM
    /// - pool_usdc_sui: Pool for USDC-SUI trading
    /// - pool_usdc_usdt: Pool for USDC-USDT trading
    /// - pool_usdc_wbtc: Pool for USDC-WBTC trading
    /// - pool_telebtc_wbtc: Pool for TELEBTC-WBTC trading
    /// - input_amount: Amount of input token provided
    /// - min_output_amount: Minimum acceptable output amount
    /// - telebtc_token: TELEBTC coin
    /// - wbtc_token: WBTC coin
    /// - sui_token: SUI coin
    /// - usdt_token: USDT coin
    /// - usdc_token: USDC coin
    /// - clock: Sui clock for transaction timing
    /// - ctx: Transaction context
    /// 
    /// Returns: (bool, Coin<TELEBTC>, Coin<WBTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) - Success flag and updated coins
    public fun mainSwapTokens_rev<TargetToken>(
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<BTC, TELEBTC>,
        input_amount: u64, // amount of input token provided
        min_output_amount: u64, // min amount of telebtc to get
        mut telebtc_coins: vector<Coin<TELEBTC>>,
        mut wbtc_coins: vector<Coin<BTC>>,
        mut sui_coins: vector<Coin<SUI>>,
        mut usdt_coins: vector<Coin<USDT>>,
        mut usdc_coins: vector<Coin<USDC>>,
        clock: &sui::clock::Clock,
        ctx: &mut TxContext
    ):(bool, Coin<TELEBTC>, Coin<BTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) {
        let user = sui::tx_context::sender(ctx);
        let timestamp = sui::clock::timestamp_ms(clock);
        
        // Assure only one token is being swapped based on non-empty coin lists
        let input_token_count = if (std::vector::length(&wbtc_coins) > 0) 1 else 0 + 
                                if (std::vector::length(&sui_coins) > 0) 1 else 0 + 
                                if (std::vector::length(&usdt_coins) > 0) 1 else 0 + 
                                if (std::vector::length(&usdc_coins) > 0) 1 else 0 +
                                if (std::vector::length(&telebtc_coins) > 0) 1 else 0;
        assert!(input_token_count == 1, EINVALID_INPUT_LIST_LENGTH);

        // merge all coins if there are multiple coins
        // the first coin is the input coin, the second coin is the remaining coin
        // if not the swap type, then both coins are zero
        let (wbtc_coin,remaining_wbtc_coin) = merge_and_split<BTC>(wbtc_coins, input_amount, ctx);
        let (sui_coin,remaining_sui_coin) = merge_and_split<SUI>(sui_coins, input_amount, ctx);
        let (usdt_coin,remaining_usdt_coin) = merge_and_split<USDT>(usdt_coins, input_amount, ctx);
        let (usdc_coin,remaining_usdc_coin) = merge_and_split<USDC>(usdc_coins, input_amount, ctx);
        let (telebtc_coin,remaining_telebtc_coin) = merge_and_split<TELEBTC>(telebtc_coins, input_amount, ctx);
        
        if(is_same<TargetToken, TELEBTC>()) {
            // Direction: Other tokens -> TELEBTC
            assert!(coin::value(&telebtc_coin) == 0, EINVALID_AMOUNT);

            // Determine which token is being swapped and get quote
            let input_token_type: std::type_name::TypeName;
            let (status, quote_amount) = if (coin::value(&wbtc_coin) > 0) {
                input_token_type = type_name::get<BTC>();
                getQuoteBuyTelebtc_rev<BTC>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else if (coin::value(&sui_coin) > 0) {
                input_token_type = type_name::get<SUI>();
                getQuoteBuyTelebtc_rev<SUI>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else if (coin::value(&usdt_coin) > 0) {
                input_token_type = type_name::get<USDT>();
                getQuoteBuyTelebtc_rev<USDT>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else if (coin::value(&usdc_coin) > 0) {
                input_token_type = type_name::get<USDC>();
                getQuoteBuyTelebtc_rev<USDC>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount)
            } else {
                abort ENOT_ENOUGH_COINS;
                (false, 0)
            };

            if (!status) {
                // Slippage issue, return the original coins and emit failure event
                event::emit(SwapFailed {
                    user,
                    input_token: input_token_type,
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    reason: b"0001slippage_too_high",
                    timestamp,
                });
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (false, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            };

            // Execute the swap based on input token type
            if(coin::value(&wbtc_coin) > 0) {
                // Direct swap: WBTC -> TELEBTC
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, wbtc_coin, telebtc_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<BTC>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(coin::value(&usdc_coin) > 0) {
                // Two-hop swap: USDC -> WBTC -> TELEBTC
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, wbtc_coin, true, clock, ctx);
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, return_wbtc_coin, telebtc_coin, true, clock, ctx);
                
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<USDC>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(coin::value(&sui_coin) > 0) {
                // Three-hop swap: SUI -> USDC -> WBTC -> TELEBTC

                let (return_usdc_coin,return_sui_coin) = swap<USDC,SUI>(config, pool_usdc_sui, usdc_coin, sui_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, return_usdc_coin, wbtc_coin, true, clock, ctx);
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, return_wbtc_coin, telebtc_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<SUI>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),   
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(return_sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(coin::value(&usdt_coin) > 0) {
                // Three-hop swap: USDT -> USDC -> WBTC -> TELEBTC
                let (return_usdc_coin,return_usdt_coin) = swap<USDC,USDT>(config, pool_usdc_usdt, usdc_coin, usdt_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, return_usdc_coin, wbtc_coin, true, clock, ctx);
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, return_wbtc_coin, telebtc_coin, true, clock, ctx);
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<USDT>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: input_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(return_usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else{
                abort EINVALID_TARGET_TOKEN
            }
        }
        else{
            // Direction: TELEBTC -> Other tokens
            // Get quote for buying target token with TELEBTC
            let (status, amount) = getQuoteSellTelebtc_rev<TargetToken>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount);
            if (!status) {
                // Slippage issue, return the original coins and emit failure event
                event::emit(SwapFailed {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<TargetToken>(),
                    input_amount,
                    reason: b"0000slippage_too_high",
                    timestamp,
                });
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (false, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            };
            
            // Validate coin amounts - only TELEBTC should have non-zero amount
            let telebtc_amount = coin::value(&telebtc_coin);
            let wbtc_amount = coin::value(&wbtc_coin);
            let sui_amount = coin::value(&sui_coin);
            let usdt_amount = coin::value(&usdt_coin);
            let usdc_amount = coin::value(&usdc_coin);
        
            assert!(telebtc_amount > 0, EINVALID_AMOUNT);
            assert!(wbtc_amount == 0, EINVALID_AMOUNT);
            assert!(sui_amount == 0, EINVALID_AMOUNT);
            assert!(usdt_amount == 0, EINVALID_AMOUNT);
            assert!(usdc_amount == 0, EINVALID_AMOUNT);
            assert!(telebtc_amount == input_amount, EINVALID_AMOUNT);

            // Execute the swap based on target token type
            if(is_same<TargetToken, BTC>()) {
                // Direct swap: TELEBTC -> WBTC
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, wbtc_coin, telebtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<BTC>(),
                    input_amount,
                    output_amount: coin::value(&return_wbtc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(is_same<TargetToken, USDC>()) {
                // Two-hop swap: TELEBTC -> WBTC -> USDC
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, wbtc_coin, telebtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, return_wbtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<USDC>(),
                    input_amount,
                    output_amount: coin::value(&return_usdc_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(is_same<TargetToken, SUI>()) {
                // Three-hop swap: TELEBTC -> WBTC -> USDC -> SUI
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, wbtc_coin, telebtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_sui_coin) = swap<USDC,SUI>(config, pool_usdc_sui, return_usdc_coin, sui_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<SUI>(),
                    input_amount,
                    output_amount: coin::value(&return_sui_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(return_sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else if(is_same<TargetToken, USDT>()) {
                // Three-hop swap: TELEBTC -> WBTC -> USDC -> USDT
                let (return_wbtc_coin,return_telebtc_coin) = swap<BTC, TELEBTC>(config, pool_telebtc_wbtc, wbtc_coin, telebtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_coin, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_usdt_coin) = swap<USDC,USDT>(config, pool_usdc_usdt, return_usdc_coin, usdt_coin, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<USDT>(),
                    input_amount,
                    output_amount: coin::value(&return_usdt_coin),
                    timestamp,
                });
                
                // quick merge all coins and return them
                let merged_telebtc_coin = merge_two_coins(return_telebtc_coin, remaining_telebtc_coin, ctx);
                let merged_wbtc_coin = merge_two_coins(return_wbtc_coin, remaining_wbtc_coin, ctx);
                let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
                let merged_usdt_coin = merge_two_coins(return_usdt_coin, remaining_usdt_coin, ctx);
                let merged_usdc_coin = merge_two_coins(return_usdc_coin, remaining_usdc_coin, ctx);
                return (true, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
            }
            else{
                abort EINVALID_TARGET_TOKEN
            }
        };
        
        // quick merge all coins and return them
        let merged_telebtc_coin = merge_two_coins(telebtc_coin, remaining_telebtc_coin, ctx);
        let merged_wbtc_coin = merge_two_coins(wbtc_coin, remaining_wbtc_coin, ctx);
        let merged_sui_coin = merge_two_coins(sui_coin, remaining_sui_coin, ctx);
        let merged_usdt_coin = merge_two_coins(usdt_coin, remaining_usdt_coin, ctx);
        let merged_usdc_coin = merge_two_coins(usdc_coin, remaining_usdc_coin, ctx);

        // This should not be reached
        return (false, merged_telebtc_coin, merged_wbtc_coin, merged_sui_coin, merged_usdt_coin, merged_usdc_coin)
    }
} 