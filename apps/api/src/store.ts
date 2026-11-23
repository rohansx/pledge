import type pg from "pg";

import { summarize, type Scan, type ScanSummary, type StoredScan } from "./schema.ts";

/** Where scans are kept. The API depends on this, not on Postgres, so tests can use memory. */
export interface ScanStore {
  list(): Promise<ScanSummary[]>;
  get(id: string): Promise<StoredScan | null>;
  create(scan: Scan): Promise<ScanSummary>;
}

const LIST_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ponytail: one idempotent statement run at startup instead of a migration tool. It holds while changes are
// additive; the first change that alters or drops a column needs real, ordered migrations run before deploy.
const SCHEMA = `
  create table if not exists scan (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    summary jsonb not null,
    body jsonb not null
  );
  create index if not exists scan_created_at on scan (created_at desc);
`;

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA);
}

interface Row {
  id: string;
  created_at: Date;
  summary: Omit<ScanSummary, "id" | "created_at">;
  body?: Scan;
}

function toSummary(row: Row): ScanSummary {
  return { id: row.id, created_at: row.created_at.toISOString(), ...row.summary };
}

export class PgScanStore implements ScanStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async list(): Promise<ScanSummary[]> {
    const { rows } = await this.#pool.query<Row>("select id, created_at, summary from scan order by created_at desc limit $1", [LIST_LIMIT]);
    return rows.map(toSummary);
  }

  async get(id: string): Promise<StoredScan | null> {
    if (!UUID.test(id)) return null; // Postgres would raise on a malformed uuid; an unknown id is simply not found
    const { rows } = await this.#pool.query<Row>("select id, created_at, summary, body from scan where id = $1", [id]);
    const row = rows[0];
    return row?.body ? { ...toSummary(row), scan: row.body } : null;
  }

  async create(scan: Scan): Promise<ScanSummary> {
    const { rows } = await this.#pool.query<Row>(
      "insert into scan (summary, body) values ($1, $2) returning id, created_at, summary",
      [JSON.stringify(summarize(scan)), JSON.stringify(scan)],
    );
    return toSummary(rows[0]!);
  }
}

export class MemoryScanStore implements ScanStore {
  readonly #scans: StoredScan[] = [];

  async list(): Promise<ScanSummary[]> {
    return this.#scans.map(({ scan: _scan, ...summary }) => summary).reverse();
  }

  async get(id: string): Promise<StoredScan | null> {
    return this.#scans.find((stored) => stored.id === id) ?? null;
  }

  async create(scan: Scan): Promise<ScanSummary> {
    const summary: ScanSummary = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...summarize(scan) };
    this.#scans.push({ ...summary, scan });
    return summary;
  }
}
