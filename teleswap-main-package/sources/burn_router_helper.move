#[allow(unused_field, unused_variable,unused_const,unused_use)]
module teleswap::burn_router_helper {
    use sui::table::{Self, Table};
    use teleswap::burn_router_storage::{Self, BurnRouter, BurnRequest, BURN_ROUTER_ADMIN};
    
    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    
    // Error codes
    const EALREADY_PAID: u64 = 3;
    const EDEADLINE_NOT_PASSED: u64 = 4;
    const EOLD_REQUEST: u64 = 5;
    const ENOT_LOCKER: u64 = 6;
    const EWRONG_INPUTS: u64 = 7;
    const ENOT_FINALIZED: u64 = 8;
    const EALREADY_USED: u64 = 9;
    const EDEADLINE_NOT_PASSED_SLASH: u64 = 10;
    const EWRONG_OUTPUT_TX: u64 = 11;
    const ENOT_FOR_LOCKER: u64 = 12;
    const ENON_ZERO_LOCK_TIME: u64 = 13;
    const EWRONG_INDEXES: u64 = 14;
    const ELOW_FEE: u64 = 15;
    const EINVALID_SCRIPT: u64 = 16;
    const EUNSORTED_VOUT_INDEXES: u64 = 17;

    // ===== STRUCTURES =====
    public struct ScriptTypes has drop {
        P2PK: u8,
        P2WSH: u8,
        P2TR: u8,
        P2PKH: u8,
        P2SH: u8,
        P2WPKH: u8,
    }

    // ===== PLACEHOLDER FUNCTIONS =====

    /// @notice Checks if all outputs of the transaction used to pay a cc burn request
    /// @dev One output might return the remaining value to the locker
    public fun update_is_used_as_burn_proof(
        burn_router: &mut BurnRouter,
        paid_output_counter: u64,
        vout: vector<u8>,
        locker_locking_script: vector<u8>,
        tx_id: vector<u8>
    ): bool {
        // TODO: Implement Bitcoin transaction parsing logic
        // TODO: Check if all outputs pay cc burn requests or one output sends remaining value to locker
        // TODO: Set is_used_as_burn_proof to true if conditions are met
        false
    }

    /// @notice Disputes a burn request when locker fails to provide proof
    public fun dispute_burn_helper(
        burn_router: &mut BurnRouter,
        locker_target_address: address,
        index: u64,
        transfer_deadline: u64,
        last_submitted_height: u64,
        starting_block_number: u64
    ) {
        // TODO: Check that locker has not provided burn proof
        // TODO: Check that payback deadline has passed
        // TODO: Check that request is not too old
        // TODO: Set is_transferred = true to prevent slashing the locker again
    }

    /// @notice Disputes and slashes a malicious locker
    public fun dispute_and_slash_locker_helper(
        lockers: address,
        locker_locking_script: vector<u8>,
        versions: vector<vector<u8>>, // [inputTxVersion, outputTxVersion]
        input_output_vin_vout: vector<vector<u8>>, // [_inputVin, _outputVin, _outputVout]
        burn_router: &mut BurnRouter,
        transfer_deadline: u64,
        starting_block_number: u64,
        input_tx_id: vector<u8>,
        locktimes: vector<vector<u8>>, // [inputTxLocktime, outputTxLocktime]
        input_intermediate_nodes: vector<u8>,
        indexes_and_block_numbers: vector<u64> // [inputIndex, inputTxIndex, inputTxBlockNumber]
    ) {
        // TODO: Check if the locking script is valid
        // TODO: Check input array sizes
        // TODO: Check that request is not too old
        // TODO: Check if transaction is confirmed
        // TODO: Check that input tx has not been provided as a burn proof
        // TODO: Set is_used_as_burn_proof to prevent multiple slashing
        // TODO: Check that deadline for using the tx as burn proof has passed
        // TODO: Extract outpoint id and index from input tx
        // TODO: Check that "outpoint tx id == output tx id"
        // TODO: Check that _outpointIndex of _outpointId belongs to locker locking script
    }

    /// @notice Validates burn proof parameters
    public fun burn_proof_helper(
        block_number: u64,
        starting_block_number: u64,
        locktime: vector<u8>,
        lockers: address,
        locker_locking_script: vector<u8>,
        burn_req_indexes_length: u64,
        vout_indexes_length: u64
    ) {
        // TODO: Check that block_number >= starting_block_number
        // TODO: Check that locker's tx doesn't have any locktime
        // TODO: Check if the locking script is valid
        // TODO: Check that burn_req_indexes_length == vout_indexes_length
    }

