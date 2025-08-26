module teleswap::request_parser {

    use sui::address;

    /// Error codes
    const EINVALID_LENGTH: u64 = 1;

    /// Constants for byte positions
    const APP_ID_INDEX: u64 = 0;

    const RECIPIENT_ADDRESS_START: u64 = 1;
    const RECIPIENT_ADDRESS_END: u64 = 32;  // 1 + 32 - 1 (Sui addresses are 32 bytes)
    
    const NETWORK_FEE_START: u64 = 33;
    const NETWORK_FEE_END: u64 = 36;

    const SPEED_INDEX: u64 = 37;

    const THIRD_PARTY_INDEX: u64 = 38;

    // Total 39 bytes for the transfer request
    // appId: 1 byte
    // recipientAddress: 32 bytes
    // networkFee: 4 bytes
    // speed: 1 byte
    // thirdParty: 1 byte

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

} 