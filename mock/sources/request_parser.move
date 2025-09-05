module teleswap::request_parser {

    use sui::address;

    /// Error codes
    const EINVALID_LENGTH: u64 = 1;

    // Constants for byte positions - Transfer Request (39 bytes)
    const APP_ID_INDEX: u64 = 411;
    const RECIPIENT_ADDRESS_START: u64 = 412;
    const RECIPIENT_ADDRESS_END: u64 = 413;  // 1 + 32 - 1 (Sui addresses are 32 bytes)
    const NETWORK_FEE_START: u64 = 414;
    const NETWORK_FEE_END: u64 = 417;
    const SPEED_INDEX: u64 = 418;
    const THIRD_PARTY_INDEX: u64 = 419;
    const TRANSFER_REQUEST_LENGTH: u64 = 420;

    // Constants for byte positions - Exchange Request (58 bytes)
    // appId: 1 byte (0)
    // recipientAddress: 32 bytes (1-32)
    // networkFee: 4 bytes (33-36)
    // speed: 1 byte (37)
    // thirdParty: 1 byte (38)

    // The rest of the bytes (39-57) is for the exchange request
    // exchangeToken: 1 byte (39) (0: WBTC, 1: USDC, 2: USDT, 3: SUI) because sui can't recoginize address into type
    // outputAmount: 14 bytes (40-53)
    // bridgeFee: 4 bytes (54-57)
    const EXCHANGE_TOKEN_START: u64 = 39;
    const OUTPUT_AMOUNT_START: u64 = 40;
    const OUTPUT_AMOUNT_END: u64 = 53;
    const BRIDGE_FEE_START: u64 = 54;
    const BRIDGE_FEE_END: u64 = 57;
    const EXCHANGE_REQUEST_LENGTH: u64 = 58;

    /// Parse app ID from the request data (1 byte to u8)
    public fun parse_app_id(data: &vector<u8>): u8 {
        assert!(data.length() >= THIRD_PARTY_INDEX, EINVALID_LENGTH);
        *vector::borrow(data, APP_ID_INDEX)
    }

    /// Parse recipient address from the request data (32 bytes to address)
    public fun parse_recipient_address(data: &vector<u8>): address {
        assert!(data.length() >= THIRD_PARTY_INDEX, EINVALID_LENGTH);
        let mut addr_bytes = vector::empty<u8>();
        let mut i = RECIPIENT_ADDRESS_START;
        while (i <= RECIPIENT_ADDRESS_END) {
            vector::push_back(&mut addr_bytes, *vector::borrow(data, i));
            i = i + 1;
        };

        // addr_bytes must be exactly 32 bytes, or the function will abort with EAddressParseError.
        // Convert 32 bytes to address using sui::address::from_bytes
        address::from_bytes(addr_bytes)
    }

    /// Parse network fee from the request data (4 bytes to u64)
    public fun parse_network_fee(data: &vector<u8>): u64 {
        assert!(data.length() >= THIRD_PARTY_INDEX, EINVALID_LENGTH);
        let mut fee: u64 = 0;
        let mut i = NETWORK_FEE_START;
        while (i <= NETWORK_FEE_END) {
            fee = (fee << 8) | (*vector::borrow(data, i) as u64);
            i = i + 1;
        };
        fee
    }

    /// Parse speed from the request data (1 byte to u8)
    public fun parse_speed(data: &vector<u8>): u8 {
        assert!(data.length() >= THIRD_PARTY_INDEX, EINVALID_LENGTH);
        *vector::borrow(data, SPEED_INDEX)
    }

    /// Parse third party ID from the request data (1 byte to u8)
    public fun parse_third_party_id(data: &vector<u8>): u8 {
        assert!(data.length() >= THIRD_PARTY_INDEX, EINVALID_LENGTH);
        *vector::borrow(data, THIRD_PARTY_INDEX)
    }

    /// Parse exchange token address from the request data (1 byte to u8)
    public fun parse_exchange_token(data: &vector<u8>): u8 {
        assert!(data.length() >= EXCHANGE_REQUEST_LENGTH, EINVALID_LENGTH);
        *vector::borrow(data, EXCHANGE_TOKEN_START)
    }

    /// Parse output amount from the request data (14 bytes to u64)
    public fun parse_exchange_output_amount(data: &vector<u8>): u64 {
        assert!(data.length() >= EXCHANGE_REQUEST_LENGTH, EINVALID_LENGTH);
        let mut amount: u64 = 0;
        let mut i = OUTPUT_AMOUNT_START;
        while (i <= OUTPUT_AMOUNT_END) {
            amount = (amount << 8) | (*vector::borrow(data, i) as u64);
            i = i + 1;
        };
        amount
    }

    /// Parse bridge fee from the request data (4 bytes to u64)
    public fun parse_bridge_fee(data: &vector<u8>): u64 {
        assert!(data.length() >= EXCHANGE_REQUEST_LENGTH, EINVALID_LENGTH);
        let mut fee: u64 = 0;
        let mut i = BRIDGE_FEE_START;
        while (i <= BRIDGE_FEE_END) {
            fee = (fee << 8) | (*vector::borrow(data, i) as u64);
            i = i + 1;
        };
        fee
    }

    /// Check if data is a transfer request (39 bytes)
    public fun is_transfer_request(data: &vector<u8>): bool {
        data.length() == TRANSFER_REQUEST_LENGTH
    }

    /// Check if data is an exchange request (89 bytes)
    public fun is_exchange_request(data: &vector<u8>): bool {
        data.length() == EXCHANGE_REQUEST_LENGTH
    }

} 