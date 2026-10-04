// Artsy internal GraphQL client + ingest. No auth; sequential and polite.
import {
  getIngestState,
  ingestArtistCounts,
  insertSales,
  markIngestArtist,
  nextPendingIngestArtist,
  resetFailedIngestArtists,
  salesCount,
  setIngestState,
  upsertIngestArtists,
} from './db.js';
import { classifyMedium, normalizeTitle, parseAreaCm2, parseYear } from './valuation.js';

export const ENDPOINT =
  process.env.ARTSY_GRAPHQL_URL || 'https://metaphysics-production.artsy.net/v2';

export const DEFAULT_ARTISTS = [
  { slug: 'andy-warhol', name: 'Andy Warhol' },
  { slug: 'pablo-picasso', name: 'Pablo Picasso' },
  { slug: 'banksy', name: 'Banksy' },
  { slug: 'keith-haring', name: 'Keith Haring' },
  { slug: 'joan-miro', name: 'Joan Miró' },
  { slug: 'marc-chagall', name: 'Marc Chagall' },
  { slug: 'yayoi-kusama', name: 'Yayoi Kusama' },
];

// The live schema takes `String!` (the plan's draft used `ID!`, which the server rejects).
const QUERY = `
query ($slug: String!, $cursor: String) {
  artist(id: $slug) {
    name
    auctionResultsConnection(first: 100, after: $cursor, sort: DATE_DESC) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges {
        node {
          internalID
          title
          dateText
          mediumText
          dimensionText
          saleDate
          organization
          priceRealized { centsUSD }
          estimate { low high }
        }
      }
    }
  }
}`;

