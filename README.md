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

## Getting Started

1. Clone the repository:
```bash
git clone https://github.com/yourusername/teleswapSui.git
cd teleswapSui
```

2. Build the project:
```bash
sui move build
```

3. Run the tests:
```bash
sui move test
```