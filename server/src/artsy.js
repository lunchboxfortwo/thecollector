// Artsy internal GraphQL client + ingest. No auth; sequential and polite.
import { insertSales, salesCount } from './db.js';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Artsy GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

async function gqlWithRetry(query, variables, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await gql(query, variables);
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

export async function fetchArtistSales(artist, { maxPages = 40, log = () => {} } = {}) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await gqlWithRetry(QUERY, { slug: artist.slug, cursor });
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
    log(`  ${artist.slug}: page ${page + 1}/${maxPages}, ${rows.length} realized lots (of ${conn.totalCount} total)`);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return rows;
}

export async function ingestAll({ db, artists = DEFAULT_ARTISTS, maxPages = 40, log = console.log } = {}) {
  const collected = [];
  for (const artist of artists) {
    try {
      const rows = await fetchArtistSales(artist, { maxPages, log });
      collected.push(...rows);
    } catch (err) {
      log(`  ! ${artist.slug} failed: ${err.message}`);
    }
  }
  const inserted = insertSales(db, collected);
  const total = salesCount(db);
  return { fetched: collected.length, inserted, total };
}
