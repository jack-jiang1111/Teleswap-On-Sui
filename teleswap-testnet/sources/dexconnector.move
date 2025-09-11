#[allow(unused)]
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
    use usdc::usdc::USDC;
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
    const EVALID_TARGET_TOKEN: u64 = 430;
    const EINVALID_INPUT_AMOUNT: u64 = 431;

    // Events
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
        if (out < min_output_amount) { return (false, out) };
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
    public(package) fun getQuoteSellTelebtc<TargetToken>(
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
            return getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, min_output_amount, false);
        };
        if (is_same<TargetToken, SUI>()) {
            // Three-hop swap: TELEBTC -> WBTC -> USDC -> SUI
            let (status1, out1) = getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, input_amount, 0, true);
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
            return getOutputAmount<USDC, SUI>(pool_usdc_sui, out2, min_output_amount, true);
        };
        if (is_same<TargetToken, USDT>()) {
            // Three-hop swap: TELEBTC -> WBTC -> USDC -> USDT
            let (status1, out1) = getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, input_amount, 0, true);
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
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
    public(package) fun getQuoteBuyTelebtc<InputToken>(
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
            return getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, out1, min_output_amount, false);
        };
        if (is_same<InputToken, SUI>()) {
            // Three-hop swap: SUI -> USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, SUI>(pool_usdc_sui, input_amount, 0, false);
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, true);
            return getOutputAmount<TELEBTC, BTC>(pool_telebtc_wbtc, out2, min_output_amount, false);
        };
        if (is_same<InputToken, USDT>()) {
            // Three-hop swap: USDT -> USDC -> WBTC -> TELEBTC
            let (status1, out1) = getOutputAmount<USDC, USDT>(pool_usdc_usdt, input_amount, 0, false);
            let (status2, out2) = getOutputAmount<USDC, BTC>(pool_usdc_wbtc, out1, 0, false);
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
        let sqrt_price_limit = if (a2b) 0xffffffffffffffffffffffffffffffffu128 else 1;
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
    public fun mainSwapTokens<TargetToken>(
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        input_amount: u64, // amount of input token provided
        min_output_amount: u64, // min amount of telebtc to get
        mut telebtc_token: Coin<TELEBTC>,
        mut wbtc_token: Coin<BTC>,
        mut sui_token: Coin<SUI>,
        mut usdt_token: Coin<USDT>,
        mut usdc_token: Coin<USDC>,
        clock: &sui::clock::Clock,
        ctx: &mut TxContext
    ):(bool, Coin<TELEBTC>, Coin<BTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) {
        let user = sui::tx_context::sender(ctx);
        let timestamp = sui::clock::timestamp_ms(clock);
        
        if(is_same<TargetToken, TELEBTC>()) {
            // Direction: Other tokens -> TELEBTC
            // Need to find out which token is not zero (the token to be swapped to telebtc)
            let telebtc_amount = coin::value(&telebtc_token);
            let wbtc_amount = coin::value(&wbtc_token);
            let sui_amount = coin::value(&sui_token);
            let usdt_amount = coin::value(&usdt_token);
            let usdc_amount = coin::value(&usdc_token);

            // Validate that only one input token has non-zero amount
            let input_token_count = if (telebtc_amount > 0) 1 else 0 + 
                                   if (wbtc_amount > 0) 1 else 0 + 
                                   if (sui_amount > 0) 1 else 0 + 
                                   if (usdt_amount > 0) 1 else 0 + 
                                   if (usdc_amount > 0) 1 else 0;
            assert!(input_token_count == 1, EINVALID_AMOUNT);

            // Emit quote request event
            let input_token_type = if (wbtc_amount > 0) type_name::get<BTC>() else
                                  if (sui_amount > 0) type_name::get<SUI>() else
                                  if (usdt_amount > 0) type_name::get<USDT>() else
                                  if (usdc_amount > 0) type_name::get<USDC>() else
                                  type_name::get<TELEBTC>();

            // Get quote for the swap
            let (status, quote_amount) = if (wbtc_amount > 0) {
                assert!(wbtc_amount == input_amount, EINVALID_INPUT_AMOUNT);
                getQuoteBuyTelebtc<BTC>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, wbtc_amount, min_output_amount)
            } else if (sui_amount > 0) {
                assert!(sui_amount == input_amount, EINVALID_INPUT_AMOUNT);
                getQuoteBuyTelebtc<SUI>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, sui_amount, min_output_amount)
            } else if (usdt_amount > 0) {
                assert!(usdt_amount == input_amount, EINVALID_INPUT_AMOUNT);
                getQuoteBuyTelebtc<USDT>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, usdt_amount, min_output_amount)
            } else if (usdc_amount > 0) {
                assert!(usdc_amount == input_amount, EINVALID_INPUT_AMOUNT);
                getQuoteBuyTelebtc<USDC>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, usdc_amount, min_output_amount)
            } else {
                (false, 0)
            };

            if (!status) {
                // Slippage issue, return the original coins and emit failure event
                event::emit(SwapFailed {
                    user,
                    input_token: input_token_type,
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: if (wbtc_amount > 0) wbtc_amount else
                                  if (sui_amount > 0) sui_amount else
                                  if (usdt_amount > 0) usdt_amount else
                                  if (usdc_amount > 0) usdc_amount else 0,
                    reason: b"slippage_too_high",
                    timestamp,
                });
                return (false, telebtc_token, wbtc_token, sui_token, usdt_token, usdc_token)
            };

            // Execute the swap based on input token type
            if(wbtc_amount > 0) {
                // Direct swap: WBTC -> TELEBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<BTC>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: wbtc_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, sui_token, usdt_token, usdc_token)
            }
            else if(usdc_amount > 0) {
                // Two-hop swap: USDC -> WBTC -> TELEBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_token, return_wbtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<USDC>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: usdc_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, sui_token, usdt_token, return_usdc_coin)
            }
            else if(sui_amount > 0) {
                // Three-hop swap: SUI -> USDC -> WBTC -> TELEBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_token, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_sui_coin) = swap<USDC,SUI>(config, pool_usdc_sui, return_usdc_coin, sui_token, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<SUI>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: sui_amount,
                    output_amount: coin::value(&return_telebtc_coin),   
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, return_sui_coin, usdt_token, return_usdc_coin)
            }
            else if(usdt_amount > 0) {
                // Three-hop swap: USDT -> USDC -> WBTC -> TELEBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, false, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_token, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_usdt_coin) = swap<USDC,USDT>(config, pool_usdc_usdt, return_usdc_coin, usdt_token, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<USDT>(),
                    output_token: type_name::get<TELEBTC>(),
                    input_amount: usdt_amount,
                    output_amount: coin::value(&return_telebtc_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, sui_token, return_usdt_coin, return_usdc_coin)
            }
            else{
                abort EVALID_TARGET_TOKEN
            }
        }
        else{
            // Direction: TELEBTC -> Other tokens
            // Get quote for buying target token with TELEBTC
            let (status, amount) = getQuoteBuyTelebtc<TargetToken>(pool_usdc_sui, pool_usdc_usdt, pool_usdc_wbtc, pool_telebtc_wbtc, input_amount, min_output_amount);
            if (!status) {
                // Slippage issue, return the original coins and emit failure event
                event::emit(SwapFailed {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<TargetToken>(),
                    input_amount,
                    reason: b"slippage_too_high",
                    timestamp,
                });
                return (false, telebtc_token, wbtc_token, sui_token, usdt_token, usdc_token)
            };
            
            // Validate coin amounts - only TELEBTC should have non-zero amount
            let telebtc_amount = coin::value(&telebtc_token);
            let wbtc_amount = coin::value(&wbtc_token);
            let sui_amount = coin::value(&sui_token);
            let usdt_amount = coin::value(&usdt_token);
            let usdc_amount = coin::value(&usdc_token);

            assert!(telebtc_amount > 0, EINVALID_AMOUNT);
            assert!(wbtc_amount == 0, EINVALID_AMOUNT);
            assert!(sui_amount == 0, EINVALID_AMOUNT);
            assert!(usdt_amount == 0, EINVALID_AMOUNT);
            assert!(usdc_amount == 0, EINVALID_AMOUNT);
            assert!(telebtc_amount == input_amount, EINVALID_AMOUNT);

            // Execute the swap based on target token type
            if(is_same<TargetToken, BTC>()) {
                // Direct swap: TELEBTC -> WBTC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<BTC>(),
                    input_amount,
                    output_amount: coin::value(&return_wbtc_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, sui_token, usdt_token, usdc_token)
            }
            else if(is_same<TargetToken, USDC>()) {
                // Two-hop swap: TELEBTC -> WBTC -> USDC
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, true, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_token, return_wbtc_coin, false, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<USDC>(),
                    input_amount,
                    output_amount: coin::value(&return_usdc_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, sui_token, usdt_token, return_usdc_coin)
            }
            else if(is_same<TargetToken, SUI>()) {
                // Three-hop swap: TELEBTC -> WBTC -> USDC -> SUI
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, true, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_token, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_sui_coin) = swap<USDC,SUI>(config, pool_usdc_sui, return_usdc_coin, sui_token, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<SUI>(),
                    input_amount,
                    output_amount: coin::value(&return_sui_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, return_sui_coin, usdt_token, return_usdc_coin)
            }
            else if(is_same<TargetToken, USDT>()) {
                // Three-hop swap: TELEBTC -> WBTC -> USDC -> USDT
                let (return_telebtc_coin, return_wbtc_coin) = swap<TELEBTC, BTC>(config, pool_telebtc_wbtc, telebtc_token, wbtc_token, true, clock, ctx);
                let (return_usdc_coin,return_wbtc_coin) = swap<USDC, BTC>(config, pool_usdc_wbtc, usdc_token, return_wbtc_coin, false, clock, ctx);
                let (return_usdc_coin,return_usdt_coin) = swap<USDC,USDT>(config, pool_usdc_usdt, return_usdc_coin, usdt_token, true, clock, ctx);
                
                // Emit success event
                event::emit(SwapExecuted {
                    user,
                    input_token: type_name::get<TELEBTC>(),
                    output_token: type_name::get<USDT>(),
                    input_amount,
                    output_amount: coin::value(&return_usdt_coin),
                    timestamp,
                });
                
                return (true, return_telebtc_coin, return_wbtc_coin, sui_token, return_usdt_coin, return_usdc_coin)
            }
            else{
                abort EVALID_TARGET_TOKEN
            }
        };
        
        // Default return (should not be reached)
        (false, telebtc_token, wbtc_token, sui_token, usdt_token, usdc_token)
    }
} 