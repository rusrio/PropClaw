import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as hl from "@nktkas/hyperliquid";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  EvaluateInputSchema,
  TradeInputSchema,
  CancelInputSchema,
  RISK_GATES,
  type Agent,
} from "./types.js";
import {
  db,
  getAgent,
  getAgentByHyperliquidAddress,
  getAllAgents,
  saveAgent,
  getAvailableWallet,
  getWalletForAgent,
  saveWallet,
  assignWallet,
  getFundedWalletsCount
} from "./db.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const RECEIVER = process.env.PAYMENT_RECEIVER_ADDRESS!;
const PORT = parseInt(process.env.PORT || "3000", 10);
const isTestnet = process.env.HYPERLIQUID_TESTNET === "true";
const bypassPnl = process.env.BYPASS_PNL_CHECK === "true";

// ─── Database Initialization ────────────────────────────────────────────────

// Load funded wallets from env into DB if they don't exist
const rawKeys = (process.env.FUNDED_WALLETS || "").split(",").filter(Boolean);
for (const key of rawKeys) {
  const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  saveWallet({ privateKey: pk, address: account.address, assigned_to: null });
}

// ─── Hyperliquid ────────────────────────────────────────────────────────────

const transport = new hl.HttpTransport({ isTestnet });
const infoClient = new hl.InfoClient({ transport });

const AUTH_MESSAGE_PREFIX = "OpenClaw Prop Firm: authorize ";

