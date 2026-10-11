import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artistSignalsCount,
  getArtistSignals,
  getIngestState,
  ingestArtistCounts,
  markIngestArtist,
  openDb,
  salesCount,
} from '../src/db.js';
import {
  fetchArtistSales,
  fetchArtistsPage,
  ingestAll,
  ingestAllFull,
  ingestSignals,
} from '../src/artsy.js';

// ---------------------------------------------------------------------------
// fake Artsy client
// ---------------------------------------------------------------------------

function lot(id, cents) {
  return {
    internalID: String(id),
    title: `Lot ${id}`,
    dateText: '1990',
    mediumText: 'lithograph',
    dimensionText: '50 x 40 cm',
    saleDate: '2020-01-01T00:00:00.000Z',
    organization: 'Test Auctions',
    priceRealized: { centsUSD: cents },
    estimate: { low: 0, high: 0 },
  };
}

// `pages` is keyed by cursor (null for the first page). A `node: null` entry models the bad
// catalog rows Artsy returns alongside a GraphQL non-null error.
function makeClient({
  pages = [],
  lots = {},
  failListCursors = new Set(),
  failArtistSlugs = new Set(),
  signalCounts = {},
  signalShows = {},
  failSignalSlugs = new Set(),
} = {}) {
  const calls = { lists: [], artists: [], signals: [] };
  const gqlImpl = async (query, variables) => {
    if (query.includes('artistsConnection(')) {
      const cursor = variables.cursor ?? null;
      calls.lists.push(cursor);
      if (failListCursors.has(cursor)) throw new Error(`list page ${cursor} exploded`);
      const page = pages.find((p) => (p.cursor ?? null) === cursor);
      if (!page) throw new Error(`no fake page for cursor ${cursor}`);
      return {
        artistsConnection: {
          pageInfo: { endCursor: page.endCursor, hasNextPage: page.hasNextPage },
          edges: page.artists.map((artist) => ({ node: artist })),
        },
      };
    }
    if (query.includes('auctionResultsConnection')) {
      calls.artists.push(variables.slug);
      if (failArtistSlugs.has(variables.slug)) throw new Error(`artist ${variables.slug} exploded`);
      const nodes = lots[variables.slug] ?? [];
      return {
        artist: {
          name: `Name ${variables.slug}`,
          auctionResultsConnection: {
            totalCount: nodes.length,
            pageInfo: { endCursor: null, hasNextPage: false },
            edges: nodes.map((node) => ({ node })),
          },
        },
      };
    }
    if (query.includes('counts { follows')) {
      calls.signals.push(variables.slug);
      if (failSignalSlugs.has(variables.slug)) throw new Error(`signals ${variables.slug} exploded`);
      const counts = signalCounts[variables.slug] ?? { follows: 0, articles: 0, shows: 0 };
      return { artist: { name: `Name ${variables.slug}`, counts } };
    }
    if (query.includes('showsConnection')) {
      const nodes = signalShows[variables.slug] ?? [];
      return { artist: { showsConnection: { edges: nodes.map((node) => ({ node })) } } };
    }
    throw new Error('unexpected query');
  };
  return { gqlImpl, calls };
}

const CATALOG_PAGES = [
  {
    cursor: null,
    endCursor: 'cursor-1',
    hasNextPage: true,
    artists: [
      null,
      { slug: 'a', name: 'A', counts: { auctionResults: 2 } },
      { slug: 'b', name: 'B', counts: { auctionResults: 0 } },
      { slug: 'c', name: 'C', counts: { auctionResults: 1 } },
    ],
  },
  {
    cursor: 'cursor-1',
    endCursor: 'cursor-2',
    hasNextPage: false,
    artists: [{ slug: 'd', name: 'D', counts: { auctionResults: 3 } }],
  },
];

const CATALOG_LOTS = {
  a: [lot(1, 100000), lot(2, 200000)],
  c: [lot(3, 300000)],
  d: [lot(4, 400000), lot(5, 500000), lot(6, 600000)],
};

// ---------------------------------------------------------------------------
// default ingest is untouched
// ---------------------------------------------------------------------------

