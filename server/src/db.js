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

-- Progress for the full (all-artists) ingest. ingest_state holds the discovery cursor and
-- completion flag; ingest_artists is the durable work queue of artists that have auction
-- results, so a run can stop and resume without redoing finished artists.
CREATE TABLE IF NOT EXISTS ingest_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS ingest_artists (
  artist_slug     TEXT PRIMARY KEY,
  artist_name     TEXT,
  auction_results INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  discovered_at   TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_artists_status ON ingest_artists (status);
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

// ---------------------------------------------------------------------------
// Full-ingest progress
// ---------------------------------------------------------------------------

export function getIngestState(db, key) {
  const row = db.prepare('SELECT value FROM ingest_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setIngestState(db, key, value) {
  db.prepare(
    `INSERT INTO ingest_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value == null ? null : String(value));
}

// Add discovered artists to the queue. Existing rows keep their status, so a done artist is not
// re-queued when a discovery page is read again after a restart.
export function upsertIngestArtists(db, artists) {
  const stmt = db.prepare(
    `INSERT INTO ingest_artists (artist_slug, artist_name, auction_results)
     VALUES (@artist_slug, @artist_name, @auction_results)
     ON CONFLICT(artist_slug) DO UPDATE SET
       artist_name = excluded.artist_name,
       auction_results = excluded.auction_results,
       updated_at = datetime('now')`,
  );
  const tx = db.transaction((items) => {
    let n = 0;
    for (const artist of items) {
      stmt.run(artist);
      n++;
    }
    return n;
  });
  return tx(artists);
}

// Give artists that failed on a previous run another attempt on the next run.
export function resetFailedIngestArtists(db) {
  return db
    .prepare(
      `UPDATE ingest_artists SET status = 'pending', error = NULL, updated_at = datetime('now')
       WHERE status = 'failed'`,
    )
    .run().changes;
}

export function nextPendingIngestArtist(db) {
  return (
    db
      .prepare(
        `SELECT artist_slug AS slug, artist_name AS name
         FROM ingest_artists WHERE status = 'pending'
         ORDER BY discovered_at, artist_slug LIMIT 1`,
      )
      .get() ?? null
  );
}

export function markIngestArtist(db, artistSlug, status, error = null) {
  db.prepare(
    `UPDATE ingest_artists SET status = ?, error = ?, updated_at = datetime('now')
     WHERE artist_slug = ?`,
  ).run(status, error, artistSlug);
}

export function ingestArtistCounts(db) {
  const counts = { pending: 0, done: 0, failed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM ingest_artists GROUP BY status').all()) {
    counts[row.status] = row.n;
  }
  return counts;
}
