import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default location of the local comps database. Git-ignored; created by `npm run ingest`.
export const DATA_DIR = path.resolve(__dirname, '..', 'data');
export const DB_PATH = process.env.COLLECTOR_DB || path.join(DATA_DIR, 'comps.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_slug   TEXT NOT NULL,
  artist_name   TEXT,
  internal_id   TEXT NOT NULL,
  title         TEXT,
  title_norm    TEXT,
  date_text     TEXT,
  sale_date     TEXT,
  medium_text   TEXT,
  medium_class  TEXT,
  dimension_text TEXT,
  area_cm2      REAL,
  creation_year INTEGER,
  organization  TEXT,
  price_cents   INTEGER NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE (artist_slug, internal_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_artist       ON sales (artist_slug);
CREATE INDEX IF NOT EXISTS idx_sales_artist_title ON sales (artist_slug, title_norm);
`;

export function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

const INSERT_SQL = `
INSERT OR IGNORE INTO sales (
  artist_slug, artist_name, internal_id, title, title_norm, date_text, sale_date,
  medium_text, medium_class, dimension_text, area_cm2, creation_year, organization, price_cents
) VALUES (
  @artist_slug, @artist_name, @internal_id, @title, @title_norm, @date_text, @sale_date,
  @medium_text, @medium_class, @dimension_text, @area_cm2, @creation_year, @organization, @price_cents
)`;

export function insertSales(db, rows) {
  const stmt = db.prepare(INSERT_SQL);
  const tx = db.transaction((items) => {
    let changed = 0;
    for (const row of items) {
      changed += stmt.run(row).changes;
    }
    return changed;
  });
  return tx(rows);
}

export function allSales(db) {
  return db.prepare('SELECT * FROM sales').all();
}

export function salesCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
}
