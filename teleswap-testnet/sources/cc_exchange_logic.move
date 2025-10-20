#[allow(unused,lint(self_transfer),deprecated_usage)]
module teleswap::cc_exchange_logic {
    use sui::table;
    use sui::event;

    use teleswap::cc_exchange_storage::{Self, ExchangeCap, ExchangeRequest, ExchangeAdmin};
    use teleswap::cc_transfer_router_storage::{Self, TxAndProof};
    use btcrelay::btcrelay::{Self, BTCRelay};
    use btcrelay::bitcoin_helper;
    use teleswap::request_parser;
    use teleswap::lockerstorage::{Self, LockerCap};
    use teleswap::lockercore::{Self};
    use teleswap::telebtc::{Self, TeleBTCCap, TELEBTC};
    use teleswap::dexconnector::{Self};
    use cetus_clmm::pool;
    use cetus_clmm::config::GlobalConfig;
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::clock::{Clock};
    use bridged_btc::btc::BTC;
    use sui::sui::SUI;
    use bridged_usdc::usdc::USDC;
    use bridged_usdt::usdt::USDT;
    use std::type_name;
    use teleswap::burn_router_locker_connector;
    use teleswap::burn_router_storage::BurnRouter;
    use teleswap::burn_router_storage;

    public struct SwapSuccess has copy, drop {
        user: address,
        input_token: std::type_name::TypeName,
        output_token: std::type_name::TypeName,
        input_amount: u64,
        output_amount: u64,
        timestamp: u64,
        tx_id: vector<u8>,
    }

    public struct SwapFailure has copy, drop {
        user: address,
        input_token: std::type_name::TypeName,
        output_token: std::type_name::TypeName,
        input_amount: u64,
        reason: vector<u8>,
        timestamp: u64,
        tx_id: vector<u8>,
    }

    public struct RefundProcessedLocal has copy, drop {
        tx_id: vector<u8>,
        refunded_by: address,
        failed_request_amount: u64,
        refund_amount: u64,
        user_script: vector<u8>,
        script_type: u8,
        locker_target_address: address,
        burn_request_counter: u64,
    }

    // Error codes
    const EZERO_ADDRESS: u64 = 611;
    const EINVALID_AMOUNT: u64 = 612;
    const EALREADY_USED: u64 = 613;
    const EINVALID_LENGTH: u64 = 614;
    const ENOT_OWNER: u64 = 615;
    const EINVALID_FEE: u64 = 616;
    const ENOT_FINALIZED: u64 = 617;
    const EINVALID_SIGNATURE: u64 = 618;
    const EINVALID_BTCRELAY: u64 = 619;
    const EINVALID_TELEPORTER: u64 = 620;
    const EOLD_REQUEST: u64 = 621;
    const ENON_ZERO_LOCKTIME: u64 = 622;
    const ENOT_LOCKER: u64 = 623;
    const EINVALID_APP_ID: u64 = 624;
    const EINVALID_REMAINING_COIN: u64 = 625;
    const EINVALID_TARGET_TOKEN: u64 = 626;
    const ENOT_ENOUGH_INPUT_AMOUNT: u64 = 627;
    const EINVALID_TXID: u64 = 628;
    // Constants
    const REQUEST_DATA_LENGTH: u64 = 58; // Exchange request is 58 bytes
    const BRIDGE_FEE_MULTIPLIER: u64 = 100000000000; // 10^11

    // A list of supported tokens
    // TELEBTC: use wrap
    // USDC: telebtc->wbtc->usdc
    // USDT: telebtc->wbtc->usdc->usdt
    // SUI: telebtc->wbtc->usdc->sui
    // WBTC: telebtc->wbtc

    fun is_same<T1, T2>(): bool {
        type_name::get<T1>() == type_name::get<T2>()
    }
    /// Main business logic function - Process a wrapAndSwap request after checking its inclusion on Bitcoin
    ///
    /// Detailed behavior:
    /// - Validates the caller is the configured `special_teleporter` to prevent unintended invocation.
    /// - Verifies the provided Bitcoin transaction `tx_and_proof` is finalized via `btcrelay` 
    /// - Parses request data (recipient, desired token, output amount, network fee, third-party, etc.).
    /// - Mints TeleBTC equal to the input satoshis deposited on Bitcoin, using `lockercore::mint`.
    /// - Calculates protocol/locker/third-party fees (basis points) and network fee from the request,
    /// - Splits out a TeleBTC fee coin from the minted amount; retains a separate TeleBTC coin for swap.
    /// - Attempts to execute the swap path across Cetus pools based on requested target token.
    /// - On success:
    ///   - Distributes fees to teleporter (network fee), protocol treasury, third party, and locker.
    ///   - Transfers any remainder TeleBTC (expected zero) back to the user.
    ///   - Marks the request as completed and sets `remained_input_amount` to 0.
    /// - On failure:
    ///   - Pays the locker fee even upon failure to compensate lockers.
    ///   - Stores the remaining TeleBTC amount into the request (`remained_input_amount`) for transparency.