    /// @notice Checks inclusion of the transaction in the specified block
    /// @dev Calls the relay contract to check Merkle inclusion proof
    public fun is_confirmed(
        tx_id: vector<u8>,
        block_number: u64,
        intermediate_nodes: vector<u8>,
        index: u64
    ): bool {
        // TODO: Find fee amount from relay
        // TODO: Check if msg.value >= fee_amount
        // TODO: Call relay contract to check transaction proof
        // TODO: Send extra value back to msg.sender
        // TODO: Return confirmation result
        false
    }

    /// @notice Checks the user hash script to be valid (based on its type)
    public fun check_script_type_and_locker(
        user_script: vector<u8>,
        script_type: u8,
        lockers: address,
        locker_locking_script: vector<u8>
    ) {
        // TODO: Check script length based on script type
        // TODO: Check if the given locking script is locker
    }


    /// @notice Records burn request of user
    /// @return request_id The ID of the created burn request
    public fun save_burn_request(
        burn_router: &mut BurnRouter,
        amount: u64,
        burnt_amount: u64,
        user_script: vector<u8>,
        script_type: u8,
        last_submitted_height: u64,
        locker_target_address: address,
        transfer_deadline: u64,
        sender: address
    ): u64 {
        // TODO: Create burn request with proper parameters
        // TODO: Set deadline = last_submitted_height + transfer_deadline
        // TODO: Set is_transferred = false
        // TODO: Set request_id_of_locker = current counter
        // TODO: Increment counter
        // TODO: Add request to burn_requests array
        // TODO: Return request_id
        0
    }

    /// @notice Checks the burn requests that get paid by this transaction
    /// @return paid_output_counter Number of executed burn requests
    public fun check_paid_burn_requests(
        burn_router: &mut BurnRouter,
        paid_block_number: u64,
        locker_target_address: address,
        vout: vector<u8>,
        burn_req_indexes: vector<u64>,
        vout_indexes: vector<u64>
    ): u64 {
        // TODO: Initialize paid_output_counter = 0
        // TODO: Loop through burn_req_indexes
        // TODO: Prevent sending repeated vout indexes
        // TODO: Check that request has not been paid and deadline has not passed
        // TODO: Parse amount from specific output having script
        // TODO: Check that locker has sent required teleBTC amount
        // TODO: Set is_transferred = true and increment paid_output_counter
        // TODO: Return paid_output_counter
        0
    }

    /// @notice Prepares data for slashing the malicious locker
    /// @return locker_target_address Address of the locker to slash
    /// @return slasher_reward Reward amount for the slasher
    /// @return total_value Total value to slash
    public fun prepare_slash_locker_for_dispute(
        lockers: address,
        input_vout: vector<u8>,
        locker_locking_script: vector<u8>,
        slasher_percentage_reward: u64
    ): (address, u64, u64) {
        // TODO: Find total value of malicious transaction
        // TODO: Get the target address of the locker from its Bitcoin address
        // TODO: Calculate slasher reward = (total_value * slasher_percentage_reward) / MAX_PERCENTAGE_FEE
        // TODO: Return (locker_target_address, slasher_reward, total_value)
        (@0x0, 0, 0)
    }

    // ===== HELPER FUNCTIONS =====

    /// @notice Creates a new ScriptTypes instance
    public fun create_script_types(): ScriptTypes {
        ScriptTypes {
            P2PK: 0,
            P2WSH: 1,
            P2TR: 2,
            P2PKH: 3,
            P2SH: 4,
            P2WPKH: 5,
        }
    }

    /// @notice Validates script type
    public fun is_valid_script_type(script_type: u8): bool {
        script_type <= 5
    }

    /// @notice Validates script length based on type
    public fun validate_script_length(user_script: &vector<u8>, script_type: u8): bool {
        let script_length = vector::length(user_script);
        if (script_type == 0 || script_type == 1 || script_type == 2) {
            // P2PK, P2WSH, P2TR should be 32 bytes
            script_length == 32
        } else {
            // P2PKH, P2SH, P2WPKH should be 20 bytes
            script_length == 20
        }
    }
} 