// Paged walk over the whole artist catalog, used only by the full ingest. SORTABLE_ID_ASC is a
// stable order, so the saved end cursor is a valid resume point; `counts.auctionResults` lets us
// keep only artists that actually have results to fetch.
export const LIST_ARTISTS_QUERY = `
query ($cursor: String, $first: Int!) {
  artistsConnection(first: $first, after: $cursor, sort: SORTABLE_ID_ASC) {
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        slug
        name
        counts { auctionResults }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `tolerateErrors` keeps a page that carried usable `data` alongside per-node GraphQL errors
// (Artsy returns one for artists whose slug/name violates the schema's non-null constraint).
async function gql(query, variables, { tolerateErrors = false } = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Artsy GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length && !(tolerateErrors && json.data)) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

async function gqlWithRetry(query, variables, { retries = 3, gqlImpl = gql, tolerateErrors = false } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await gqlImpl(query, variables, { tolerateErrors });
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

// Convert a GraphQL node to a DB row. Returns null for lots without a realized price.
export function nodeToRow(artist, node) {
  const cents = node?.priceRealized?.centsUSD;
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const internalID = node?.internalID == null ? '' : String(node.internalID);
  if (!internalID) return null;
  const title = node.title ?? null;
  return {
    artist_slug: artist.slug,
    artist_name: node.__artistName || artist.name,
    internal_id: internalID,
    title,
    title_norm: normalizeTitle(title),
    date_text: node.dateText ?? null,
    sale_date: node.saleDate ?? null,
    medium_text: node.mediumText ?? null,
    medium_class: classifyMedium(node.mediumText),
    dimension_text: node.dimensionText ?? null,
    area_cm2: parseAreaCm2(node.dimensionText),
    creation_year: parseYear(node.dateText),
    organization: node.organization ?? null,
    price_cents: cents,
  };
}

export async function fetchArtistSales(artist, { maxPages = 40, log = () => {}, gqlImpl = gql, retries = 3 } = {}) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await gqlWithRetry(QUERY, { slug: artist.slug, cursor }, { gqlImpl, retries });
    } catch (err) {
      // Keep whatever was fetched rather than discarding the whole artist.
      log(`  ! ${artist.slug}: page ${page + 1} failed after retries (${err.message}); keeping ${rows.length} rows`);
      break;
    }
    const artistNode = data?.artist;
    const conn = artistNode?.auctionResultsConnection;
    if (!conn) break;
    const name = artistNode.name || artist.name;
    for (const edge of conn.edges ?? []) {
      const row = nodeToRow(artist, { ...edge.node, __artistName: name });
      if (row) rows.push(row);
    }
    const pageCap = Number.isFinite(maxPages) ? maxPages : 'all';
    log(`  ${artist.slug}: page ${page + 1}/${pageCap}, ${rows.length} realized lots (of ${conn.totalCount} total)`);
    if (!conn.pageInfo?.hasNextPage) break;
    if (page + 1 >= maxPages) {
      log(`  ! ${artist.slug}: stopped at the ${maxPages}-page cap with more results available; raise maxPages to fetch them`);
      break;
    }
    cursor = conn.pageInfo.endCursor;
  }
  return rows;
}

export async function ingestAll({ db, artists = DEFAULT_ARTISTS, maxPages = 40, log = console.log, gqlImpl = gql, retries = 3 } = {}) {
  const collected = [];
  for (const artist of artists) {
    try {
      const rows = await fetchArtistSales(artist, { maxPages, log, gqlImpl, retries });
      collected.push(...rows);
    } catch (err) {
      log(`  ! ${artist.slug} failed: ${err.message}`);
    }
  }
  const inserted = insertSales(db, collected);
  const total = salesCount(db);
  return { fetched: collected.length, inserted, total };
}

// One page of the artist catalog. Null nodes (bad catalog rows) are dropped; artists with no
// auction results are left for the caller to filter out.
export async function fetchArtistsPage({ cursor = null, first = 100, gqlImpl = gql, retries = 3 } = {}) {
  const data = await gqlWithRetry(LIST_ARTISTS_QUERY, { cursor, first }, { gqlImpl, retries, tolerateErrors: true });
  const conn = data?.artistsConnection;
  const artists = (conn?.edges ?? [])
    .map((edge) => edge?.node)
    .filter((node) => node && typeof node.slug === 'string' && node.slug.length > 0)
    .map((node) => ({
      slug: node.slug,
      name: node.name ?? null,
      auctionResults: Number(node.counts?.auctionResults ?? 0),
    }));
  return {
    artists,
    endCursor: conn?.pageInfo?.endCursor ?? null,
    hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
  };
}

// Drain every pending queued artist. Rows are written per artist so a stop leaves finished work
// finished; a fetch that throws marks the artist failed and moves on instead of aborting the run.
async function drainPendingArtists({ db, maxPages, log, gqlImpl, retries }) {
  const stats = { artists: 0, fetched: 0, inserted: 0 };
  for (;;) {
    const artist = nextPendingIngestArtist(db);
    if (!artist) break;
    try {
      const rows = await fetchArtistSales(artist, { maxPages, log, gqlImpl, retries });
      stats.fetched += rows.length;
      stats.inserted += insertSales(db, rows);
      markIngestArtist(db, artist.slug, 'done');
      stats.artists++;
    } catch (err) {
      log(`  ! ${artist.slug} failed: ${err.message}`);
      markIngestArtist(db, artist.slug, 'failed', err.message);
    }
  }
  return stats;
}

// Full ingest: walk the entire artist catalog, queue every artist that has auction results, and
// fetch each one's realized sales. Discovery and ingestion checkpoint to the database, so an
// interrupted run resumes from the saved cursor and skips artists already marked done.
export async function ingestAllFull({ db, first = 100, maxPages = Infinity, log = console.log, gqlImpl = gql, retries = 3 } = {}) {
  const startedAt = Date.now();
  const requeued = resetFailedIngestArtists(db);
  if (requeued) log(`Requeued ${requeued} artist(s) that failed on a previous run.`);

  let discovered = 0;
  const drained = { artists: 0, fetched: 0, inserted: 0 };
  let cursor = getIngestState(db, 'full_cursor');
  let discoveryDone = getIngestState(db, 'full_done') === '1';

  if (!discoveryDone) {
    for (;;) {
      let page;
      try {
        page = await fetchArtistsPage({ cursor, first, gqlImpl, retries });
      } catch (err) {
        log(`  ! artist discovery failed at ${cursor ? `cursor ${cursor}` : 'the start'} (${err.message}); will resume next run`);
        break;
      }

      const withResults = page.artists.filter((artist) => artist.auctionResults > 0);
      discovered += withResults.length;
      upsertIngestArtists(
        db,
        withResults.map((artist) => ({
          artist_slug: artist.slug,
          artist_name: artist.name,
          auction_results: artist.auctionResults,
        })),
      );
      log(
        `Discovered ${withResults.length} artist(s) with auction results on this page (${page.artists.length} scanned; +${Math.round((Date.now() - startedAt) / 1000)}s).`,
      );

      // Save discovery progress before the (possibly long) drain so a stop never loses it.
      if (page.endCursor) setIngestState(db, 'full_cursor', page.endCursor);
      if (!page.hasNextPage) {
        setIngestState(db, 'full_done', '1');
        discoveryDone = true;
      }

      const pageDrain = await drainPendingArtists({ db, maxPages, log, gqlImpl, retries });
      drained.artists += pageDrain.artists;
      drained.fetched += pageDrain.fetched;
      drained.inserted += pageDrain.inserted;
      log(
        `Progress: ${discovered} artist(s) discovered, ${drained.artists} ingested, ${drained.inserted} rows inserted, +${Math.round((Date.now() - startedAt) / 1000)}s.`,
      );

      if (discoveryDone) break;
      if (!page.endCursor) {
        log('  ! discovery returned no cursor; stopping to avoid a loop.');
        break;
      }
      cursor = page.endCursor;
    }
  }

  // Drain anything left over, including artists queued by an earlier interrupted run.
  const finalDrain = await drainPendingArtists({ db, maxPages, log, gqlImpl, retries });
  drained.artists += finalDrain.artists;
  drained.fetched += finalDrain.fetched;
  drained.inserted += finalDrain.inserted;

  const total = salesCount(db);
  const counts = ingestArtistCounts(db);
  return {
    discovered,
    artistsIngested: drained.artists,
    fetched: drained.fetched,
    inserted: drained.inserted,
    total,
    discoveryDone,
    pending: counts.pending,
    done: counts.done,
    failed: counts.failed,
    elapsedMs: Date.now() - startedAt,
  };
}