    ///
    /// Parameters:
    /// - storage: Exchange storage capability (holds configuration, requests, and the vault)
    /// - config: Cetus global configuration object utilized by flash swaps
    /// - pool_*: Concrete Cetus pools used by the supported paths (USDC-SUI, USDC-USDT, USDC-WBTC, TELEBTC-WBTC)
    /// - tx_and_proof: Inclusion proof data for the Bitcoin transaction containing the wrap request
    /// - locker_locking_script: Locker script that received the BTC; used to resolve locker addresses and mint
    /// - btcrelay: Bitcoin relay object for finalization checks
    /// - locker_cap: Locker capability required for minting TeleBTC
    /// - telebtc_cap: TeleBTC capability needed for minting/burning
    /// - treasury_cap: TeleBTC treasury capability required by token admin flows
    /// - clock: On-chain clock for timestamps and deadlines
    /// - ctx: Transaction context
    ///
    /// Returns:
    /// - true if the entire wrap-and-swap process completed without critical errors; otherwise the function
    ///   still returns true, but a SwapFailure will be emitted and TeleBTC is saved for admin refund.
    public fun wrap_and_swap(
        storage: &mut ExchangeCap,
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<BTC, TELEBTC>,
        tx_and_proof: TxAndProof,
        locker_locking_script: vector<u8>,
        btcrelay: &BTCRelay,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        clock: &Clock,
        ctx: &mut TxContext
    ): bool {
        // Basic checks
        assert!(
            tx_context::sender(ctx) == cc_exchange_storage::special_teleporter(storage),
            EINVALID_TELEPORTER
        ); // Only Teleporter can submit requests
        
        assert!(
            cc_transfer_router_storage::block_number(&tx_and_proof) >= cc_exchange_storage::starting_block_number(storage),
            EOLD_REQUEST
        );
        
        assert!(
            bitcoin_helper::equalzero(cc_transfer_router_storage::locktime(&tx_and_proof)),
            ENON_ZERO_LOCKTIME
        );

        // Check that the given script hash is Locker
        assert!(
            lockerstorage::is_locker(locker_cap, locker_locking_script),
            ENOT_LOCKER
        );

        // Extract request info and check if tx has been finalized on Bitcoin
        let tx_id = cc_exchange_helper(
            tx_and_proof,
            locker_locking_script,
            storage,
            btcrelay
        );

        // Get the exchange request and extract needed values
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        let bridge_percentage_fee = cc_exchange_storage::bridge_percentage_fee(request);
        

        // Mint input amount of TeleBTC and calculate fees
        let (mut telebtcCoin, total_fees) = mint_and_calculate_fees(
            storage,
            locker_cap,
            telebtc_cap,
            treasury_cap,
            clock,
            locker_locking_script,
            tx_id,
            ctx
        );

        // split the TeleBTC coin into two coins: one for fees and one for the user
        let fees_telebtc_coin = coin::split(&mut telebtcCoin, total_fees, ctx);

        // Execute the wrap and swap operation
        execute_wrap_and_swap(
            storage,
            config,
            pool_usdc_sui,
            pool_usdc_usdt,
            pool_usdc_wbtc,
            pool_telebtc_wbtc,
            telebtcCoin,
            fees_telebtc_coin,
            locker_locking_script,
            tx_id,
            bridge_percentage_fee,
            locker_cap,
            clock,
            ctx
        );

        true
    }



