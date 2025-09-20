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
.\scripts\test\run-tests.ps1

# Batch file (Windows):
.\scripts\test\run-tests.bat

# Node.js (Cross-platform):
node scripts/test/run-tests.js

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
# Deploy the contract to mainnet/testnet/devnet
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
```

## License
MIT


## Some note about general design (diff from evm contract)
1. Contracts will be upgraded using the upgrade Cap. The upgrade Cap will be assigned to deployer when deploying the contract
2. Package id won't change when upgrading the contract (In Move, the address must be known at compile time for use statements. You cannot dynamically import a module at runtime.)
3. The bridge/locker/burner/exchange/telebtc contracts will depend on each other by "use module"


## Other TODOs
```
-- Three version of the projects
-- localnet mock version: only available to local test
-- test version: besides from wbtc/usdc/usdc and btcrelay, all other files remain the same as mainnet
-- mainnet version: ready to ship version
```
## TODO:
```
1.sdk script to create cetus pool on testnet

2.btcrelay mock on testnet

3. useful script on testnet
  - unwrap,swap_and_unwrap,burn_proof function in burn_router_logic
  - wrap_and_swap,refund_by_admin in cc_exchange_logic
  - wrap in cc_transfer_router_logic
  - addHeadersWithRetarget,addHeaders in btcrelay

4. prepare step for testing
  - request_to_become_locker by someone
  - add_locker by deployer
  - generate a fake tx (btcrelay is a mock)
  - wrap, this will give us some telebtc
  - form pools, usdc-sui, usdc-usdt,usdc-btc,telebtc-btc (four pools)

5. start testing
  - generate script for exchange 
  - wrap_and_swap function
  - swap_and_unwrap function

6. all intergration test
7. security
  - safe math rescan all files
  - reentrancy issue rescan
  - Reward distribute system in ccexchange and cc transfer(made it in locker, send fee to lockers)
8. gas improvement

```


