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
npm test -- tests/btcrelay.test.ts
npm test -- tests/telebtc.test.ts
npm test -- tests/transfer.test.ts
```

8. Deploy the contract:
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
3. The bridge/locker/burner/exchange contracts will depend on each other by "use module"
4. Development order: 

  (2) bridge contract testing
  (3) burner rounter contract, also add dummy locker manager contract for testing
  (4) burner testing
  (5) locker contract
  (6) locker contract testing
  (7) bridge contract/burner contract retesting with real locker contract
  (8) exchange contract
  (9) exchange contract testing

-- Need to update deploy script due to directory messed up
locker fee needs adjust

Deployer order:
1. btcrelay_mock,telebtc,bitcoin_helper,dummy_locker,request_parser,cc_transfer_router_storage,cc_transfer_router
2. initialize btcrelay
3. give locker contract mine ability
4. initialize transfer_router 


Locker contract gives locker role. The locker contract creates lockerCap objects (shared).
LockerCap object containes collator amount/ mint cap/ burn cap/ active status/ locker address etc. 
Locker contract can change active/collateral status of the locker cap object
All the collaternal stays in a vault object in locker contract
Only locker can call add/withdraw funds in vault 

Telebtc contract, remove mint/burner role system, instead mint/burn only open to friend package (cc_transfer/burner router/locker)
Teleporter choose the right locker and take the corresponding lockerCap object (all shared, reachable to everyone)
ccTransfer contract takes lockerCap object, pass in locker mint, locker mint check status, if good, call mint
