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
git clone https://github.com/yourusername/teleswapSui.git
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

8. Deploy the contract (under maintain):
```bash
# Deploy the contract to mainnet/testnet/local 
npx ts-node scripts/deploy/01-deploy_btc_relay.ts [network]

# Modified the starting period/height in file 02-initialize_btc_relay.ts
# Initialze the contract on mainnet/testnet/local 
npx ts-node scripts/deploy/02-initialize_btc_relay.ts [network]
```

## License
MIT


## Some note about general design (diff from evm contract)
1. Contracts will be upgraded using the upgrade Cap. The upgrade Cap will be assigned to deployer when deploying the contract
2. Package id won't change when upgrading the contract (In Move, the address must be known at compile time for use statements. You cannot dynamically import a module at runtime.)
3. The bridge/locker/burner/exchange/telebtc contracts will depend on each other by "use module"


Other TODOs:
-- Need to update deploy script due to directory messed up (will do after all the contracts done)
-- safe math rescan all files
-- reentrancy issue rescan
-- Reward distribute system in ccexchange and cc transfer(made it in locker, send fee to lockers)

-- Three version of the projects
    -- localnet mock version: only available to local test
    -- test version: besides from wbtc and btcrelay, all other files remain the same as mainnet
    -- mainnet version: ready to ship version

TODO:
6. deployer script
7. testnet deployment test
7.1 testnet exchange/dex connector test
7.2 swap and unwrap test
7.3 all intergration test
8. gas improvement


