#[allow(unused_field, unused_variable,unused_const,unused_use)]
module teleswap::burn_router_helper {
    use sui::table::{Self, Table};
    use teleswap::burn_router_storage::{Self, BurnRouter, BurnRequest, BURN_ROUTER_ADMIN};
    use teleswap::lockerstorage::{Self, LockerCap};
    use teleswap::bitcoin_helper::{Self};
    use teleswap::btcrelay::{Self,BTCRelay};
    
    // ===== CONSTANTS =====
    const MAX_PERCENTAGE_FEE: u64 = 10000; // 10000 means 100%
    
    // Error codes
    const EALREADY_PAID: u64 = 236;
    const EDEADLINE_NOT_PASSED: u64 = 237;
    const EOLD_REQUEST: u64 = 238;
    const ENOT_LOCKER: u64 = 239;
    const EWRONG_INPUTS: u64 = 240;
    const ENOT_FINALIZED: u64 = 241;
    const EALREADY_USED: u64 = 242;
    const EDEADLINE_NOT_PASSED_SLASH: u64 = 243;
    const EWRONG_OUTPUT_TX: u64 = 244;
    const ENOT_FOR_LOCKER: u64 = 245;
    const ENON_ZERO_LOCK_TIME: u64 = 246;
    const EWRONG_INDEXES: u64 = 247;
    const EINVALID_SCRIPT: u64 = 249;
    const EUNSORTED_VOUT_INDEXES: u64 = 250;

    // ===== STRUCTURES =====
    // P2PK: u8 = 1, 32bytes
    // P2WSH: u8 = 2, 32bytes
    // P2TR: u8 = 3, 32bytes
    // P2PKH: u8 = 4, 20bytes
    // P2SH: u8 = 5, 20bytes
    // P2WPKH: u8 = 6, 20bytes


    public struct DebugEvent has copy, drop {
            vec1: vector<u8>,
            vec2: vector<u8>,
            vec3: vector<u64>,
            vec4: vector<u64>,
            num1: u256,
            num2: u256,
            num3: u256,
            num4: u256,
            addr1: address,
            addr2: address,
            addr3: address,
            addr4: address,
            bool1: bool,
        }

    /// Local event for paid unwrap in helper
    public struct PaidUnwrapHelper has copy, drop {
        locker_target_address: address,
        request_id: u64,
        tx_id: vector<u8>,
        vout_index: u64,
    }

    // ===== PLACEHOLDER FUNCTIONS =====

    /// @notice Checks if all outputs of the transaction are used to pay a cross-chain burn request.
    /// @dev One output might return the remaining value to the locker. If all outputs are used for burn requests, or all but one (which returns to the locker), marks the tx as used for burn proof.
    /// @param is_used_as_burn_proof Table mapping tx_id to bool
    /// @param paid_output_counter Number of tx outputs that pay a burn request
    /// @param vout Outputs of a transaction
    /// @param locker_locking_script Locking script of locker
    /// @param tx_id Transaction id
    /// @return Whether the tx is now marked as used for burn proof
    public(package) fun update_is_used_as_burn_proof(
        is_used_as_burn_proof: &mut table::Table<vector<u8>, bool>,
        paid_output_counter: u64,
        vout: &vector<u8>,
        locker_locking_script: &vector<u8>,
        tx_id: &vector<u8>
    ): bool {
        let parsed_amount = bitcoin_helper::parse_value_having_locking_script(
            vout,
            locker_locking_script
        );
        let number_of_outputs = bitcoin_helper::number_of_outputs(vout);

        let should_mark =
            (parsed_amount == 0 && paid_output_counter == number_of_outputs)
            || (parsed_amount != 0 && paid_output_counter + 1 == number_of_outputs);

        if (should_mark) {
            table::add(is_used_as_burn_proof, *tx_id, true);
            true
        } else {
            false
        }
    }

