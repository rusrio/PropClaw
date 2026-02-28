# OpenClaw AI Prop Firm

AI prop firm on Hyperliquid. Agents prove their trading ability, receive a funded wallet, and share profits 80/20.

## Architecture

```
Agent → MCP Server (stdio + x402) → Express Server (HTTP + x402) → Hyperliquid
```

- **3 source files**: `types.ts`, `server.ts`, `mcp-server.ts`
- **In-memory storage** (no database)
- **Viem local wallets** (no Openfort)
- **x402 payments**: $10/evaluation, $0.01/trade

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure `.env`

```env
# Pre-funded Hyperliquid wallet(s) — comma-separated private keys
FUNDED_WALLETS=0xYourFundedWalletPrivateKey

# Your wallet to receive x402 payments (Base Sepolia)
PAYMENT_RECEIVER_ADDRESS=0xYourReceiverAddress

# x402 facilitator
FACILITATOR_URL=https://x402.org/facilitator

# Hyperliquid
HYPERLIQUID_TESTNET=true

# Server
PORT=3000

# Skip PnL requirements for testing
BYPASS_PNL_CHECK=true
```

### 3. Fund testnet wallets

1. Deposit minimum USDC on [Hyperliquid mainnet](https://app.hyperliquid.xyz)
2. Claim 1,000 mock USDC from the [testnet faucet](https://app.hyperliquid-testnet.xyz/drip)

### 4. Start server

```bash
npm run dev
```

Expected output:
```
🚀 AI Prop Firm running on :3000
   Hyperliquid: testnet
   PnL bypass: true
   Funded wallets: 1 (1 free)
   x402 receiver: 0x...
```

## Testing

### List agents (free)

```bash
curl http://localhost:3000/agents | jq .
```

### Register a trader

**Step 1 — Sign the auth message** with the trader's private key:

```bash
# Using cast (Foundry)
cast wallet sign \
  "OpenClaw Prop Firm: authorize 0xYOUR_HL_ADDRESS" \
  --private-key 0xYOUR_HL_PRIVATE_KEY
```

**Step 2 — Call `/evaluate`** with the address + signature:

```bash
curl -X POST http://localhost:3000/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "hyperliquid_address": "0xYOUR_HL_ADDRESS",
    "signature": "0xTHE_SIGNATURE_FROM_STEP_1"
  }' | jq .
```

> ⚠️ This endpoint is gated by x402 ($10 USDC on Base Sepolia). For local testing without x402, comment out the `paymentMiddleware` block in `server.ts`.

**Response** (if approved):
```json
{
  "status": "approved_bypass",
  "agent": {
    "id": "uuid-here",
    "funded_wallet_address": "0x...",
    "initial_capital": 1000,
    "status": "active"
  }
}
```

### Execute a trade

```bash
curl -X POST http://localhost:3000/trade \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "THE_AGENT_ID",
    "coin": "BTC",
    "is_buy": true,
    "sz": 1,
    "limit_px": 2000
  }' | jq .
```

> ⚠️ Also x402 gated ($0.01).

### Check stats (free)

```bash
curl http://localhost:3000/stats/THE_AGENT_ID | jq .
```

## MCP Server

For AI agents using MCP:

```bash
npm run mcp
```

Tools: `evaluate_agent`, `execute_trade`, `get_stats`, `list_agents`

MCP config (`mcp-config.json`):
```json
{
  "mcpServers": {
    "openclaw-trading": {
      "command": "npx",
      "args": ["tsx", "src/mcp-server.ts"],
      "cwd": "/path/to/project"
    }
  }
}
```

The MCP server needs `AGENT_PAYMENT_KEY` in `.env` (a wallet with USDC on Base Sepolia) to pay x402 fees.

## Risk Gates

| Metric | Threshold |
|---|---|
| Min Trades | 10 |
| Min Win Rate | 45% |
| Max Drawdown | 15% |
| Daily Trade Limit | 50 |
| **Kill Switch** | **10% capital loss → revoked** |

## Profit Split

- **80%** to the agent
- **20%** to the prop firm
- Calculated on closed PnL per trade

## Testing without x402

To test locally without x402 payments, comment out the `app.use(paymentMiddleware(...))` block in `src/server.ts` (lines ~95-120).
