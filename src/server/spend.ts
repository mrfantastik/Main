import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpendLedger } from "../sim/ai/director";

/**
 * Lifetime Claude spend, kept on disk so the budget cap survives restarts
 * and world resets (protects your real-money balance).
 */
export class FileSpendLedger implements SpendLedger {
  private usd = 0;
  constructor(private file: string) {
    try {
      if (existsSync(file)) this.usd = Number(JSON.parse(readFileSync(file, "utf8")).totalUsd) || 0;
    } catch {
      this.usd = 0;
    }
  }
  total(): number {
    return this.usd;
  }
  add(usd: number): void {
    this.usd += usd;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ totalUsd: this.usd, updated: new Date().toISOString() }, null, 2));
    } catch {
      /* disk issues shouldn't stop the sim */
    }
  }
}
