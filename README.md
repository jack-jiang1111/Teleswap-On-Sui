# TeleswapSui

A decentralized Bitcoin-Sui bridge implementation that enables secure cross-chain transactions between Bitcoin and Sui networks.

## Overview

TeleswapSui is a bridge protocol that:
- Verifies Bitcoin transactions on Sui network
- Enables BTC-SUI asset swaps
- Implements SPV (Simplified Payment Verification) for Bitcoin headers
- Provides secure cross-chain transaction verification

## Prerequisites

- Sui CLI installed: https://docs.sui.io/guides/developer/getting-started
- Sui network connection: https://docs.sui.io/guides/developer/getting-started/local-network
- Move language compiler
- Git
- Node.js and npm

## Getting Started

1. Clone the repository:
```bash
git clone https://github.com/jack-jiang1111/teleswapSui.git
cd teleswapSui
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
sui move build
```

4. Start a local Sui network:
```bash
RUST_LOG="off,sui_node=info" sui start --with-faucet
```

5. Verify network is running:
```bash
curl --location --request POST 'http://127.0.0.1:9000' \
--header 'Content-Type: application/json' \
--data-raw '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sui_getTotalTransactionBlocks",
  "params": []
}'
```

6. Configure local network:
```bash
# Create new environment
sui client new-env --alias local --rpc http://127.0.0.1:9000

# Switch to local environment
sui client switch --env local

# Check active environment
sui client active-env

# Get active address
sui client active-address

# Check gas balance
sui client gas

# Request gas from faucet if needed
sui client faucet
```

7. Run tests:
```bash
# Need to start a local Sui network and get some faucet token first
# Also need to run the test file one by one (transaction will conflict)

# Option 1: Run all tests sequentially using scripts
# PowerShell (Windows):
.\scripts\runtest\run-tests.ps1

# Batch file (Windows):
.\scripts\runtest\run-tests.bat

# Node.js (Cross-platform):
node scripts/runtest/run-tests.js

# Option 2: Run tests individually
npm test -- tests/btcrelay.test.ts
npm test -- tests/telebtc.test.ts
npm test -- tests/transfer.test.ts
npm test -- tests/burn.test.ts
npm test -- tests/locker.test.ts
```

8. Deploy the contract:
before deploy the contract, need to fetch some test coin on faceut
```bash
# Deploy the contract to mainnet/testnet/devnet, use --real_relay flag if use real btcrelay (otherise use mock btcrelay)
npx ts-node scripts/deploy/01-deploy_btc_relay.ts [network]

# Modified the starting period/height in file 02-initialize_btc_relay.ts
# Initialze the contract on mainnet/testnet/devnet 
npx ts-node scripts/deploy/02-initialize_btc_relay.ts [network]

# Deploy mock usdt/wbtc/usdc on testnet/devnet (skip on mainnet)
npx ts-node scripts/deploy/03-deploy_mock_tokens.ts testnet

# Deploy teleswap main package 
npx ts-node scripts/deploy/04-deploy_main_package.ts [network]

# Initialized the main package, modify the constant in 05-initialized_package.ts
npx ts-node scripts/deploy/05-initialize_package.ts [network]

# Mint mock token
npx ts-node scripts/testnet/mint_mock_coins.ts

# Set up locker and wrap some telebtc
npx ts-node scripts/sdk/test-wrap.ts

# create cetus pools
npx ts-node scripts/testnet/create_cetus_pools.ts --override

# test wrap and swap
npx ts-node scripts/testnet/test_wrapAndswap.ts

# test unwrap
npx ts-node scripts/testnet/test_unwrap.ts
```

## License
MIT


## Some note about general design (diff from evm contract)
1. Contracts will be upgraded using the upgrade Cap. The upgrade Cap will be assigned to deployer when deploying the contract
2. Package id won't change when upgrading the contract (In Move, the address must be known at compile time for use statements. You cannot dynamically import a module at runtime.)
3. The bridge/locker/burner/exchange/telebtc contracts will depend on each other by "use module"


## SDK Function Status

### ✅ Completed Functions



#### Quote Functions
- [x] `getQuote()` - Get quote for TELEBTC trading (returns [boolean, number])

#### Burn Router Functions
- [ ] `unwrap()` - Unwrap tokens from wrapped state
- [ ] `swapAndUnwrap()` - Swap and unwrap tokens
- [ ] `burnProof()` - Burn proof verification and token minting

#### CC Exchange Functions
- [x] `wrapAndSwap()` - Wrap tokens and perform swap
- [x] `refundByAdmin()` - Refund by admin (admin only function)

#### CC Transfer Router Functions
- [x] `wrap()` - Wrap (cc_transfer) with TxAndProof construction
- [x] `requestToBecomeLocker()` - Request to become a locker
- [x] `addLocker()` - Add locker (admin function)

#### BTC Relay Functions
- [x] `addHeadersWithRetarget()` - Check scripts/sdk/update-relay.ts for usage
- [x] `addHeaders()` - Check scripts/sdk/update-relay.ts for usage



## Other TODOs
```
-- Three version of the projects
-- localnet mock version: only available to local test
-- test version: besides from wbtc/usdc/usdc and btcrelay, all other files remain the same as mainnet
-- mainnet version: ready to ship version
```
## TODO:
```
7. security
  - safe math rescan all files
  - reentrancy issue rescan
8. gas improvement

WBTC MAINNET: 0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC
(A,B) order matter since the cetus decide the (a>b)

we add another version in dexconnector, testing it first
GLOBAL CONFIG IN TESTNET: 0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e

upgrade the package via cli: sui client upgrade --gas-budget 750000000 --upgrade-capability 0xdead90b38cd97b0afdadb005543d67fa82930c50d31149fc8f60ddc3df72833c
run the swap test: ts-node .\scripts\testnet\test_swap_clean.ts

The current issue: swapping from sui to telebtc router.
If use split in seperate tx, odd case when user only has one coin, and a empty coin, split won't work
If use in the same tx, still won't work for using the same tx input

current issue: 
1. re test the burn test
2. re format the reverse section, need retest
3. test_bitcoin,  create tx with no opreturn value, then test burn proof 
```
