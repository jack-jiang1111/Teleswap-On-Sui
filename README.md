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
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
cd teleswap-mainnet
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

# Check all the enviornment
sui client envs 
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

8. Deploy the contract to testnet:
before deploy the contract, need to fetch some test coin on faceut
```bash
# Build the testnet project
cd teleswap-testnet
sui move build

cd ..

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




## Project Structure

The project consists of three main versions:

- **Localnet Mock Version**: Available only for local testing
- **Testnet Version**: Uses mock WBTC/USDC/USDT and BTC relay, all other files remain the same as mainnet
- **Mainnet Version**: Production-ready version

### Directory Structure

```
├── btcrelaypackage/          # Contains the BTC relay package
├── mock/                     # Localnet version of teleswap and mock coins
├── scripts/
│   ├── deploy/              # Deployment scripts
│   ├── sdk/                 # SDK functions and update-relay.ts script
│   └── testnet/             # Testnet-specific scripts
├── tests/                   # Test scripts
├── teleswap-mainnet/        # Code used on mainnet
└── teleswap-testnet/        # Code used on testnet
```
## Additional Commands
### Package Upgrade
```bash
sui client upgrade --gas-budget 750000000 --upgrade-capability "the upgrade object cap id"
```
### Local network restart (delete cache)
```bash
Remove-Item -Recurse -Force "$env:USERPROFILE\.sui\sui_config"
$env:RUST_LOG="off,sui_node=info"; sui start --with-faucet
```


## Known Issues

### Current Issue: SUI to TeleBTC Router Swapping

**Problem**: Swapping from SUI to TeleBTC router has limitations:

1. **Separate Transaction Approach**: 
   - Issue: When user has only one coin and an empty coin, split operation won't work
   
2. **Same Transaction Approach**: 
   - Issue: Still doesn't work when using the same transaction input

**Status**: This issue is currently being investigated and resolved.


## License
MIT