test('default ingestAll still fetches the given artists and inserts their sales', async () => {
  const db = openDb(':memory:');
  const { gqlImpl, calls } = makeClient({ lots: { x: [lot(1, 100000), lot(2, 200000)] } });
  const result = await ingestAll({
    db,
    artists: [{ slug: 'x', name: 'X' }],
    gqlImpl,
    retries: 0,
    log: () => {},
  });
  assert.equal(result.fetched, 2);
  assert.equal(result.inserted, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(calls.artists, ['x']);
  assert.equal(getIngestState(db, 'full_cursor'), null);
  db.close();
});

// ---------------------------------------------------------------------------
// catalog page parsing
// ---------------------------------------------------------------------------

test('fetchArtistsPage drops null nodes and reads auction result counts', async () => {
  const { gqlImpl } = makeClient({ pages: CATALOG_PAGES });
  const page = await fetchArtistsPage({ gqlImpl, retries: 0 });
  assert.deepEqual(
    page.artists.map((a) => a.slug),
    ['a', 'b', 'c'],
  );
  assert.equal(page.artists[0].auctionResults, 2);
  assert.equal(page.artists[1].auctionResults, 0);
  assert.equal(page.endCursor, 'cursor-1');
  assert.equal(page.hasNextPage, true);
});

// ---------------------------------------------------------------------------
// full ingest
// ---------------------------------------------------------------------------

test('full ingest enumerates the catalog and ingests only artists with auction results', async () => {
  const db = openDb(':memory:');
  const { gqlImpl, calls } = makeClient({ pages: CATALOG_PAGES, lots: CATALOG_LOTS });
  const result = await ingestAllFull({ db, gqlImpl, retries: 0, log: () => {} });

  assert.equal(result.discoveryDone, true);
  assert.equal(result.discovered, 3);
  assert.equal(result.artistsIngested, 3);
  assert.equal(result.fetched, 6);
  assert.equal(result.inserted, 6);
  assert.equal(result.total, 6);
  assert.equal(result.done, 3);
  assert.equal(result.pending, 0);
  assert.equal(typeof result.elapsedMs, 'number');
  assert.equal(salesCount(db), 6);
  assert.deepEqual(calls.artists.sort(), ['a', 'c', 'd']);
  assert.ok(!calls.artists.includes('b'), 'artist with no auction results is not fetched');
  db.close();
});

test('fetchArtistSales reports when a finite page cap truncates an artist', async () => {
  let page = 0;
  const gqlImpl = async () => {
    page++;
    return {
      artist: {
        name: 'X',
        auctionResultsConnection: {
          totalCount: 999,
          pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` },
          edges: [{ node: lot(page, 100000) }],
        },
      },
    };
  };
  const logs = [];
  const rows = await fetchArtistSales(
    { slug: 'x', name: 'X' },
    { gqlImpl, retries: 0, maxPages: 2, log: (message) => logs.push(message) },
  );
  assert.equal(rows.length, 2);
  assert.ok(
    logs.some((message) => message.includes('page cap')),
    `expected a truncation warning, got:\n${logs.join('\n')}`,
  );
});

test('full ingest resumes from the saved cursor after a discovery page fails', async () => {
  const db = openDb(':memory:');

  const first = makeClient({
    pages: CATALOG_PAGES,
    lots: CATALOG_LOTS,
    failListCursors: new Set(['cursor-1']),
  });
  const run1 = await ingestAllFull({ db, gqlImpl: first.gqlImpl, retries: 0, log: () => {} });
  assert.equal(run1.discoveryDone, false);
  assert.equal(run1.artistsIngested, 2);
  assert.deepEqual(first.calls.artists.sort(), ['a', 'c']);
  assert.equal(getIngestState(db, 'full_cursor'), 'cursor-1');

  const second = makeClient({ pages: CATALOG_PAGES, lots: CATALOG_LOTS });
  const run2 = await ingestAllFull({ db, gqlImpl: second.gqlImpl, retries: 0, log: () => {} });
  assert.equal(run2.discoveryDone, true);
  assert.equal(run2.artistsIngested, 1);
  assert.deepEqual(second.calls.artists, ['d']);
  assert.deepEqual(second.calls.lists, ['cursor-1']);

  const third = makeClient({ pages: CATALOG_PAGES, lots: CATALOG_LOTS });
  const run3 = await ingestAllFull({ db, gqlImpl: third.gqlImpl, retries: 0, log: () => {} });
  assert.equal(run3.artistsIngested, 0);
  assert.deepEqual(third.calls.lists, [], 'completed discovery is not repeated');
  assert.deepEqual(third.calls.artists, [], 'done artists are not fetched again');
  assert.equal(salesCount(db), 6);
  db.close();
});

test('full ingest retries artists that failed on a previous run', async () => {
  const db = openDb(':memory:');
  const client = makeClient({ pages: CATALOG_PAGES, lots: CATALOG_LOTS });
  await ingestAllFull({ db, gqlImpl: client.gqlImpl, retries: 0, log: () => {} });

  // Simulate an artist left failed by an earlier run; its sales were never written.
  db.prepare('DELETE FROM sales WHERE artist_slug = ?').run('c');
  markIngestArtist(db, 'c', 'failed', 'network');
  assert.equal(ingestArtistCounts(db).failed, 1);

  const retry = makeClient({ pages: CATALOG_PAGES, lots: CATALOG_LOTS });
  const result = await ingestAllFull({ db, gqlImpl: retry.gqlImpl, retries: 0, log: () => {} });
  assert.equal(result.artistsIngested, 1);
  assert.deepEqual(retry.calls.artists, ['c']);
  assert.equal(ingestArtistCounts(db).failed, 0);
  assert.equal(salesCount(db), 6);
  db.close();
});

// ---------------------------------------------------------------------------
// momentum signals ingest (acceptance criterion 7)
// ---------------------------------------------------------------------------

const SIGNAL_CATALOG = [
  {
    cursor: null,
    endCursor: null,
    hasNextPage: false,
    artists: [
      { slug: 'auctioned', name: 'Auctioned', counts: { auctionResults: 2, shows: 4, articles: 1 } },
      { slug: 'emerging', name: 'Emerging', counts: { auctionResults: 0, shows: 12, articles: 9 } },
      { slug: 'quiet', name: 'Quiet', counts: { auctionResults: 0, shows: 0, articles: 0 } },
    ],
  },
];

const SIGNAL_NOW = new Date('2025-06-01T00:00:00.000Z');

function signalClient(extra = {}) {
  return makeClient({
    signalCounts: {
      auctioned: { follows: 1200, articles: 4, shows: 4 },
      emerging: { follows: 800, articles: 9, shows: 12 },
    },
    signalShows: {
      auctioned: [
        { startAt: '2024-01-01T00:00:00.000Z', isSolo: true, partner: { name: 'Blue', categories: ['blue-chip'] } },
      ],
      emerging: [
        { startAt: '2024-02-01T00:00:00.000Z', isSolo: true, partner: { name: 'Est', categories: ['established'] } },
        { startAt: '2023-05-01T00:00:00.000Z', isSolo: false, partner: { name: 'Eme', categories: ['emerging'] } },
      ],
    },
    ...extra,
  });
}

test('signals ingest stores zero-auction artists and resumes from the queue', async () => {
  const db = openDb(':memory:');
  const catalog = makeClient({ pages: SIGNAL_CATALOG, lots: { auctioned: [lot(1, 100000)] } });
  const sales = await ingestAllFull({ db, gqlImpl: catalog.gqlImpl, retries: 0, log: () => {} });
  assert.equal(sales.discovered, 2, 'only artists with a signal are queued');
  assert.equal(sales.artistsIngested, 1, 'only the auctioned artist has sales to fetch');
  assert.equal(salesCount(db), 1);

  const client = signalClient();
  // Bounded runs of one artist each, then resume until the queue is empty.
  const first = await ingestSignals({ db, maxArtists: 1, gqlImpl: client.gqlImpl, retries: 0, log: () => {}, now: SIGNAL_NOW });
  assert.equal(first.stored, 1);
  assert.equal(first.pending, 1);
  const second = await ingestSignals({ db, maxArtists: 1, gqlImpl: client.gqlImpl, retries: 0, log: () => {}, now: SIGNAL_NOW });
  assert.equal(second.stored, 1);
  assert.equal(second.pending, 0);
  const third = await ingestSignals({ db, maxArtists: 1, gqlImpl: client.gqlImpl, retries: 0, log: () => {}, now: SIGNAL_NOW });
  assert.equal(third.attempted, 0, 'a finished queue does no work');
  assert.equal(artistSignalsCount(db), 2);

  const emerging = getArtistSignals(db, 'emerging');
  assert.ok(emerging, 'the zero-auction artist is stored');
  assert.equal(emerging.artist_slug, 'emerging');
  assert.equal(emerging.shows_total, 12);
  assert.equal(emerging.shows_36mo, 2);
  assert.equal(emerging.solo_36mo, 1);
  assert.equal(emerging.group_36mo, 1);
  assert.equal(emerging.gallery_count, 2);
  assert.equal(emerging.best_gallery_tier, 'B');
  assert.equal(emerging.articles_total, 9);

  // A refresh overwrites the same row instead of duplicating it.
  await ingestSignals({ db, gqlImpl: signalClient({}).gqlImpl, retries: 0, log: () => {}, now: SIGNAL_NOW });
  assert.equal(artistSignalsCount(db), 2);
  db.close();
});

test('signals ingest retries artists that failed on a previous run', async () => {
  const db = openDb(':memory:');
  const catalog = makeClient({ pages: SIGNAL_CATALOG, lots: {} });
  await ingestAllFull({ db, gqlImpl: catalog.gqlImpl, retries: 0, log: () => {} });

  const failing = signalClient({ failSignalSlugs: new Set(['emerging']) });
  const run1 = await ingestSignals({ db, gqlImpl: failing.gqlImpl, retries: 0, log: () => {}, now: SIGNAL_NOW });
  assert.equal(run1.stored, 1);
  assert.equal(run1.failed, 1);
  assert.equal(run1.queueFailed, 1);
  assert.equal(getArtistSignals(db, 'emerging'), null);

  const good = signalClient();
  const run2 = await ingestSignals({ db, gqlImpl: good.gqlImpl, retries: 0, log: () => {}, now: SIGNAL_NOW });
  assert.equal(run2.failed, 0);
  assert.equal(run2.queueFailed, 0);
  assert.ok(getArtistSignals(db, 'emerging'));
  db.close();
});