    /// @notice Disputes a burn request when locker fails to provide proof after deadline.
    /// @dev Sets is_transferred to true to prevent double slashing. Checks deadline and request age.
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object
    /// @param locker_target_address The target address of the locker
    /// @param index The index of the burn request
    public(package) fun dispute_burn_helper(
        burn_router: &mut BurnRouter,
        btcrelay: &BTCRelay,
        locker_target_address: address,
        index: u64,
    ) {
        let starting_block_number = burn_router_storage::get_starting_block_number(burn_router);
        let transfer_deadline = burn_router_storage::get_transfer_deadline(burn_router);
        
        // Get the burn request
        let request = burn_router_storage::get_burn_request_mut(
            burn_router,
            locker_target_address,
            index
        );

        // Check that locker has not provided burn proof
        assert!(!burn_router_storage::is_transferred(request), EALREADY_PAID);

        // Check that payback deadline has passed
        let deadline = burn_router_storage::get_deadline(request);
        assert!(deadline < btcrelay::lastSubmittedHeight(btcrelay), EDEADLINE_NOT_PASSED);

        // Check that request is not too old
        assert!(deadline > starting_block_number + transfer_deadline, EOLD_REQUEST);

        // Set is_transferred = true to prevent slashing the locker again
        burn_router_storage::set_is_transferred(request, true);
    }

    /// @notice Disputes and slashes a malicious locker for a tx not matching any burn request.
    /// @dev Checks input/output txs, confirms tx, prevents double slashing, and verifies script.
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param versions [inputTxVersion, outputTxVersion]
    /// @param input_output_vin_vout [_inputVin, _outputVin, _outputVout]
    /// @param burn_router The BurnRouter object
    /// @param btcrelay The BTCRelay object
    /// @param input_tx_id The input tx id
    /// @param locktimes [inputTxLocktime, outputTxLocktime]
    /// @param input_intermediate_nodes Merkle proof for the malicious tx
    /// @param indexes_and_block_numbers [inputIndex, inputTxIndex, inputTxBlockNumber]
    public(package) fun dispute_and_slash_locker_helper(
        locker_locking_script: vector<u8>,
        versions: vector<vector<u8>>, // [inputTxVersion, outputTxVersion]
        input_output_vin_vout: vector<vector<u8>>, // [_inputVin, _outputVin, _outputVout]
        burn_router: &mut BurnRouter,
        btcrelay: &BTCRelay,
        input_tx_id: vector<u8>,
        locktimes: vector<vector<u8>>, // [inputTxLocktime, outputTxLocktime]
        input_intermediate_nodes: vector<u8>,
        indexes_and_block_numbers: vector<u64>, // [inputIndex, inputTxIndex, inputTxBlockNumber]
        locker_cap: & LockerCap
    ) {
        // 1. Check if the locking script is valid
        assert!(lockerstorage::is_locker_mock(locker_locking_script,locker_cap), ENOT_LOCKER);

        // 2. Check input array sizes
        assert!(vector::length(&versions) == 2 && vector::length(&locktimes) == 2 && vector::length(&indexes_and_block_numbers) == 3, EWRONG_INPUTS);

        // 3. Check that request is not too old
        let starting_block_number = burn_router_storage::get_starting_block_number(burn_router);
        let transfer_deadline = burn_router_storage::get_transfer_deadline(burn_router);
        let block_number = *vector::borrow(&indexes_and_block_numbers, 2); // inputTxBlockNumber
        assert!(block_number >= starting_block_number, EOLD_REQUEST);

        // 4. Check if transaction is confirmed
        let input_tx_index = *vector::borrow(&indexes_and_block_numbers, 1);
        assert!(btcrelay::checkTxProof(
            btcrelay,
            input_tx_id,
            block_number,
            input_intermediate_nodes,
            input_tx_index
        ), ENOT_FINALIZED);

        // 5. Check that input tx has not been provided as a burn proof
        assert!(!burn_router_storage::get_is_used_as_burn_proof(burn_router, input_tx_id), EALREADY_USED);

        // 6. Set is_used_as_burn_proof to prevent multiple slashing
        burn_router_storage::set_is_used_as_burn_proof(burn_router, input_tx_id, true);

        // 7. Check that deadline for using the tx as burn proof has passed
        assert!(btcrelay::lastSubmittedHeight(btcrelay) > transfer_deadline + block_number, EDEADLINE_NOT_PASSED_SLASH);

        // 8. Extract outpoint id and index from input tx
        let input_vin = vector::borrow(&input_output_vin_vout, 0);
        let outpoint_index = *vector::borrow(&indexes_and_block_numbers, 0);
        let (outpoint_id, outpoint_index_extracted) = bitcoin_helper::extract_outpoint(input_vin, outpoint_index);

        // 9. Check that "outpoint tx id == output tx id"
        let output_tx_id = bitcoin_helper::calculate_tx_id(
            *vector::borrow(&versions, 1),
            *vector::borrow(&input_output_vin_vout, 1),
            *vector::borrow(&input_output_vin_vout, 2),
            *vector::borrow(&locktimes, 1)
        );
        assert!(outpoint_id == output_tx_id, EWRONG_OUTPUT_TX);

        // 10. Check that _outpointIndex of _outpointId belongs to locker locking script
        let output_vout = vector::borrow(&input_output_vin_vout, 2);
        let locking_script_at_index = bitcoin_helper::get_locking_script(output_vout, outpoint_index_extracted);
        assert!(
            std::hash::sha2_256(locking_script_at_index) == std::hash::sha2_256(locker_locking_script),
            ENOT_FOR_LOCKER
        );
    }

