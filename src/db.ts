import Database from "better-sqlite3";
import { type Agent, type FundedWallet } from "./types.js";
import fs from "fs";

// Create directory if it doesn't exist
const dbDir = "./data";
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: Database.Database = new Database(`${dbDir}/propfirm.sqlite`);

// Enable WAL mode for better concurrency performance
db.pragma("journal_mode = WAL");

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    hyperliquid_address TEXT NOT NULL UNIQUE,
    funded_wallet_address TEXT NOT NULL,
    current_pnl REAL DEFAULT 0,
    firm_profit REAL DEFAULT 0,
    agent_profit REAL DEFAULT 0,
    trade_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active'
  );

  DROP TABLE IF EXISTS funded_wallets;

  CREATE TABLE IF NOT EXISTS funded_wallets (
    address TEXT PRIMARY KEY,
    api_id TEXT NOT NULL,
    assigned_to TEXT
  );
`);

// ─── Agent Methods ──────────────────────────────────────────────────────────

export function getAgent(id: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
  if (!row) return null;
  return row as Agent;
}

export function getAgentByHyperliquidAddress(address: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE hyperliquid_address = ?").get(address) as any;
  if (!row) return null;
  return row as Agent;
}

export function getAllAgents(statusFilter: string = "all"): Agent[] {
  if (statusFilter === "all") {
    return db.prepare("SELECT * FROM agents").all() as Agent[];
  }
  return db.prepare("SELECT * FROM agents WHERE status = ?").all(statusFilter) as Agent[];
}

export function saveAgent(agent: Agent) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents (
      id, hyperliquid_address, funded_wallet_address,
      current_pnl, firm_profit, agent_profit, trade_count, status
    ) VALUES (
      @id, @hl_address, @funded_wallet_address,
      @current_pnl, @firm_profit, @agent_profit, @trade_count, @status
    )
  `);
  stmt.run(agent);
}

// ─── Wallet Methods ─────────────────────────────────────────────────────────

export function getAvailableWallet(): FundedWallet | null {
  const row = db.prepare("SELECT * FROM funded_wallets WHERE assigned_to IS NULL LIMIT 1").get() as any;
  if (!row) return null;
  return row as FundedWallet;
}

export function getWalletForAgent(agentId: string): FundedWallet | null {
  const row = db.prepare("SELECT * FROM funded_wallets WHERE assigned_to = ?").get(agentId) as any;
  if (!row) return null;
  return row as FundedWallet;
}

export function saveWallet(wallet: FundedWallet) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO funded_wallets (address, api_id, assigned_to)
    VALUES (@address, @apiId, @assigned_to)
  `);
  stmt.run(wallet);
}

export function assignWallet(walletAddress: string, agentId: string) {
  db.prepare("UPDATE funded_wallets SET assigned_to = ? WHERE address = ?").run(agentId, walletAddress);
}

export function getFundedWalletsCount(): { total: number, free: number } {
  const total = (db.prepare("SELECT COUNT(*) as count FROM funded_wallets").get() as any).count;
  const free = (db.prepare("SELECT COUNT(*) as count FROM funded_wallets WHERE assigned_to IS NULL").get() as any).count;
  return { total, free };
}
