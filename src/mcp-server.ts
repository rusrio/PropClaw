import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

// ─── Config ─────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";

// ─── x402 Payment Client ───────────────────────────────────────────────────

let paidFetch: typeof fetch = fetch;

const paymentKey = process.env.AGENT_PAYMENT_KEY as `0x${string}` | undefined;
if (paymentKey) {
  const account = privateKeyToAccount(paymentKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  paidFetch = wrapFetchWithPayment(fetch, client);
  console.error("[MCP] x402 payments enabled with wallet:", account.address);
} else {
  console.error("[MCP] Warning: AGENT_PAYMENT_KEY not set, x402 payments disabled");
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "openclaw-prop-firm",
  version: "2.0.0",
});

// ─── Tool: evaluate_agent ───────────────────────────────────────────────────

server.tool(
  "evaluate_agent",
  "Evaluate a trader for prop firm access. Requires the trader's Hyperliquid address and a signature proving ownership. Costs $10 USDC via x402.",
  {
    hyperliquid_address: z.string().describe("Trader's Hyperliquid (Ethereum) address"),
    signature: z.string().describe("Signature of the message 'OpenClaw Prop Firm: authorize <address>'"),
  },
  async ({ hyperliquid_address, signature }) => {
    try {
      const res = await paidFetch(`${BASE_URL}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hyperliquid_address, signature }),
      });

      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: execute_trade ────────────────────────────────────────────────────

server.tool(
  "execute_trade",
  "Execute a trade on Hyperliquid via an approved agent's funded wallet. Costs $0.01 USDC via x402.",
  {
    agent_id: z.string().describe("UUID of the approved agent"),
    coin: z.string().describe("Trading pair symbol (e.g., 'ETH', 'BTC')"),
    is_buy: z.boolean().describe("true = buy, false = sell"),
    sz: z.number().describe("Order size"),
    limit_px: z.number().describe("Limit price in USD"),
    order_type: z.enum(["limit", "market"]).default("limit").describe("Order type"),
    reduce_only: z.boolean().default(false).describe("Only reduce existing position"),
    leverage: z.number().min(1).max(50).optional().describe("Desired Cross Margin leverage (1-50)"),
    tp_px: z.number().positive().optional().describe("Take profit trigger price"),
    sl_px: z.number().positive().optional().describe("Stop loss trigger price"),
  },
  async ({ agent_id, coin, is_buy, sz, limit_px, order_type, reduce_only, leverage, tp_px, sl_px }) => {
    try {
      const res = await paidFetch(`${BASE_URL}/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id, coin, is_buy, sz, limit_px, order_type, reduce_only, leverage, tp_px, sl_px }),
      });

      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: cancel_order ─────────────────────────────────────────────────────

server.tool(
  "cancel_order",
  "Cancel an open order (Limit, TP, or SL). Costs $0.01 via x402.",
  {
    agent_id: z.string().uuid().describe("Your assigned agent_id"),
    coin: z.string().describe("Coin symbol (e.g. BTC)"),
    oid: z.number().positive().describe("Order ID to cancel (get this from open_orders)"),
  },
  async ({ agent_id, coin, oid }) => {
    try {
      const res = await paidFetch(`${BASE_URL}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id, coin, oid }),
      });
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_open_orders ──────────────────────────────────────────────────

server.tool(
  "get_open_orders",
  "List all of your open resting orders (Limits, Take Profits, Stop Losses). Free.",
  {
    agent_id: z.string().uuid().describe("Your assigned agent_id"),
  },
  async ({ agent_id }) => {
    try {
      const res = await fetch(`${BASE_URL}/open_orders/${agent_id}`);
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_open_positions ───────────────────────────────────────────────

server.tool(
  "get_open_positions",
  "List all of your currently open perpetual positions with PnL and Liquidation prices. Free.",
  {
    agent_id: z.string().uuid().describe("Your assigned agent_id"),
  },
  async ({ agent_id }) => {
    try {
      const res = await fetch(`${BASE_URL}/positions/${agent_id}`);
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_market_price ─────────────────────────────────────────────────

server.tool(
  "get_market_price",
  "Get the current Mark Price and Oracle Price for a coin to accurately place limit orders or TP/SL triggers. Free.",
  {
    coin: z.string().describe("Coin symbol (e.g. BTC, ETH)"),
  },
  async ({ coin }) => {
    try {
      const res = await fetch(`${BASE_URL}/market/${coin}`);
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_funding_rates ────────────────────────────────────────────────

server.tool(
  "get_funding_rates",
  "Get the current and predicted funding rates for a specific coin. Useful to decide between Long/Short. Free.",
  {
    coin: z.string().describe("Coin symbol (e.g. BTC, ETH)"),
  },
  async ({ coin }) => {
    try {
      const res = await fetch(`${BASE_URL}/funding/${coin}`);
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_stats ────────────────────────────────────────────────────────

server.tool(
  "get_stats",
  "Get an agent's current stats, PnL, profit split, and Hyperliquid balance. Free (no x402).",
  {
    agent_id: z.string().describe("UUID of the agent"),
  },
  async ({ agent_id }) => {
    try {
      const res = await fetch(`${BASE_URL}/stats/${agent_id}`);
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: list_agents ──────────────────────────────────────────────────────

server.tool(
  "list_agents",
  "List all trading agents, optionally filtered by status. Free (no x402).",
  {
    status: z.enum(["active", "revoked", "all"]).default("all").describe("Filter by agent status"),
  },
  async ({ status }) => {
    try {
      const res = await fetch(`${BASE_URL}/agents?status=${status}`);
      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Start ──────────────────────────────────────────────────────────────────

const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);
console.error("[MCP] OpenClaw Prop Firm MCP server started (stdio)");
