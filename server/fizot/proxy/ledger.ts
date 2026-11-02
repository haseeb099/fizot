export type LedgerEntry = {
  instanceId: string;
  requestId: string;
  tokens: number;
  at: number;
};

export class Ledger {
  private readonly rows: LedgerEntry[] = [];
  private readonly seen = new Set<string>();

  /** Append once per (instanceId, requestId). Repeats return the first entry. */
  record(entry: Omit<LedgerEntry, "at"> & { at?: number }): { entry: LedgerEntry; created: boolean } {
    const key = `${entry.instanceId}\0${entry.requestId}`;
    const existing = this.rows.find((row) => row.instanceId === entry.instanceId && row.requestId === entry.requestId);
    if (existing || this.seen.has(key)) {
      return { entry: existing!, created: false };
    }
    const saved: LedgerEntry = { ...entry, at: entry.at ?? Date.now() };
    this.seen.add(key);
    this.rows.push(saved);
    return { entry: saved, created: true };
  }

  usage(instanceId: string): number {
    return this.rows.filter((row) => row.instanceId === instanceId).reduce((sum, row) => sum + row.tokens, 0);
  }

  entries(): readonly LedgerEntry[] {
    return this.rows;
  }
}
