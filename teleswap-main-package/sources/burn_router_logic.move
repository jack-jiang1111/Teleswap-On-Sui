#[allow(unused_use,unused_variable,unused_const,unused_mut_parameter,unused_field)]
module teleswap::burn_router_logic {
    use sui::table::{Self, Table};
    use teleswap::burn_router_storage::{Self, BurnRouter, BurnRequest, BURN_ROUTER_ADMIN};
    use teleswap::burn_router_helper::{Self};
    use btcrelay::btcrelay::{Self, BTCRelay};
    
    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    const DUST_SATOSHI_AMOUNT: u64 = 1000;
    
    // Error codes
    const EZERO_ADDRESS: u64 = 1;
    const ENOT_ORACLE: u64 = 2;
    const ELOW_STARTING_BLOCK: u64 = 3;
    const EINVALID_FEE: u64 = 4;
    const EINVALID_REWARD: u64 = 5;
    const ELOW_DEADLINE: u64 = 6;
    const ENOT_LOCKER: u64 = 7;
    const ETRANSFER_FAILED: u64 = 8;
    const EEXCHANGE_FAILED: u64 = 9;
    const EINVALID_PATH: u64 = 10;
    const EWRONG_AMOUNTS: u64 = 11;
    const EINVALID_AMOUNT: u64 = 12;
    const ELOW_AMOUNT: u64 = 13;
    const EFEE_TRANSFER_FAILED: u64 = 14;
    const ETHIRD_PARTY_FEE_TRANSFER_FAILED: u64 = 15;
    const ENETWORK_FEE_TRANSFER_FAILED: u64 = 16;
    const EALREADY_PAID: u64 = 17;
    const EDEADLINE_NOT_PASSED: u64 = 18;
    const EOLD_REQUEST: u64 = 19;
    const EWRONG_INPUTS: u64 = 20;
    const ENOT_FINALIZED: u64 = 21;
    const EALREADY_USED: u64 = 22;
    const EDEADLINE_NOT_PASSED_SLASH: u64 = 23;
    const EWRONG_OUTPUT_TX: u64 = 24;
    const ENOT_FOR_LOCKER: u64 = 25;
    const ENON_ZERO_LOCK_TIME: u64 = 26;
    const EWRONG_INDEXES: u64 = 27;
    const ELOW_FEE: u64 = 28;
    const EINVALID_SCRIPT: u64 = 29;
    const EUNSORTED_VOUT_INDEXES: u64 = 30;
    const EINVALID_BURN_PROOF: u64 = 31;

    // ===== STRUCTURES =====
    public struct ScriptTypes has drop {
        P2PK: u8,
        P2WSH: u8,
        P2TR: u8,
        P2PKH: u8,
        P2SH: u8,
        P2WPKH: u8,
    }

    // ===== EVENTS =====
    public struct NewRelay has copy, drop {
        old_relay: address,
        new_relay: address,
    }

    public struct NewLockers has copy, drop {
        old_lockers: address,
        new_lockers: address,
    }

    public struct NewTeleBTC has copy, drop {
        old_tele_btc: address,
        new_tele_btc: address,
    }

    public struct NewTreasury has copy, drop {
        old_treasury: address,
        new_treasury: address,
    }

    public struct NewTransferDeadline has copy, drop {
        old_deadline: u64,
        new_deadline: u64,
    }

    public struct NewProtocolPercentageFee has copy, drop {
        old_fee: u64,
        new_fee: u64,
    }

    public struct NewSlasherPercentageFee has copy, drop {
        old_reward: u64,
        new_reward: u64,
    }

    public struct NewNetworkFeeOracle has copy, drop {
        old_oracle: address,
        new_oracle: address,
    }

    public struct NewNetworkFee has copy, drop {
        old_fee: u64,
        new_fee: u64,
    }

    public struct NewThirdPartyAddress has copy, drop {
        third_party_id: u64,
        old_address: address,
        new_address: address,
    }

    public struct NewThirdPartyFee has copy, drop {
        third_party_id: u64,
        old_fee: u64,
        new_fee: u64,
    }

    public struct NewWrappedNativeToken has copy, drop {
        old_token: address,
        new_token: address,
    }

    public struct NewUnwrap has copy, drop {
        user_script: vector<u8>,
        script_type: u8,
        locker_target_address: address,
        sender: address,
        request_id: u64,
        deadline: u64,
        third_party: u64,
        input_token: address,
        amounts: vector<u64>,
        fees: vector<u64>,
    }

    public struct PaidUnwrap has copy, drop {
        locker_target_address: address,
        request_id: u64,
        tx_id: vector<u8>,
        vout_index: u64,
    }