async function analyzePnL(address: string) {
  const fills = await infoClient.userFills({ user: address as `0x${string}` });

  if (fills.length < RISK_GATES.MIN_TRADES) {
    return { total_pnl: 0, win_rate: 0, max_drawdown: 0, total_trades: fills.length, passes: false,
      reasons: [`Insufficient trades: ${fills.length} < ${RISK_GATES.MIN_TRADES}`] };
  }

  let totalPnl = 0, wins = 0, peak = 0, maxDrawdown = 0, runningPnl = 0;
  for (const fill of fills) {
    const pnl = parseFloat(fill.closedPnl);
    runningPnl += pnl;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak > 0 ? (peak - runningPnl) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const winRate = wins / fills.length;
  const reasons: string[] = [];
  if (winRate < RISK_GATES.MIN_WINRATE) reasons.push(`Win rate: ${(winRate * 100).toFixed(1)}% < ${RISK_GATES.MIN_WINRATE * 100}%`);
  if (totalPnl < RISK_GATES.MIN_TOTAL_PNL) reasons.push(`PnL: $${totalPnl.toFixed(2)} < $${RISK_GATES.MIN_TOTAL_PNL}`);
  if (maxDrawdown > RISK_GATES.MAX_DRAWDOWN) reasons.push(`Drawdown: ${(maxDrawdown * 100).toFixed(1)}% > ${RISK_GATES.MAX_DRAWDOWN * 100}%`);

  return { total_pnl: Math.round(totalPnl * 100) / 100, win_rate: Math.round(winRate * 1000) / 1000,
    max_drawdown: Math.round(maxDrawdown * 1000) / 1000, total_trades: fills.length,
    passes: reasons.length === 0, reasons };
}

async function getBalance(address: string) {
  let perpsValue = 0;
  let spotValue = 0;
  let totalMarginUsed = 0;
  let withdrawable = 0;

  try {
    const state = await infoClient.clearinghouseState({ user: address as `0x${string}` });
    perpsValue = parseFloat(state.marginSummary.accountValue);
    totalMarginUsed = parseFloat(state.marginSummary.totalMarginUsed);
    withdrawable = parseFloat(state.withdrawable);
  } catch (e) {}

  try {
    const spot = await infoClient.spotClearinghouseState({ user: address as `0x${string}` });
    const spotUsdc = spot.balances.find((b) => b.coin === "USDC");
    if (spotUsdc) {
      spotValue = parseFloat(spotUsdc.total);
    }
  } catch (e) {}

  return {
    accountValue: perpsValue + spotValue,
    totalMarginUsed,
    withdrawable,
  };
}

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── x402 Payment Middleware (uncomment for production) ─────────────────────

// const facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL || "https://x402.org/facilitator" });
// const resourceServer = new x402ResourceServer(facilitatorClient)
//   .register("eip155:84532", new ExactEvmScheme());

// app.use(
//   paymentMiddleware(
//     {
//       "POST /evaluate": {
//         accepts: [{
//           scheme: "exact",
//           price: "$10",
//           network: "eip155:84532",
//           payTo: RECEIVER,
//         }],
//         description: "Evaluate trader for prop firm access",
//       },
//       "POST /cancel": {
//         accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: RECEIVER }],
//         description: "Cancel an open order",
//       },
//       "POST /trade": {
//         accepts: [{
//           scheme: "exact",
//           price: "$0.01",
//           network: "eip155:84532",
//           payTo: RECEIVER,
//         }],
//         description: "Execute a trade on Hyperliquid",
//       },
//     },
//     resourceServer,
//   ),
// );

// ─── POST /evaluate ─────────────────────────────────────────────────────────

app.post("/evaluate", async (req, res) => {
  try {
    const input = EvaluateInputSchema.parse(req.body);
    const addr = input.hyperliquid_address;

    // 1. Check if already registered
    const existingAgent = getAgentByHyperliquidAddress(addr);
    if (existingAgent) {
      res.json({ status: "already_registered", agent: existingAgent });
      return;
    }

    // 2. Verify wallet ownership (sign "OpenClaw Prop Firm: authorize 0x...")
    const expectedMessage = AUTH_MESSAGE_PREFIX + addr;
    const isValid = await verifyMessage({
      address: addr as `0x${string}`,
      message: expectedMessage,
      signature: input.signature as `0x${string}`,
    });

    if (!isValid) {
      res.status(401).json({ error: "Invalid signature. Sign the message: " + expectedMessage });
      return;
    }

    // 3. Analyze PnL
    const metrics = await analyzePnL(addr);

    if (!metrics.passes && !bypassPnl) {
      res.status(403).json({ status: "rejected", metrics });
      return;
    }

    // 4. Assign funded wallet
    const wallet = getAvailableWallet();
    if (!wallet) {
      res.status(503).json({ error: "No funded wallets available. Try again later." });
      return;
    }

    // 5. Get initial capital
    let initialCapital = 0;
    try {
      const bal = await getBalance(wallet.address);
      initialCapital = bal.accountValue;
    } catch { /* wallet may not have HL deposits yet */ }

    // 6. Create agent
    const agent: Agent = {
      id: randomUUID(),
      hl_address: addr,
      funded_wallet_address: wallet.address,
      initial_capital: initialCapital,
      current_pnl: 0,
      agent_profit: 0,
      firm_profit: 0,
      status: "active",
      trade_count: 0,
      created_at: new Date().toISOString(),
    };

    assignWallet(wallet.address, agent.id);
    saveAgent(agent);

    res.json({
      status: metrics.passes ? "approved" : "approved_bypass",
      agent,
      metrics,
      auth_message: expectedMessage,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Invalid input", details: err });
      return;
    }
    console.error("Evaluate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /trade ────────────────────────────────────────────────────────────

app.post("/trade", async (req, res) => {
  try {
    const input = TradeInputSchema.parse(req.body);
    const agent = getAgent(input.agent_id);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (agent.status === "revoked") {
      res.status(403).json({ error: "Agent access has been revoked due to drawdown" });
      return;
    }

    if (agent.trade_count >= RISK_GATES.MAX_DAILY_TRADES) {
      res.status(429).json({ error: "Daily trade limit reached" });
      return;
    }

    // Drawdown check
    const wallet = getWalletForAgent(agent.id);
    if (!wallet) {
      res.status(500).json({ error: "No wallet assigned" });
      return;
    }

    try {
      const bal = await getBalance(wallet.address);

      const drawdown = agent.initial_capital > 0
        ? (agent.initial_capital - bal.accountValue) / agent.initial_capital
        : 0;

      if (drawdown >= RISK_GATES.DRAWDOWN_KILL) {
        agent.status = "revoked";
        saveAgent(agent);
        res.status(403).json({
          error: "Access revoked: drawdown exceeded 10%",
          drawdown: `${(drawdown * 100).toFixed(1)}%`,
        });
        return;
      }
    } catch { /* balance check may fail, proceed with trade */ }

    // Execute trade
    const account = privateKeyToAccount(wallet.privateKey);
    const exchangeClient = new hl.ExchangeClient({ wallet: account, transport });
    
    // Look up coin index
    const meta = await infoClient.meta();
    const coinIndex = meta.universe.findIndex(c => c.name === input.coin.toUpperCase());
    if (coinIndex === -1) {
      res.status(400).json({ status: "error", error: `Coin ${input.coin} not found` });
      return;
    }

    // 1. Update Leverage if requested
    if (input.leverage) {
      try {
        await exchangeClient.updateLeverage({
          asset: coinIndex,
          isCross: true,
          leverage: input.leverage,
        });
        console.log(`[Leverage] Set ${input.coin} to Cross ${input.leverage}x for ${wallet.address}`);
      } catch (e) {
        console.error("Failed to update leverage:", e);
        // Continue trade even if leverage update fails
      }
    }

    // 2. Build orders array
    const ordersToPlace: any[] = [{
      a: coinIndex,
      b: input.is_buy,
      p: String(input.limit_px),
      s: String(input.sz),
      r: input.reduce_only,
      t: input.order_type === "market"
        ? { limit: { tif: "Ioc" as const } }
        : { limit: { tif: "Gtc" as const } },
    }];

    // Add Take Profit if provided
    if (input.tp_px) {
      ordersToPlace.push({
        a: coinIndex,
        b: !input.is_buy, // Opposite side to close
        p: String(input.tp_px), // For market triggers, limitPx acts as slippage bound, but SDK format needs triggerPx in `t`
        s: String(input.sz),
        r: true,
        t: { trigger: { isMarket: true, triggerPx: String(input.tp_px), tpsl: "tp" as const } },
      });
    }

    // Add Stop Loss if provided
    if (input.sl_px) {
      ordersToPlace.push({
        a: coinIndex,
        b: !input.is_buy,
        p: String(input.sl_px),
        s: String(input.sz),
        r: true,
        t: { trigger: { isMarket: true, triggerPx: String(input.sl_px), tpsl: "sl" as const } },
      });
    }

    const result = await exchangeClient.order({
      orders: ordersToPlace as any,
      grouping: (input.tp_px || input.sl_px) ? "normalTpsl" : "na",
    });

    agent.trade_count++;

    // Check for closed PnL and calculate profit split
    let profitSplit = null;
    try {
      const fills = await infoClient.userFills({ user: wallet.address as `0x${string}` });
      const latestFill = fills[fills.length - 1];
      if (latestFill) {
        const closedPnl = parseFloat(latestFill.closedPnl);
        if (closedPnl > 0) {
          const agentShare = closedPnl * RISK_GATES.AGENT_PROFIT_SHARE;
          const firmShare = closedPnl * RISK_GATES.FIRM_PROFIT_SHARE;
          agent.agent_profit += agentShare;
          agent.firm_profit += firmShare;
          agent.current_pnl += closedPnl;
          profitSplit = { closed_pnl: closedPnl, agent_share: agentShare, firm_share: firmShare };
        } else if (closedPnl < 0) {
          agent.current_pnl += closedPnl;
        }
      }
    } catch { /* fills check optional */ }

    saveAgent(agent); // Save updated agent state

    res.json({
      status: "executed",
      agent_id: agent.id,
      trade: { coin: input.coin, is_buy: input.is_buy, sz: input.sz, limit_px: input.limit_px },
      hl_response: result,
      profit_split: profitSplit,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Invalid input", details: err });
      return;
    }
    console.error("Trade error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /cancel ───────────────────────────────────────────────────────────

app.post("/cancel", async (req, res) => {
  try {
    const input = CancelInputSchema.parse(req.body);
    const agent = getAgent(input.agent_id);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (agent.status === "revoked") {
      res.status(403).json({ error: "Agent access has been revoked" });
      return;
    }

    const wallet = getWalletForAgent(agent.id);
    if (!wallet) {
      res.status(500).json({ error: "No wallet assigned" });
      return;
    }

    const meta = await infoClient.meta();
    const coinIndex = meta.universe.findIndex(c => c.name === input.coin.toUpperCase());
    if (coinIndex === -1) {
      res.status(400).json({ error: `Coin ${input.coin} not found` });
      return;
    }

    const account = privateKeyToAccount(wallet.privateKey);
    const exchangeClient = new hl.ExchangeClient({ wallet: account, transport });

    const result = await exchangeClient.cancel({
      cancels: [{
        a: coinIndex,
        o: input.oid
      }],
    });

    res.json({ status: "executed", agent_id: agent.id, hl_response: result });
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Invalid input", details: err });
      return;
    }
    console.error("Cancel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /open_orders/:agent_id ─────────────────────────────────────────────

app.get("/open_orders/:agent_id", async (req, res) => {
  try {
    const agent = getAgent(req.params.agent_id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const wallet = getWalletForAgent(agent.id);
    if (!wallet) {
      res.status(500).json({ error: "No wallet assigned" });
      return;
    }

    const openOrders = await infoClient.openOrders({ user: wallet.address as `0x${string}` });
    res.json({ open_orders: openOrders });
  } catch (err) {
    console.error("Open orders error:", err);
    res.status(500).json({ error: "Failed to fetch open orders" });
  }
});

// ─── GET /positions/:agent_id ───────────────────────────────────────────────

app.get("/positions/:agent_id", async (req, res) => {
  try {
    const agent = getAgent(req.params.agent_id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const wallet = getWalletForAgent(agent.id);
    if (!wallet) {
      res.status(500).json({ error: "No wallet assigned" });
      return;
    }

    const state = await infoClient.clearinghouseState({ user: wallet.address as `0x${string}` });
    const positions = state.assetPositions.map(p => p.position);
    res.json({ positions, marginSummary: state.marginSummary });
  } catch (err) {
    console.error("Positions error:", err);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

// ─── GET /market/:coin ──────────────────────────────────────────────────────

app.get("/market/:coin", async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const ctxs = await infoClient.metaAndAssetCtxs();
    
    // metaAndAssetCtxs returns an array where [0] is meta and [1] is asset contexts
    const meta = ctxs[0] as unknown as { universe: Array<{ name: string }> };
    const assetCtxs = ctxs[1] as any[];

    const coinIndex = meta.universe.findIndex(c => c.name === coin);
    if (coinIndex === -1) {
      res.status(404).json({ error: "Coin not found" });
      return;
    }

    res.json({ market_data: assetCtxs[coinIndex] });
  } catch (err) {
    console.error("Market data error:", err);
    res.status(500).json({ error: "Failed to fetch market data" });
  }
});

// ─── GET /funding/:coin ─────────────────────────────────────────────────────

app.get("/funding/:coin", async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    
    // Fetch all predicted fundings
    const predicted = await infoClient.predictedFundings();
    
    // Find the funding data for the requested coin
    // Note: The structure is typically an array or [string, PredictedFundingRecord][]
    // We'll return the whole array but filtered 
    const fundingData = (predicted as any[]).find(f => (f.coin || f[0]) === coin);
    
    if (!fundingData) {
       res.status(404).json({ error: "Funding data not found for coin" });
       return;
    }
    
    res.json({ funding_rates: fundingData });
  } catch (err) {
    console.error("Funding data error:", err);
    res.status(500).json({ error: "Failed to fetch funding data" });
  }
});

// ─── GET /stats/:agent_id ───────────────────────────────────────────────────

app.get("/stats/:agent_id", async (req, res) => {
  try {
    const agent = getAgent(req.params.agent_id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    let balance = null;
    try {
      balance = await getBalance(agent.funded_wallet_address);
    } catch { /* may not be funded yet */ }

    res.json({ agent, balance, risk_gates: RISK_GATES });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /agents ────────────────────────────────────────────────────────────

app.get("/agents", (_req, res) => {
  const status = (_req.query.status as string) || "all";
  const list = getAllAgents(status);
  res.json({ agents: list, count: list.length });
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const counts = getFundedWalletsCount();
  console.log(`🚀 AI Prop Firm running on :${PORT}`);
  console.log(`   Hyperliquid: ${isTestnet ? "testnet" : "mainnet"}`);
  console.log(`   PnL bypass: ${bypassPnl}`);
  console.log(`   Funded wallets: ${counts.total} (${counts.free} free)`);
  console.log(`   x402 receiver: ${RECEIVER}`);
});
