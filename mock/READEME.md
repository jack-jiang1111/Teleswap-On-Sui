The mock version is for local test only.
We added lots of test only function which will be removed in the real time implementation

Also the btcrelay is in seperate module in mainnet deployment

dex connector: four main function

interface IDexConnector {
    function getInputAmount(
        uint _outputAmount,
        address _inputToken,
        address _outputToken
    ) external view returns (bool, uint);

    // this should take in input coin object, path, minimu output amount, return the output coin
    // the swap function should return a tuple, (swapresult,coins)
    // if the swap is sucess, return(true,output coin)
    // else, return (false, input coin)
    function swap(
        uint256 _inputAmount,
        uint256 _outputAmount,
        address[] memory _path,
        address _to,
        uint256 _deadline,
    ) external returns (bool, uint[] memory);

    function (private) isPathValid(address[] memory _path) external view returns(bool);

    // just take in the same parameter as swap, return a bool ( not the coin object, just the value of coin)
    function (priavte) checkExchangeConditions()
}


The problem is in sui-move programming. move contract

We will have a wrap and swap function, which takes in an object, and some other info about pool/token we can defined later
It will need to check the field of the object which is a token address, match with the path or pool variables we passed.
So this function will start to mint token Telebtc, then try to swap Telebtc to the target token, given the pool/token/ any other info we know. we will use cetus interface.

The interface support single token swap like this:
/// Exact-in quote helper:
/// - input_amount: amount of INPUT_TOKEN provided
/// - a_to_b: true for INPUT_TOKEN->OUTPUT_TOKEN, false for OUTPUT_TOKEN->INPUT_TOKEN
public fun getOutputAmount<TOKEN_A, TOKEN_B>(
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


There are totally four possibles
// USDC: telebtc->wbtc->usdc
// USDT: telebtc->wbtc->usdc->usdt
// SUI: telebtc->wbtc->usdc->sui
// WBTC: telebtc->wbtc

We know there are pools <USDC,SUI> <USDC,USDT> <USDC,WBTC> <TELEBTC,WBTC> order matters in sui I guess

How could we design the overall functions and input argument, or type args, or using generic. to achieve this goal? 



use 0x123::usdc::USDC;
use 0x456::wbtc::WBTC;
use 0x789::usdt::USDT;
use 0x2::sui::SUI;
use 0xabc::telebtc::TeleBTC;
use std::type_name;

struct Pools has key { // These are the preset pools, a to b order matter
    telebtc_wbtc: Pool<TeleBTC, WBTC>,
    usdc_wbtc: Pool<USDC, WBTC>,
    usdc_usdt: Pool<USDC, USDT>,
    usdc_sui: Pool<USDC, SUI>,
}

fun is_same<T1, T2>(): bool {
    type_name::get<T1>() == type_name::get<T2>()
}

public entry fun swap<TARGET>(
    sender: &signer,
    telebtc: coin<TeleBTC>,
    pools: &Pools,
    amount: u64
) {
    let telebtc = TeleBTC::mint(telebtc_mint_cap, amount, sender);

    if (is_same<TARGET, WBTC>()) {
        let wbtc = swap<TeleBTC, WBTC>(&pools.telebtc_wbtc, telebtc);
        coin::deposit(sender, wbtc); // instead of deposit, we return the coin
    } else if (is_same<TARGET, USDC>()) {
        let wbtc = swap<TeleBTC, WBTC>(&pools.telebtc_wbtc, telebtc);
        let usdc = swap<WBTC, USDC>(&pools.usdc_wbtc, wbtc);
        coin::deposit(sender, usdc);
    } else if (is_same<TARGET, USDT>()) {
        let wbtc = swap<TeleBTC, WBTC>(&pools.telebtc_wbtc, telebtc);
        let usdc = swap<WBTC, USDC>(&pools.usdc_wbtc, wbtc);
        let usdt = swap<USDC, USDT>(&pools.usdc_usdt, usdc);
        coin::deposit(sender, usdt);
    } else if (is_same<TARGET, SUI>()) {
        let wbtc = swap<TeleBTC, WBTC>(&pools.telebtc_wbtc, telebtc);
        let usdc = swap<WBTC, USDC>(&pools.usdc_wbtc, wbtc);
        let sui = swap<USDC, SUI>(&pools.usdc_sui, usdc);
        coin::deposit(sender, sui);
    } else {
        abort E_UNSUPPORTED_PATH;
    }
}
