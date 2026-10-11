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
  shows           INTEGER,
  articles        INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  signal_status   TEXT NOT NULL DEFAULT 'pending',
  signal_error    TEXT,
  discovered_at   TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_artists_status ON ingest_artists (status);
CREATE INDEX IF NOT EXISTS idx_ingest_artists_signal_status ON ingest_artists (signal_status);

-- Enriched momentum signals, one latest snapshot per artist. A refresh overwrites the row
-- idempotently; the raw counts stay for audit. This table is read on the appraisal path
-- (never fetched live there) and written only by the resumable signals ingest.
CREATE TABLE IF NOT EXISTS artist_signals (
  artist_slug         TEXT PRIMARY KEY,
  artist_name         TEXT,
  as_of               TEXT,
  follows             INTEGER,
  shows_total         INTEGER,
  shows_36mo          INTEGER,
  solo_36mo           INTEGER,
  group_36mo          INTEGER,
  gallery_count       INTEGER,
  best_gallery_tier   TEXT,
  articles_total      INTEGER,
  articles_24mo       INTEGER,
  press_tier          TEXT,
  followers_delta_90d INTEGER,
  source              TEXT,
  fetched_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artist_signals_name ON artist_signals (artist_name);
`;

// Columns added to `ingest_artists` after the original schema shipped. `CREATE TABLE IF NOT
// EXISTS` does not add them to an existing database, so they are migrated explicitly.
const INGEST_ARTIST_MIGRATIONS = [
  ['shows', 'INTEGER'],
  ['articles', 'INTEGER'],
  ['signal_status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['signal_error', 'TEXT'],
];

export function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const ingestColumns = new Set(db.prepare('PRAGMA table_info(ingest_artists)').all().map((c) => c.name));
  for (const [name, ddl] of INGEST_ARTIST_MIGRATIONS) {
    if (!ingestColumns.has(name)) db.exec(`ALTER TABLE ingest_artists ADD COLUMN ${name} ${ddl}`);
  }
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
// re-queued when a discovery page is read again after a restart. An artist with no auction results
// has no sales to fetch, so it starts life already done on the sales queue (signals are tracked
// separately by `signal_status`).
export function upsertIngestArtists(db, artists) {
  const stmt = db.prepare(
    `INSERT INTO ingest_artists (artist_slug, artist_name, auction_results, shows, articles, status)
     VALUES (@artist_slug, @artist_name, @auction_results, @shows, @articles, @status)
     ON CONFLICT(artist_slug) DO UPDATE SET
       artist_name = excluded.artist_name,
       auction_results = excluded.auction_results,
       shows = excluded.shows,
       articles = excluded.articles,
       updated_at = datetime('now')`,
  );
  const tx = db.transaction((items) => {
    let n = 0;
    for (const artist of items) {
      const auctionResults = Number(artist.auction_results ?? 0);
      stmt.run({
        artist_slug: artist.artist_slug,
        artist_name: artist.artist_name ?? null,
        auction_results: auctionResults,
        shows: Number(artist.shows ?? 0),
        articles: Number(artist.articles ?? 0),
        status: artist.status ?? (auctionResults > 0 ? 'pending' : 'done'),
      });
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

// ---------------------------------------------------------------------------
// Artist momentum signals
// ---------------------------------------------------------------------------

// Turn a free-form artist name into the same slug shape Artsy uses, so a typed
// name can match a stored slug without a live lookup.
export function artistSlugFromName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Fill every named column so better-sqlite3 never sees a missing parameter.
function normalizeSignalRow(signals = {}) {
  return {
    artist_slug: signals.artist_slug,
    artist_name: signals.artist_name ?? null,
    as_of: signals.as_of ?? null,
    follows: Number(signals.follows ?? 0),
    shows_total: Number(signals.shows_total ?? 0),
    shows_36mo: Number(signals.shows_36mo ?? 0),
    solo_36mo: Number(signals.solo_36mo ?? 0),
    group_36mo: Number(signals.group_36mo ?? 0),
    gallery_count: Number(signals.gallery_count ?? 0),
    best_gallery_tier: signals.best_gallery_tier ?? null,
    articles_total: Number(signals.articles_total ?? 0),
    articles_24mo: Number(signals.articles_24mo ?? 0),
    press_tier: signals.press_tier ?? null,
    followers_delta_90d: Number(signals.followers_delta_90d ?? 0),
    source: signals.source ?? 'artsy',
    fetched_at: signals.fetched_at ?? new Date().toISOString(),
  };
}

// Idempotent latest-snapshot write: a refresh overwrites the artist's row.
export function upsertArtistSignals(db, signals) {
  const stmt = db.prepare(
    `INSERT INTO artist_signals (
       artist_slug, artist_name, as_of, follows, shows_total, shows_36mo, solo_36mo, group_36mo,
       gallery_count, best_gallery_tier, articles_total, articles_24mo, press_tier,
       followers_delta_90d, source, fetched_at
     ) VALUES (
       @artist_slug, @artist_name, @as_of, @follows, @shows_total, @shows_36mo, @solo_36mo, @group_36mo,
       @gallery_count, @best_gallery_tier, @articles_total, @articles_24mo, @press_tier,
       @followers_delta_90d, @source, @fetched_at
     )
     ON CONFLICT(artist_slug) DO UPDATE SET
       artist_name = excluded.artist_name, as_of = excluded.as_of, follows = excluded.follows,
       shows_total = excluded.shows_total, shows_36mo = excluded.shows_36mo,
       solo_36mo = excluded.solo_36mo, group_36mo = excluded.group_36mo,
       gallery_count = excluded.gallery_count, best_gallery_tier = excluded.best_gallery_tier,
       articles_total = excluded.articles_total, articles_24mo = excluded.articles_24mo,
       press_tier = excluded.press_tier, followers_delta_90d = excluded.followers_delta_90d,
       source = excluded.source, fetched_at = excluded.fetched_at`,
  );
  const tx = db.transaction((items) => {
    let n = 0;
    for (const item of items) {
      stmt.run(normalizeSignalRow(item));
      n++;
    }
    return n;
  });
  return tx(signals);
}

// Look a snapshot up by slug or by a typed name (case- and diacritic-insensitive).
export function getArtistSignals(db, artist) {
  const raw = String(artist ?? '').trim();
  if (!raw) return null;
  const slug = artistSlugFromName(raw);
  const row = db
    .prepare(
      `SELECT * FROM artist_signals
       WHERE artist_slug = ? OR artist_slug = ? OR artist_name = ? COLLATE NOCASE
       LIMIT 1`,
    )
    .get(raw, slug, raw);
  return row ?? null;
}

export function allArtistSignals(db) {
  return db.prepare('SELECT * FROM artist_signals').all();
}

export function artistSignalsCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM artist_signals').get().n;
}

// The signals queue is every queued artist that has not been enriched yet.
export function nextPendingSignalArtist(db) {
  return (
    db
      .prepare(
        `SELECT artist_slug AS slug, artist_name AS name
         FROM ingest_artists WHERE signal_status = 'pending'
         ORDER BY discovered_at, artist_slug LIMIT 1`,
      )
      .get() ?? null
  );
}

export function markSignalArtist(db, artistSlug, status, error = null) {
  db.prepare(
    `UPDATE ingest_artists SET signal_status = ?, signal_error = ?, updated_at = datetime('now')
     WHERE artist_slug = ?`,
  ).run(status, error, artistSlug);
}

// Give artists whose signals failed on a previous run another attempt.
export function resetFailedSignalArtists(db) {
  return db
    .prepare(
      `UPDATE ingest_artists SET signal_status = 'pending', signal_error = NULL,
         updated_at = datetime('now')
       WHERE signal_status = 'failed'`,
    )
    .run().changes;
}

export function signalArtistCounts(db) {
  const counts = { pending: 0, done: 0, failed: 0 };
  for (const row of db
    .prepare('SELECT signal_status, COUNT(*) AS n FROM ingest_artists GROUP BY signal_status')
    .all()) {
    counts[row.signal_status] = row.n;
  }
  return counts;
}
