import { z } from "zod";

// ─── Risk Gate Constants ────────────────────────────────────────────────────

export const RISK_GATES = {
  MIN_TRADES: 10,
  MIN_WINRATE: 0.45,
  MIN_TOTAL_PNL: -500,
  MAX_DRAWDOWN: 0.15,
  MAX_DAILY_TRADES: 50,
  DRAWDOWN_KILL: 0.10,       // 10% of assigned capital → revoke
  AGENT_PROFIT_SHARE: 0.80,  // 80% to agent
  FIRM_PROFIT_SHARE: 0.20,   // 20% to firm
};

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const EvaluateInputSchema = z.object({
  hyperliquid_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
});

export const TradeInputSchema = z.object({
  agent_id: z.string().uuid(),
  coin: z.string().min(1),
  is_buy: z.boolean(),
  sz: z.number().positive(),
  limit_px: z.number().positive(),
  order_type: z.enum(["limit", "market"]).default("limit"),
  reduce_only: z.boolean().default(false),
  leverage: z.number().min(1).max(50).optional(),
  tp_px: z.number().positive().optional(),
  sl_px: z.number().positive().optional(),
});

export const CancelInputSchema = z.object({
  agent_id: z.string().uuid(),
  coin: z.string().min(1),
  oid: z.number().positive(),
});

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  hl_address: string;
  funded_wallet_address: string;
  initial_capital: number;
  current_pnl: number;
  agent_profit: number;
  firm_profit: number;
  status: "active" | "revoked";
  trade_count: number;
  created_at: string;
}

export interface FundedWallet {
  apiId: string; // Openfort backend account ID (e.g. acc_...)
  address: string;
  assigned_to: string | null; // agent_id or null if free
}