    public struct BurnDispute has copy, drop {
        sender: address,
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        request_id: u64,
    }

    public struct LockerDispute has copy, drop {
        locker_target_address: address,
        locker_locking_script: vector<u8>,
        block_number: u64,
        tx_id: vector<u8>,
        total_value_slashed: u64,
    }

    // ===== PLACEHOLDER FUNCTIONS =====
    fun init(ctx: &mut TxContext){

    }
    /// @notice Initializes the burn router contract
    public fun initialize(
        burn_admin: &BURN_ROUTER_ADMIN,
        burn_router: &mut BurnRouter,
        starting_block_number: u64,
        relay: address,
        lockers: address,
        treasury: address,
        tele_btc: address,
        transfer_deadline: u64,
        protocol_percentage_fee: u64,
        locker_percentage_fee: u64,
        slasher_percentage_reward: u64,
        network_fee: u64,
        wrapped_native_token: address,
        ctx: &mut TxContext
    ) {
        // TODO: Initialize burn router with provided parameters
        // TODO: Set all the configuration values
        // TODO: Validate parameters
    }

    /// @notice Records users burn request
    /// @return burnt_amount Amount of BTC that user receives
    public fun unwrap(
        burn_router: &mut BurnRouter,
        amount: u64,
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        third_party: u64,
        ctx: &mut TxContext
    ): u64 {
        // TODO: Transfer user's teleBTC to contract
        // TODO: Call _unwrap function
        // TODO: Return burnt amount
        0
    }

    /// @notice Exchanges input token for teleBTC then burns it
    /// @return Amount of BTC that user receives
    public fun swap_and_unwrap(
        burn_router: &mut BurnRouter,
        exchange_connector: address,
        amounts: vector<u64>,
        is_fixed_token: bool,
        path: vector<address>,
        deadline: u64,
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        third_party: u64,
        ctx: &mut TxContext
    ): u64 {
        // Notice:Will implement this when exchange connector is implemented
        // TODO: Exchange input token for teleBTC
        // TODO: Call _swap_and_unwrap function
        // TODO: Return amount
        0
    }

    /// @notice Checks the correctness of burn proof (which is a Bitcoin tx)
    /// @return true if burn proof is valid
    public fun burn_proof(
        burn_router: &mut BurnRouter,
        version: vector<u8>,
        vin: vector<u8>,
        vout: vector<u8>,
        locktime: vector<u8>,
        block_number: u64,
        intermediate_nodes: vector<u8>,
        index: u64,
        locker_locking_script: vector<u8>,
        burn_req_indexes: vector<u64>,
        vout_indexes: vector<u64>,
        ctx: &mut TxContext
    ): bool {
        // TODO: Get the Locker target address
        // TODO: Validate caller is locker or oracle
        // TODO: Call burn_proof_helper
        // TODO: Calculate transaction ID
        // TODO: Check transaction confirmation
        // TODO: Check paid burn requests
        // TODO: Update is_used_as_burn_proof
        // TODO: Return true if valid
        false
    }

    /// @notice Slashes a locker if did not pay a cc burn request before its deadline
    public fun dispute_burn(
        burn_admin: &BURN_ROUTER_ADMIN,
        burn_router: &mut BurnRouter,
        locker_locking_script: vector<u8>,
        indices: vector<u64>,
        ctx: &mut TxContext
    ) {
        // TODO: Check if the locking script is valid
        // TODO: Get the target address of the locker
        // TODO: Process each index in indices
        // TODO: Call dispute_burn_helper for each index
        // TODO: Slash locker and send amount to user
        // TODO: Emit BurnDispute event
    }

    /// @notice Slashes a locker if they issue a tx that doesn't match any burn request
    public fun dispute_locker(
        burn_admin: &BURN_ROUTER_ADMIN,
        burn_router: &mut BurnRouter,
        locker_locking_script: vector<u8>,
        versions: vector<vector<u8>>, // [inputTxVersion, outputTxVersion]
        input_vin: vector<u8>,
        input_vout: vector<u8>,
        output_vin: vector<u8>,
        output_vout: vector<u8>,
        locktimes: vector<vector<u8>>, // [inputTxLocktime, outputTxLocktime]
        input_intermediate_nodes: vector<u8>,
        indexes_and_block_numbers: vector<u64>, // [inputIndex, inputTxIndex, inputTxBlockNumber]
        ctx: &mut TxContext
    ) {
        // TODO: Calculate input tx id
        // TODO: Call dispute_and_slash_locker_helper
        // TODO: Slash locker for dispute
    }
} 