    /// @notice Validates burn proof parameters for a Bitcoin transaction.
    /// @dev Checks block number, locktime, script validity, and index lengths.
    /// Validates that:
    /// - Block number is >= starting block number
    /// - Locktime is all zeros (no locktime)
    /// - Locker locking script is valid
    /// - Burn request indexes length matches vout indexes length
    /// @param block_number The block number of the tx
    /// @param starting_block_number The minimum valid block number
    /// @param locktime The locktime of the tx (should be all zeros)
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param burn_req_indexes_length Number of burn request indexes
    /// @param vout_indexes_length Number of vout indexes
    /// @param locker_cap The dummy locker capability
    public(package) fun burn_proof_helper(
        block_number: u64,
        starting_block_number: u64,
        locktime: vector<u8>,
        locker_locking_script: vector<u8>,
        burn_req_indexes_length: u64,
        vout_indexes_length: u64,
        locker_cap: & LockerCap
    ) {
        // Check that block_number >= starting_block_number
        assert!(block_number >= starting_block_number, EOLD_REQUEST);

        // Check that locktime is all zeros (no locktime)
        let mut is_all_zeros = true;
        let mut i = 0;
        let len = vector::length(&locktime);
        while (i < len) {
            if (*vector::borrow(&locktime, i) != 0u8) {
                is_all_zeros = false;
                break
            };
            i = i + 1;
        };
        assert!(is_all_zeros, ENON_ZERO_LOCK_TIME);

        // Check if the locking script is valid (must be a locker)
        assert!(lockerstorage::is_locker_mock(locker_locking_script,locker_cap), ENOT_LOCKER);

        // Check that burn_req_indexes_length == vout_indexes_length
        assert!(burn_req_indexes_length == vout_indexes_length, EWRONG_INDEXES);
    }

    /// @notice Checks the user script type and locker validity.
    /// @dev Ensures script length matches type and locker is valid.
    /// Validates that:
    /// - Script length matches the script type requirements
    /// - The given locking script belongs to a valid locker
    /// @param user_script The user's Bitcoin script
    /// @param script_type The script type (1=P2PK, 2=P2WSH, 3=P2TR, 4=P2PKH, 5=P2SH, 6=P2WPKH)
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @param locker_cap The dummy locker capability
    public(package) fun check_script_type_and_locker(
        user_script: vector<u8>,
        script_type: u8,
        locker_locking_script: vector<u8>,
        locker_cap: & LockerCap
    ) {
        // Check script length based on script type using existing helper function
        assert!(validate_script_length(&user_script, script_type), EINVALID_SCRIPT);

        // Check if the given locking script is locker
        assert!(lockerstorage::is_locker_mock(locker_locking_script,locker_cap), ENOT_LOCKER);
    }