    /// Mints TeleBTC and calculates protocol/locker/third party/rewarder fees. Updates the request with fee breakdown
    /// and returns newly minted TeleBTC coin and the sum of fee amounts (including network fee).
    ///
    /// Minting details:
    /// - Uses `lockercore::mint` to mint new TeleBTC to this module, based on the input amount parsed from
    ///   the Bitcoin transaction. The Locker capability ensures only authorized lockers can mint.
    /// - Calculates protocol fee, third-party fee (based on `third_party` id and current table entry), rewarder fee,
    ///   and locker fee, each as basis points of input.
    /// - Network fee is taken from the request payload; the sum of all four fees is returned.
    /// - Updates the request fields in-place: protocol_fee, third_party_fee, rewarder_fee, locker_fee, and
    ///   `remained_input_amount = input - (sum of fees)`. This value will be used in the failure path.
    ///
    /// Parameters:
    /// - storage: Exchange storage capability
    /// - locker_cap: Locker capability (required for mint)
    /// - telebtc_cap: TeleBTC capability
    /// - treasury_cap: TeleBTC treasury capability
    /// - clock: Sui clock
    /// - locker_locking_script: Locker script used for minting
    /// - tx_id: Request id
    /// - ctx: Tx context
    ///
    /// Returns:
    /// - (telebtc_coin, total_fees) where total_fees = protocol + third_party + locker + network
    fun mint_and_calculate_fees(
        storage: &mut ExchangeCap,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        clock: &Clock,
        locker_locking_script: vector<u8>,
        tx_id: vector<u8>,
        ctx: &mut TxContext
    ): (Coin<TELEBTC>, u64) {
        // Get the exchange request to access input amount and fee information
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        let input_amount = cc_exchange_storage::input_amount(request);
        let network_fee = cc_exchange_storage::fee(request);
        let third_party = cc_exchange_storage::third_party(request);
        //let rewarder_fee = cc_exchange_storage::rewarder_percentage_fee(request);
        // Mint TeleBTC by calling lockers contract
        let (telebtcCoin, locker_address) = lockercore::mint(
            locker_locking_script, 
            input_amount as u256, 
            locker_cap, 
            telebtc_cap, 
            treasury_cap, 
            tx_context::sender(ctx), 
            clock, 
            ctx
        );

        
        // Calculate fees based on percentages from storage
        let protocol_fee = (input_amount * cc_exchange_storage::protocol_percentage_fee(storage)) / 10000;
        let third_party_fee = (input_amount * cc_exchange_storage::get_third_party_fee_from_storage(storage, third_party)) / 10000;
        let locker_fee = (input_amount * cc_exchange_storage::locker_percentage_fee(storage)) / 10000;
        let rewarder_fee = (input_amount * cc_exchange_storage::rewarder_percentage_fee(storage)) / 10000;

        // Calculate remained input amount after deducting all fees
        let remained_input_amount = input_amount - (locker_fee + protocol_fee + network_fee + third_party_fee + rewarder_fee);
        
        // Since ExchangeRequest doesn't have copy ability, we need to update the request in place
        // Get a mutable reference to the request
        let request_mut = table::borrow_mut(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        cc_exchange_storage::set_request_protocol_fee(request_mut, protocol_fee);
        cc_exchange_storage::set_request_third_party_fee(request_mut, third_party_fee);
        cc_exchange_storage::set_request_rewarder_fee(request_mut, rewarder_fee);
        cc_exchange_storage::set_request_locker_fee(request_mut, locker_fee);
        cc_exchange_storage::set_request_remained_input_amount(request_mut, remained_input_amount);
        let total_fees = protocol_fee + network_fee + third_party_fee + locker_fee + rewarder_fee;
        (telebtcCoin, total_fees)
    }

    /// Executes the actual wrap and swap operation for the current request.
    /// Emits SwapSuccess/SwapFailure and either distributes fees and sends remaining TeleBTC to user,
    /// or deposits remaining TeleBTC into the exchange vault for admin refund.
    ///
    /// Swap path selection:
    /// - Target WBTC: TELEBTC -> WBTC
    /// - Target USDC: TELEBTC -> WBTC -> USDC
    /// - Target SUI: TELEBTC -> WBTC -> USDC -> SUI
    /// - Target USDT: TELEBTC -> WBTC -> USDC -> USDT
    ///
    /// Event semantics:
    /// - SwapSuccess: includes input/output token types, exact input amount (from request), output amount
    ///   measured from result coins, and a timestamp.
    /// - SwapFailure: includes input/output token type names, input amount (from request), reason string,
    ///   and a timestamp. Failure path still pays locker fee and deposits remaining TeleBTC to vault.
    ///
    /// Parameters:
    /// - storage: Exchange storage capability
    /// - config: Cetus global config
    /// - pool_*: Cetus pools used for routing
    /// - telebtc_coin: Freshly minted TeleBTC for swap
    /// - fees_telebtc_coin: Portion of TeleBTC reserved for fee payouts
    /// - locker_locking_script: Locker script
    /// - tx_id: Request id
    /// - bridge_percentage_fee: Bridge fee in 1e11 precision (unused here; recorded in storage)
    /// - locker_cap: Locker capability
    /// - clock: Sui clock
    /// - ctx: Tx context
    fun execute_wrap_and_swap(
        storage: &mut ExchangeCap,
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<BTC, TELEBTC>,
        telebtc_coin: Coin<TELEBTC>,
        mut fees_telebtc_coin: Coin<TELEBTC>,
        locker_locking_script: vector<u8>,
        tx_id: vector<u8>,
        bridge_percentage_fee: u64,
        locker_cap: &LockerCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Get the exchange request from storage and snapshot fields
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        let recipient_addr = cc_exchange_storage::recipient_address(request);
        let locker_fee_amt = cc_exchange_storage::locker_fee(request);
        let input_amt_snapshot = cc_exchange_storage::input_amount(request);
        let total_fees = coin::value(&fees_telebtc_coin);

        // Execute the swap with individual parameters
        let (result, telebtc_coin, wbtc_coin, sui_coin, usdt_coin, usdc_coin) = execute_swap(
            config,
            pool_usdc_sui,
            pool_usdc_usdt,
            pool_usdc_wbtc,
            pool_telebtc_wbtc,
            locker_locking_script,
            request,
            tx_id,
            telebtc_coin,
            total_fees,
            clock,
            ctx
        );

        // Determine output amount and token before moving coins
        let out_wbtc = coin::value(&wbtc_coin);
        let out_sui = coin::value(&sui_coin);
        let out_usdt = coin::value(&usdt_coin);
        let out_usdc = coin::value(&usdc_coin);
        let (out_token_tn, out_amount) = if (out_wbtc > 0) {
            (type_name::get<BTC>(), out_wbtc)
        } else if (out_usdc > 0) {
            (type_name::get<USDC>(), out_usdc)
        } else if (out_sui > 0) {
            (type_name::get<SUI>(), out_sui)
        } else if (out_usdt > 0) {
            (type_name::get<USDT>(), out_usdt)
        } else { (type_name::get<TELEBTC>(), 0) };

        // Transfer destination coins to recipient (they may be zero-value)
        transfer::public_transfer(wbtc_coin, recipient_addr);
        transfer::public_transfer(sui_coin, recipient_addr);
        transfer::public_transfer(usdt_coin, recipient_addr);
        transfer::public_transfer(usdc_coin, recipient_addr);

        if(result) {
            // mark request as completed
            let request_mut = table::borrow_mut(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
            cc_exchange_storage::set_request_completed(request_mut, true);
            cc_exchange_storage::set_request_remained_input_amount(request_mut, 0);
            // emit swap success event
            event::emit(SwapSuccess {
                user: sui::tx_context::sender(ctx),
                input_token: type_name::get<TELEBTC>(),
                output_token: out_token_tn,
                input_amount: input_amt_snapshot,
                output_amount: out_amount,
                timestamp: sui::clock::timestamp_ms(clock),
                tx_id: tx_id,
            });

            // send fees to the teleporter, treasury, third party, and locker
            send_fees(storage, tx_id, locker_locking_script, fees_telebtc_coin, locker_cap, ctx);

            // send the remaining telebtc coin to the user (empty coin)
            transfer::public_transfer(telebtc_coin, recipient_addr);

        } else {
            // emit swap failure event
            event::emit(SwapFailure {
                user: sui::tx_context::sender(ctx),
                input_token: type_name::get<TELEBTC>(),
                output_token: out_token_tn,
                input_amount: input_amt_snapshot,
                reason: b"swap_failed",
                timestamp: sui::clock::timestamp_ms(clock),
                tx_id: tx_id,
            });

            // send locker fee even though swap failed
            let locker_fee_coin = coin::split(&mut fees_telebtc_coin, locker_fee_amt, ctx);
            send_locker_fee(locker_locking_script, locker_fee_coin, locker_cap, ctx);

            // merge remaining fee coins with the telebtc coin and deposit to vault
            let mut telebtc_coin = telebtc_coin;
            coin::join<TELEBTC>(&mut telebtc_coin, fees_telebtc_coin); // try to merge remaining fee coins with the telebtc coin
            let request_mut = table::borrow_mut(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
            cc_exchange_storage::set_request_remained_input_amount(request_mut, coin::value(&telebtc_coin));
            cc_exchange_storage::deposit_to_vault(storage, telebtc_coin); // deposit to vault
        }
    }

    /// Executes the swap routing for the request using Cetus flash swaps.
    /// The function consumes and returns Coin<T> outputs, ensuring proper ownership.
    ///
    /// Coin ownership and consumption:
    /// - Each swap consumes the input coin and returns updated coin pairs.
    /// - Only one of the returned output tokens will have non-zero value, depending on the target path.
    /// - Intermediate zero-value coins are still returned and must be transferred or destroyed by caller.
    ///
    /// Parameters:
    /// - config: Cetus config
    /// - pool_*: Cetus pools for all paths
    /// - locker_locking_script: Locker script (forwarded for fee handling paths)
    /// - request: Current request (read-only)
    /// - tx_id: Request id
    /// - telebtc_coin: TeleBTC input coin to spend
    /// - clock: Sui clock
    /// - ctx: Tx context
    ///
    /// Returns:
    /// - (success, telebtc_coin, wbtc_coin, sui_coin, usdt_coin, usdc_coin). Only the coin matching the
    ///   requested path will carry value; other returned coins are zero.
    fun execute_swap(
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<BTC, TELEBTC>,
        locker_locking_script: vector<u8>,
        request: &ExchangeRequest,
        tx_id: vector<u8>,
        telebtc_coin: Coin<TELEBTC>,
        total_fees: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): (bool, Coin<TELEBTC>, Coin<BTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) {
        
        // get info from request
        let target_token = cc_exchange_storage::target_token(request);
        let input_amount = cc_exchange_storage::input_amount(request) - total_fees; // the net amount we are going to swap
        let output_amount = cc_exchange_storage::output_amount(request);
        // get info from telebtc coin
        let telebtc_amount = coin::value(&telebtc_coin);
        assert!(telebtc_amount >= input_amount, EINVALID_AMOUNT);
        // create empty coin lists
        let mut telebtc_coins = vector::empty<Coin<TELEBTC>>();
        let mut wbtc_coins = vector::empty<Coin<BTC>>();
        let mut sui_coins = vector::empty<Coin<SUI>>();
        let mut usdt_coins = vector::empty<Coin<USDT>>();
        let mut usdc_coins = vector::empty<Coin<USDC>>();

        // put telebtc coin into the coin list
        vector::push_back(&mut telebtc_coins, telebtc_coin);

        if(target_token == 0) {
            // WBTC
            return dexconnector::mainSwapTokens_rev<BTC>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        } else if(target_token == 1) {
            // USDC
            return dexconnector::mainSwapTokens_rev<USDC>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        } else if(target_token == 2) {
            return dexconnector::mainSwapTokens_rev<USDT>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        } else if(target_token == 3) {
            return dexconnector::mainSwapTokens_rev<SUI>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        }
        else{
            abort EINVALID_TARGET_TOKEN;
        };

        // These should never be reached
        let wbtc_coin = coin::zero<BTC>(ctx);
        let sui_coin = coin::zero<SUI>(ctx);
        let usdt_coin = coin::zero<USDT>(ctx);
        let usdc_coin = coin::zero<USDC>(ctx);
        (false, telebtc_coin, wbtc_coin, sui_coin, usdt_coin, usdc_coin)
    }

    /// Distributes network, protocol and third-party fees and then forwards remaining locker fee to the locker.
    ///
    /// Fee semantics:
    /// - Network fee is transferred to the current transaction sender (teleporter).
    /// - Protocol fee is transferred to the configured treasury.
    /// - Third-party fee is transferred to the address mapped by the request's `third_party` id.
    /// - Remaining TeleBTC after splitting is the locker fee, which is sent to the locker or distributor.
    ///
    /// Parameters:
    /// - storage: Exchange storage capability
    /// - tx_id: Request id
    /// - locker_locking_script: Locker script for locker fee delivery path
    /// - remaining_coin: TeleBTC from which fees are split and transferred
    /// - locker_cap: Locker capability
    /// - ctx: Tx context
    fun send_fees(
        storage: &mut ExchangeCap,
        tx_id: vector<u8>,
        locker_locking_script: vector<u8>,
        mut remaining_coin: Coin<TELEBTC>,
        locker_cap: &LockerCap,
        ctx: &mut TxContext
    ) {
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        
        // Get fee amounts
        let third_party_fee = cc_exchange_storage::third_party_fee(request);
        let protocol_fee = cc_exchange_storage::protocol_fee(request);
        let network_fee = cc_exchange_storage::fee(request);
        let locker_fee = cc_exchange_storage::locker_fee(request);
        let rewarder_fee = cc_exchange_storage::rewarder_fee(request);

        // Split network fee coin
        if (network_fee > 0) {
            let network_fee_coin = coin::split(&mut remaining_coin, network_fee, ctx);
            // Transfer network fee to teleporter (msg.sender in Solidity)
            transfer::public_transfer(network_fee_coin, tx_context::sender(ctx));
        };
        
        // Split protocol fee coin
        if (protocol_fee > 0) {
            let protocol_fee_coin = coin::split(&mut remaining_coin, protocol_fee, ctx);
            // Transfer protocol fee to treasury
            transfer::public_transfer(protocol_fee_coin, cc_exchange_storage::treasury(storage));
        };
        
        // Split third party fee coin
        if (third_party_fee > 0) {
            let third_party_fee_coin = coin::split(&mut remaining_coin, third_party_fee, ctx);
            // Get third party address from storage
            let third_party_id = cc_exchange_storage::third_party(request);
            let third_party_address = cc_exchange_storage::get_third_party_address_from_storage(storage, third_party_id);
            // Transfer third party fee
            transfer::public_transfer(third_party_fee_coin, third_party_address);
        };

        if(rewarder_fee > 0) {
            let rewarder_fee_coin = coin::split(&mut remaining_coin, rewarder_fee, ctx);
            transfer::public_transfer(rewarder_fee_coin, cc_exchange_storage::rewarder_address(storage));
        };
        
        // Send locker fee to locker
        send_locker_fee(locker_locking_script, remaining_coin, locker_cap, ctx);
        
    }

    /// Sends the locker fee coin to the locker or a reward distributor if configured.
    /// If a non-zero `reward_distributor` is configured and third party id is zero, the locker fee
    /// may be routed to the distributor; otherwise, it is sent directly to the locker address
    /// resolved from the provided `locker_locking_script`.
    ///
    /// Parameters:
    /// - storage: Exchange storage capability
    /// - tx_id: Request id
    /// - locker_locking_script: Locker script used to resolve locker address
    /// - locker_fee_coin: TeleBTC coin containing only the locker fee
    /// - locker_cap: Locker capability
    /// - ctx: Tx context
    fun send_locker_fee(
        locker_locking_script: vector<u8>,
        mut locker_fee_coin: Coin<TELEBTC>,
        locker_cap: &LockerCap,
        ctx: &mut TxContext
    ) {
        // Get locker target address from locking script
        let locker_address = lockerstorage::get_locker_target_address_from_script(locker_locking_script, locker_cap);
        transfer::public_transfer(locker_fee_coin, locker_address);
    }

    /// Placeholder for filler flow. Will be implemented in next versions.
    public fun fill_tx(
        storage: &mut ExchangeCap,
        tx_id: vector<u8>,
        recipient: address,
        token: address,
        fill_amount: u64,
        user_requested_amount: u64,
        destination_chain_id: u64,
        bridge_percentage_fee: u64,
        locker_locking_script: vector<u8>
    ) {
        // Implement the fill logic in next version, leave it empty for now
    }

    /// Refunds by admin for failed swaps using TeleBTC stored in the exchange vault.
    ///
    /// Detailed behavior:
    /// - Checks that the caller is the owner recorded in `ExchangeAdmin`.
    /// - Ensures the request is not already completed, then sets `is_request_completed=true`.
    /// - Withdraws the exact `remained_input_amount` previously stored to the exchange vault when swap failed.
    /// - Calls `burn_router_locker_connector::unwrap` to proceed with cross-chain TeleBTC unwrapping.
    /// - Any returned BTC amount is ignored by this function; off-chain monitoring can correlate with events.
    ///
    /// Parameters:
    /// - storage: Exchange storage capability
    /// - tx_id: Request id (vector<u8> derived from Bitcoin data)
    /// - script_type: User Bitcoin script type
    /// - user_script: User Bitcoin script bytes
    /// - locker_locking_script: Locker locking script associated with the request
    /// - admin: Exchange admin
    /// - burn_router: BurnRouter object for unwrap
    /// - telebtc_cap: TeleBTC capability
    /// - treasury_cap: TeleBTC treasury capability
    /// - btcrelay: BTC relay object used in unwrap preconditions
    /// - locker_cap: Locker capability
    /// - ctx: Tx context
    public fun refund_by_admin(
        storage: &mut ExchangeCap,
        tx_id: vector<u8>,
        script_type: u8,
        user_script: vector<u8>,
        locker_locking_script: vector<u8>,
        admin: &ExchangeAdmin,
        burn_router: &mut BurnRouter,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        btcrelay: &BTCRelay,
        locker_cap: &mut LockerCap,
        ctx: &mut TxContext
    ) {
        // Assert admin ownership
        assert!(cc_exchange_storage::is_owner(admin, tx_context::sender(ctx)), ENOT_OWNER);

        // Check that transaction ID exists in the table
        assert!(table::contains(cc_exchange_storage::cc_exchange_requests(storage), tx_id), EINVALID_TXID);

        // Check that request has not been completed
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        assert!(!cc_exchange_storage::is_request_completed(request), EALREADY_USED);
        let failed_request_amount = cc_exchange_storage::remained_input_amount(request);
        let third_party_id = cc_exchange_storage::third_party(request);
        // drop immutable borrow of request here

        // Mark as completed
        let request_mut = table::borrow_mut(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        cc_exchange_storage::set_request_completed(request_mut, true);

        // Withdraw TeleBTC amount from exchange vault
        let amount_coin = cc_exchange_storage::withdraw_from_vault(storage, failed_request_amount, ctx);

        // Perform unwrap via connector
        let mut coins_vector = vector::empty<Coin<TELEBTC>>();
        vector::push_back(&mut coins_vector, amount_coin);
        let _refund_amount = burn_router_locker_connector::unwrap(
            burn_router,
            coins_vector,
            failed_request_amount,
            user_script,
            script_type,
            locker_locking_script,
            third_party_id,
            telebtc_cap,
            treasury_cap,
            btcrelay,
            locker_cap,
            ctx
        );

        // Emit RefundProcessed event
        let locker_target_address = lockerstorage::get_locker_target_address_from_script(locker_locking_script, locker_cap);
        event::emit(RefundProcessedLocal {
            tx_id,
            refunded_by: tx_context::sender(ctx),
            failed_request_amount: failed_request_amount,
            refund_amount: _refund_amount,
            user_script,
            script_type,
            locker_target_address,
            burn_request_counter: burn_router_storage::get_burn_request_counter(burn_router, locker_target_address),
        });
    }

    /// Parses and validates the Bitcoin side data, constructs and stores a new exchange request,
    /// and ensures the Bitcoin tx is finalized by consulting the BTC relay.
    ///
    /// Parsing details:
    /// - Derives `tx_id` from version, vin, vout, and locktime via deterministic hashing.
    /// - Extracts the input amount and application payload (OP_RETURN-esque) and validates exact length.
    /// - Decodes: app_id, recipient, network fee, speed, third_party id, desired token, output amount,
    ///   bridge fee (in 1e7 precision) which is scaled by 1e11 to 1e18 for internal storage.
    /// - Ensures network fee does not exceed input amount.
    /// - Initializes a new request with `is_used=true` to prevent replay and `is_request_completed=false`.
    /// - Sets `remained_input_amount` initially equal to input_amount (prior to fee calculation).
    /// - Verifies finalization via `btcrelay::checkTxProof` and aborts otherwise.
    ///
    /// Returns:
    /// - tx_id for the request derived from the Bitcoin transaction data
    fun cc_exchange_helper(
        tx_and_proof: TxAndProof,
        locker_locking_script: vector<u8>,
        storage: &mut ExchangeCap,
        btcrelay: &BTCRelay
    ): vector<u8> {
        // Validate that the BTCRelay object is the legitimate one
        assert!(cc_exchange_storage::validate_btcrelay(storage, btcrelay), EINVALID_BTCRELAY);

        // Calculate transaction ID (equivalent to BitcoinHelper.calculateTxId in Solidity)
        let tx_id = bitcoin_helper::calculate_tx_id(
            *cc_transfer_router_storage::version(&tx_and_proof),
            *cc_transfer_router_storage::vin(&tx_and_proof),
            *cc_transfer_router_storage::vout(&tx_and_proof),
            *cc_transfer_router_storage::locktime(&tx_and_proof)
        );

        // Check that the request has not been processed before
        assert!(!cc_exchange_storage::is_request_used(storage, tx_id), EALREADY_USED);

        // Extract value and OP_RETURN data from the request
        let (input_amount, arbitrary_data) = bitcoin_helper::parse_value_and_data_having_locking_script_small_payload(
            cc_transfer_router_storage::vout(&tx_and_proof),
            &locker_locking_script
        );

        // Validate data length and input amount
        assert!(arbitrary_data.length() == REQUEST_DATA_LENGTH, EINVALID_LENGTH);
        assert!(input_amount > 0, ENOT_ENOUGH_INPUT_AMOUNT);

        // Parse the 89-byte exchange request data 
        let app_id = request_parser::parse_app_id(&arbitrary_data) as u64;
        let recipient_address = request_parser::parse_recipient_address(&arbitrary_data);
        let network_fee = request_parser::parse_network_fee(&arbitrary_data);
        let speed = request_parser::parse_speed(&arbitrary_data) as u64;
        let third_party = request_parser::parse_third_party_id(&arbitrary_data) as u64;
        let exchange_token = request_parser::parse_exchange_token(&arbitrary_data);
        let output_amount = request_parser::parse_exchange_output_amount(&arbitrary_data);
        let bridge_fee = request_parser::parse_bridge_fee(&arbitrary_data);

        // Validate network fee
        assert!(network_fee <= input_amount, EINVALID_FEE);

        

        // Create exchange request following the exact structure from exchangelib.sol
        let exchange_request = cc_exchange_storage::new_exchange_request(
            storage,
            app_id,
            input_amount, // full amount (including all the fees)
            output_amount,
            true, // is_fixed_token - we assume input amount is fixed 
            recipient_address,
            network_fee,
            true, // is_used
            exchange_token, // target_token
            speed,
            false, // is_request_completed
            input_amount, // remained_input_amount (used for filler)
            bridge_fee * BRIDGE_FEE_MULTIPLIER, // bridge_percentage_fee (multiply by 10^11)
            third_party,
        );

        // Store the request in the storage cap
        table::add(cc_exchange_storage::cc_exchange_requests(storage), tx_id, exchange_request);

        // Verify transaction is confirmed using the relay from storage
        let is_confirm = btcrelay::checkTxProof(
            btcrelay,
            tx_id,
            cc_transfer_router_storage::block_number(&tx_and_proof),
            *cc_transfer_router_storage::intermediate_nodes(&tx_and_proof),
            cc_transfer_router_storage::index(&tx_and_proof)
        );
        assert!(is_confirm, ENOT_FINALIZED);

        tx_id
    }

    // used for telebtc-btc pair (package id generated is reverse)
    public fun wrap_and_swap_reverse(
        storage: &mut ExchangeCap,
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        tx_and_proof: TxAndProof,
        locker_locking_script: vector<u8>,
        btcrelay: &BTCRelay,
        locker_cap: &mut LockerCap,
        telebtc_cap: &mut TeleBTCCap,
        treasury_cap: &mut TreasuryCap<TELEBTC>,
        clock: &Clock,
        ctx: &mut TxContext
    ): bool {
        // Basic checks
        assert!(
            tx_context::sender(ctx) == cc_exchange_storage::special_teleporter(storage),
            EINVALID_TELEPORTER
        ); // Only Teleporter can submit requests
        
        assert!(
            cc_transfer_router_storage::block_number(&tx_and_proof) >= cc_exchange_storage::starting_block_number(storage),
            EOLD_REQUEST
        );
        
        assert!(
            bitcoin_helper::equalzero(cc_transfer_router_storage::locktime(&tx_and_proof)),
            ENON_ZERO_LOCKTIME
        );

        // Check that the given script hash is Locker
        assert!(
            lockerstorage::is_locker(locker_cap, locker_locking_script),
            ENOT_LOCKER
        );

        // Extract request info and check if tx has been finalized on Bitcoin
        let tx_id = cc_exchange_helper(
            tx_and_proof,
            locker_locking_script,
            storage,
            btcrelay
        );

        // Get the exchange request and extract needed values
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        let bridge_percentage_fee = cc_exchange_storage::bridge_percentage_fee(request);
        

        // Mint input amount of TeleBTC and calculate fees
        let (mut telebtcCoin, total_fees) = mint_and_calculate_fees(
            storage,
            locker_cap,
            telebtc_cap,
            treasury_cap,
            clock,
            locker_locking_script,
            tx_id,
            ctx
        );

        // split the TeleBTC coin into two coins: one for fees and one for the user
        let fees_telebtc_coin = coin::split(&mut telebtcCoin, total_fees, ctx);

        // Execute the wrap and swap operation
        execute_wrap_and_swap_reverse(
            storage,
            config,
            pool_usdc_sui,
            pool_usdc_usdt,
            pool_usdc_wbtc,
            pool_telebtc_wbtc,
            telebtcCoin,
            fees_telebtc_coin,
            locker_locking_script,
            tx_id,
            bridge_percentage_fee,
            locker_cap,
            clock,
            ctx
        );

        true
    }

    fun execute_wrap_and_swap_reverse(
        storage: &mut ExchangeCap,
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        telebtc_coin: Coin<TELEBTC>,
        mut fees_telebtc_coin: Coin<TELEBTC>,
        locker_locking_script: vector<u8>,
        tx_id: vector<u8>,
        bridge_percentage_fee: u64,
        locker_cap: &LockerCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Get the exchange request from storage and snapshot fields
        let request = table::borrow(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
        let recipient_addr = cc_exchange_storage::recipient_address(request);
        let locker_fee_amt = cc_exchange_storage::locker_fee(request);
        let input_amt_snapshot = cc_exchange_storage::input_amount(request);
        let total_fees = coin::value(&fees_telebtc_coin);

        // Execute the swap with individual parameters
        let (result, telebtc_coin, wbtc_coin, sui_coin, usdt_coin, usdc_coin) = execute_swap_reverse(
            config,
            pool_usdc_sui,
            pool_usdc_usdt,
            pool_usdc_wbtc,
            pool_telebtc_wbtc,
            locker_locking_script,
            request,
            tx_id,
            telebtc_coin,
            total_fees,
            clock,
            ctx
        );

        // Determine output amount and token before moving coins
        let out_wbtc = coin::value(&wbtc_coin);
        let out_sui = coin::value(&sui_coin);
        let out_usdt = coin::value(&usdt_coin);
        let out_usdc = coin::value(&usdc_coin);
        let (out_token_tn, out_amount) = if (out_wbtc > 0) {
            (type_name::get<BTC>(), out_wbtc)
        } else if (out_usdc > 0) {
            (type_name::get<USDC>(), out_usdc)
        } else if (out_sui > 0) {
            (type_name::get<SUI>(), out_sui)
        } else if (out_usdt > 0) {
            (type_name::get<USDT>(), out_usdt)
        } else { (type_name::get<TELEBTC>(), 0) };

        // Transfer destination coins to recipient (they may be zero-value)
        transfer::public_transfer(wbtc_coin, recipient_addr);
        transfer::public_transfer(sui_coin, recipient_addr);
        transfer::public_transfer(usdt_coin, recipient_addr);
        transfer::public_transfer(usdc_coin, recipient_addr);

        if(result) {
            // mark request as completed
            let request_mut = table::borrow_mut(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
            cc_exchange_storage::set_request_completed(request_mut, true);
            cc_exchange_storage::set_request_remained_input_amount(request_mut, 0);
            // emit swap success event
            event::emit(SwapSuccess {
                user: sui::tx_context::sender(ctx),
                input_token: type_name::get<TELEBTC>(),
                output_token: out_token_tn,
                input_amount: input_amt_snapshot,
                output_amount: out_amount,
                timestamp: sui::clock::timestamp_ms(clock),
                tx_id: tx_id,
            });

            // send fees to the teleporter, treasury, third party, and locker
            send_fees(storage, tx_id, locker_locking_script, fees_telebtc_coin, locker_cap, ctx);

            // send the remaining telebtc coin to the user (empty coin)
            transfer::public_transfer(telebtc_coin, recipient_addr);

        } else {
            // emit swap failure event
            event::emit(SwapFailure {
                user: sui::tx_context::sender(ctx),
                input_token: type_name::get<TELEBTC>(),
                output_token: out_token_tn,
                input_amount: input_amt_snapshot,
                reason: b"swap_failed",
                timestamp: sui::clock::timestamp_ms(clock),
                tx_id: tx_id, // the tx_id is in little-endian bytes
                // so if the admin want to refund, he should reverse the bytes to get the original tx_id
            });

            // send locker fee even though swap failed
            let locker_fee_coin = coin::split(&mut fees_telebtc_coin, locker_fee_amt, ctx);
            send_locker_fee(locker_locking_script, locker_fee_coin, locker_cap, ctx);

            // merge remaining fee coins with the telebtc coin and deposit to vault
            let mut telebtc_coin = telebtc_coin;
            coin::join<TELEBTC>(&mut telebtc_coin, fees_telebtc_coin); // try to merge remaining fee coins with the telebtc coin
            let request_mut = table::borrow_mut(cc_exchange_storage::cc_exchange_requests(storage), tx_id);
            cc_exchange_storage::set_request_remained_input_amount(request_mut, coin::value(&telebtc_coin));
            cc_exchange_storage::deposit_to_vault(storage, telebtc_coin); // deposit to vault
        }
    }

    fun execute_swap_reverse(
        config: &GlobalConfig,
        pool_usdc_sui: &mut pool::Pool<USDC, SUI>,
        pool_usdc_usdt: &mut pool::Pool<USDC, USDT>,
        pool_usdc_wbtc: &mut pool::Pool<USDC, BTC>,
        pool_telebtc_wbtc: &mut pool::Pool<TELEBTC, BTC>,
        locker_locking_script: vector<u8>,
        request: &ExchangeRequest,
        tx_id: vector<u8>,
        telebtc_coin: Coin<TELEBTC>,
        total_fees: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): (bool, Coin<TELEBTC>, Coin<BTC>, Coin<SUI>, Coin<USDT>, Coin<USDC>) {
        
        // get info from request
        let target_token = cc_exchange_storage::target_token(request);
        let input_amount = cc_exchange_storage::input_amount(request) - total_fees; // the net amount we are going to swap
        let output_amount = cc_exchange_storage::output_amount(request);
        // get info from telebtc coin
        let telebtc_amount = coin::value(&telebtc_coin);
        assert!(telebtc_amount >= input_amount, EINVALID_AMOUNT);
        // create empty coin lists
        let mut telebtc_coins = vector::empty<Coin<TELEBTC>>();
        let mut wbtc_coins = vector::empty<Coin<BTC>>();
        let mut sui_coins = vector::empty<Coin<SUI>>();
        let mut usdt_coins = vector::empty<Coin<USDT>>();
        let mut usdc_coins = vector::empty<Coin<USDC>>();

        // put telebtc coin into the coin list
        vector::push_back(&mut telebtc_coins, telebtc_coin);

        if(target_token == 0) {
            // WBTC
            return dexconnector::mainSwapTokens<BTC>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        } else if(target_token == 1) {
            // USDC
            return dexconnector::mainSwapTokens<USDC>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        } else if(target_token == 2) {
            return dexconnector::mainSwapTokens<USDT>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        } else if(target_token == 3) {
            return dexconnector::mainSwapTokens<SUI>(
                config,
                pool_usdc_sui,
                pool_usdc_usdt,
                pool_usdc_wbtc,
                pool_telebtc_wbtc,
                input_amount,
                output_amount,
                telebtc_coins,
                wbtc_coins,
                sui_coins,
                usdt_coins,
                usdc_coins,
                clock,
                ctx
            );
        }
        else{
            abort EINVALID_TARGET_TOKEN;
        };

        // These should never be reached
        let wbtc_coin = coin::zero<BTC>(ctx);
        let sui_coin = coin::zero<SUI>(ctx);
        let usdt_coin = coin::zero<USDT>(ctx);
        let usdc_coin = coin::zero<USDC>(ctx);
        (false, telebtc_coin, wbtc_coin, sui_coin, usdt_coin, usdc_coin)
    }

} 