    /// @notice Checks and marks burn requests as paid for a given transaction.
    /// @dev Iterates over provided indexes, marks requests as paid, and emits events.
    /// @param burn_router The BurnRouter object
    /// @param tx_id The transaction ID
    /// @param block_number The block number in which payment occurred
    /// @param locker_target_address The target address of the locker
    /// @param vout The outputs of the transaction
    /// @param burn_req_indexes Indexes of burn requests
    /// @param vout_indexes Indexes of outputs
    /// @return paid_output_counter Number of paid outputs
    public(package) fun check_paid_burn_requests(
        burn_router: &mut BurnRouter,
        tx_id: vector<u8>,
        block_number: u64,
        locker_target_address: address,
        vout: vector<u8>,
        burn_req_indexes: vector<u64>,
        vout_indexes: vector<u64>
    ): u64 {
        let mut paid_output_counter = 0;
        let mut temp_vout_index = 0u64;
        let len = vector::length(&burn_req_indexes);
        let mut i = 0;
        
        while (i < len) {
            let burn_req_index = *vector::borrow(&burn_req_indexes, i);
            let vout_index = *vector::borrow(&vout_indexes, i);

            // Prevent from sending repeated vout indexes
            if (i == 0) {
                temp_vout_index = vout_index;
            } else {
                // Get vout indexes in increasing order to ensure there is no duplicate
                assert!(vout_index > temp_vout_index, EUNSORTED_VOUT_INDEXES);
                temp_vout_index = vout_index;
            };

            // Get the burn request using the getter
            let request = burn_router_storage::get_burn_request(burn_router, locker_target_address, burn_req_index);

            // Check that the request has not been paid and its deadline has not passed
            if (!burn_router_storage::is_transferred(&request) && burn_router_storage::get_deadline(&request) >= block_number) {
                // Parse amount from specific output having script
                let parsed_amount = bitcoin_helper::parse_value_from_specific_output_having_script(
                    &vout,
                    vout_index,
                    &burn_router_storage::get_user_script(&request),
                    burn_router_storage::get_script_type(&request)
                );
                // Check that locker has sent required teleBTC amount
                if (burn_router_storage::get_burnt_amount(&request) == parsed_amount) {
                    // Set is_transferred = true using setter
                    let mut updated_request = request;
                    burn_router_storage::set_is_transferred(&mut updated_request, true);
                    burn_router_storage::set_burn_request(burn_router, locker_target_address, burn_req_index, updated_request);
                    
                    paid_output_counter = paid_output_counter + 1;

                    // Emit PaidUnwrapHelper event for each successful request
                    sui::event::emit(PaidUnwrapHelper {
                        locker_target_address,
                        request_id: burn_router_storage::get_request_id_of_locker(&updated_request),
                        tx_id: tx_id,
                        vout_index,
                    });
                };
            };
            i = i + 1;
        };

        paid_output_counter
    }

    /// @notice Prepares data for slashing a malicious locker for dispute.
    /// @dev Sums all output values, gets locker address, and calculates slasher reward.
    /// @param burn_router The BurnRouter object
    /// @param input_vout The outputs of the malicious transaction
    /// @param locker_locking_script The locker's Bitcoin locking script
    /// @return (locker_target_address, slasher_reward, total_value)
    public(package) fun prepare_slash_locker_for_dispute(
        burn_router: &BurnRouter,
        input_vout: vector<u8>,
        locker_locking_script: vector<u8>,
        locker_cap: & LockerCap
    ): (address, u64, u64) {
        // Find total value of malicious transaction (all outputs to locker)
        let total_value = bitcoin_helper::parse_outputs_total_value(&input_vout);
        // Get the target address of the locker from its Bitcoin address
        let locker_target_address = lockerstorage::get_locker_target_address_mock(locker_locking_script,locker_cap);
        // Get slasher reward and max percentage fee from storage
        let slasher_percentage_reward = burn_router_storage::get_slasher_percentage_reward(burn_router);
        let slasher_reward = (total_value * slasher_percentage_reward) / MAX_PERCENTAGE_FEE;
        (locker_target_address, slasher_reward, total_value)
    }

    // ===== HELPER FUNCTIONS =====
    /// @notice Validates script length based on type (P2PK, P2WSH, P2TR: 32 bytes; others: 20 bytes).
    /// @dev Validates that the script length matches the expected length for the given script type.
    /// Script types and their expected lengths:
    /// - P2PK (1): 32 bytes (public key hash)
    /// - P2WSH (2): 32 bytes (witness script hash)
    /// - P2TR (3): 32 bytes (taproot output key)
    /// - P2PKH (4): 20 bytes (public key hash)
    /// - P2SH (5): 20 bytes (script hash)
    /// - P2WPKH (6): 20 bytes (witness public key hash)
    /// @param user_script The user's Bitcoin script
    /// @param script_type The script type (1=P2PK, 2=P2WSH, 3=P2TR, 4=P2PKH, 5=P2SH, 6=P2WPKH)
    /// @return true if valid, false otherwise
    fun validate_script_length(user_script: &vector<u8>, script_type: u8): bool {
        //P2PK	33 or 65 bytes	Full public key, not a hash (maybe modify in the future)
        let script_length = vector::length(user_script);
        if (script_type == 1 || script_type == 2 || script_type == 3) {
            // P2PK, P2WSH, P2TR should be 32 bytes
            script_length == 32
        } else {
            // P2PKH, P2SH, P2WPKH should be 20 bytes
            script_length == 20
        }
    }
} 