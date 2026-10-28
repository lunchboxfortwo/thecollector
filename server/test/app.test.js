import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, insertSales, upsertArtistSignals } from '../src/db.js';
import { createApp } from '../src/index.js';
import { buildModel, classifyMedium, normalizeTitle } from '../src/valuation.js';

function makeSale({ artist, title, price, area, medium, year, id }) {
  return {
    artist_slug: artist,
    artist_name: artist,
    internal_id: String(id),
    title,
    title_norm: normalizeTitle(title),
    date_text: String(year),
    sale_date: `${year}-06-01T00:00:00.000Z`,
    medium_text: medium,
    medium_class: classifyMedium(medium),
    dimension_text: `${Math.sqrt(area).toFixed(1)} x ${Math.sqrt(area).toFixed(1)} cm`,
    area_cm2: area,
    creation_year: year,
    organization: 'Test Auctions',
    price_cents: Math.round(price * 100),
  };
}

function seededDb() {
  const db = openDb(':memory:');
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push(
      makeSale({
        artist: 'andy-warhol',
        title: i % 6 === 0 ? "Campbell's Soup" : `Work ${i}`,
        price: 1000 + i * 250,
        area: 500 + i * 40,
        medium: 'print',
        year: 1960 + (i % 20),
        id: i,
      }),
    );
  }
  insertSales(db, rows);
  return db;
}

async function startApp(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('prewarm builds the model before the listener opens', async () => {
  const db = seededDb();
  let builds = 0;
  const app = createApp({
    db,
    visionEnabled: () => false,
    prewarm: true,
    buildModelFn: (rows) => {
      builds++;
      return buildModel(rows);
    },
  });
  // The build must already be done when createApp returns, before anyone can
  // listen or send the first appraisal.
  assert.equal(builds, 1);
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      hints: { artist: 'andy-warhol', title: "Campbell's Soup", medium: 'print' },
    });
    assert.equal(json.status, 'priced');
    assert.equal(builds, 1, 'the first appraisal must reuse the prewarmed model');
  } finally {
    server.close();
    db.close();
  }
});

test('start command reserves enough heap for the model build', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const match = String(pkg.scripts?.start || '').match(/--max-old-space-size=(\d+)/);
  assert.ok(match, 'npm start must set --max-old-space-size');
  assert.ok(
    Number(match[1]) >= 20480,
    `start heap ${match[1]} MB must fit the ~15 GB model build`,
  );
});

test('GET /health returns ok', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
    db.close();
  }
});

test('unidentified request returns needs_details with the five fields', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/appraise', {});
    assert.equal(status, 200);
    assert.equal(json.status, 'needs_details');
    assert.deepEqual(json.missing_fields, ['artist', 'year', 'country', 'size', 'medium']);
    assert.equal(json.value, null);
  } finally {
    server.close();
    db.close();
  }
});

test('image with vision disabled returns needs_details', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
    });
    assert.equal(json.status, 'needs_details');
  } finally {
    server.close();
    db.close();
  }
});

test('resubmitting hints returns a priced range with coverage', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/appraise', {
      hints: {
        artist: 'andy-warhol',
        title: "Campbell's Soup",
        size: '100 x 100 cm',
        medium: 'print',
        year: '1968',
        country: 'USA',
      },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'priced');
    assert.equal(typeof json.value.low, 'number');
    assert.equal(typeof json.value.high, 'number');
    assert.ok(json.value.high >= json.value.low);
    assert.equal(json.value.currency, 'USD');
    assert.equal(typeof json.confidence.coverage, 'number');
    assert.ok(json.confidence.basis.length > 0);
    assert.ok(Array.isArray(json.provenance));
    assert.ok(Array.isArray(json.similar));
  } finally {
    server.close();
    db.close();
  }
});

test('a zero-auction artist is priced from momentum and no source is named', async () => {
  const db = seededDb();
  upsertArtistSignals(db, [
    {
      artist_slug: 'emerging-artist',
      artist_name: 'Emerging Artist',
      follows: 5000,
      shows_total: 10,
      shows_36mo: 8,
      solo_36mo: 4,
      group_36mo: 4,
      gallery_count: 5,
      best_gallery_tier: 'B',
      articles_total: 20,
      articles_24mo: 10,
      press_tier: 'B',
    },
  ]);
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/appraise', {
      hints: {
        artist: 'Emerging Artist',
        medium: 'print',
        size: '100 x 100 cm',
        year: '2015',
        country: 'Japan',
      },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'priced');
    assert.equal(json.confidence.level, 'momentum');
    assert.equal(json.confidence.coverage, null);
    assert.ok(
      json.confidence.basis.some((line) => line.toLowerCase().includes('momentum')),
      `expected a momentum basis line, got:\n${json.confidence.basis.join('\n')}`,
    );
    assert.ok(json.confidence.basis.includes('coverage: unavailable'));
    const { low, high } = json.value;
    const mid = (low + high) / 2;
    assert.ok(low >= mid * 0.9 - 1e-6 && high <= mid * 1.1 + 1e-6, `range ${low}-${high} mid ${mid}`);
    assert.deepEqual(json.sources, []);
    assert.ok(!/artsy/i.test(JSON.stringify(json)));
  } finally {
    server.close();
    db.close();
  }
});

test('a priced reply positions the work inside the artist stored output', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/appraise', {
      hints: {
        artist: 'andy-warhol',
        title: "Campbell's Soup",
        size: '100 x 100 cm',
        medium: 'print',
        year: '1968',
        country: 'USA',
      },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'priced');
    assert.equal(json.positioning.available, true);
    assert.equal(json.positioning.sampleSize, 60);
    for (const key of ['medium', 'size', 'year', 'edition']) {
      assert.equal(typeof json.positioning.percentiles[key], 'number', `${key} should have a percentile`);
    }
    assert.ok(
      json.confidence.basis.some((line) => line.includes('stored works')),
      `expected a positioning basis line, got:\n${json.confidence.basis.join('\n')}`,
    );
  } finally {
    server.close();
    db.close();
  }
});

test('a momentum artist reports positioning unavailable, with no percentile', async () => {
  const db = seededDb();
  upsertArtistSignals(db, [
    {
      artist_slug: 'emerging-artist',
      artist_name: 'Emerging Artist',
      follows: 5000,
      shows_total: 10,
      shows_36mo: 8,
      solo_36mo: 4,
      group_36mo: 4,
      gallery_count: 5,
      best_gallery_tier: 'B',
      articles_total: 20,
      articles_24mo: 10,
      press_tier: 'B',
    },
  ]);
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/appraise', {
      hints: {
        artist: 'Emerging Artist',
        medium: 'print',
        size: '100 x 100 cm',
        year: '2015',
        country: 'Japan',
      },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'priced');
    assert.equal(json.confidence.level, 'momentum');
    assert.equal(json.positioning.available, false);
    assert.equal(json.positioning.sampleSize, 0);
    assert.equal(json.positioning.percentiles, null);
    assert.ok(
      json.positioning.basis.some((line) => /unavailable/i.test(line)),
      `expected positioning to report unavailable, got:\n${json.positioning.basis.join('\n')}`,
    );
  } finally {
    server.close();
    db.close();
  }
});

test('empty database refuses rather than inventing a value', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/appraise', {
      hints: { artist: 'andy-warhol' },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'refused');
    assert.equal(json.value, null);
  } finally {
    server.close();
    db.close();
  }
});

test('vision fills identity alongside a partial hint and the user hint wins', async () => {
  const db = seededDb();
  const calls = [];
  const vision = async (args) => {
    calls.push(args);
    return {
      identified: true,
      method: 'vision',
      artist: 'andy-warhol',
      title: "Campbell's Soup",
      medium: 'print',
      dimensions: '100 x 100 cm',
      year: '1968',
      country: 'Japan',
      provenance: 'Private collection, Tokyo.',
      match_confidence: 0.88,
    };
  };
  const app = createApp({ db, vision, visionEnabled: () => true });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
      note: 'estate sale',
      hints: { country: 'USA' },
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].note, /User-provided details: country: USA/);
    assert.equal(json.status, 'priced');
    assert.equal(json.identity.artist, 'andy-warhol');
    assert.equal(json.identity.method, 'vision');
    assert.equal(json.identity.country, 'USA'); // the hint beats the model's country
    assert.equal(json.identity.dimensions, '100 x 100 cm');
    assert.equal(json.identity.provenance, 'Private collection, Tokyo.');
    assert.equal(json.identity.match_confidence, 0.88);
    assert.equal(typeof json.value.low, 'number');
  } finally {
    server.close();
    db.close();
  }
});

test('a partial vision result asks only for the fields it could not fill', async () => {
  const db = seededDb();
  const app = createApp({
    db,
    vision: async () => ({ identified: true, method: 'vision', country: 'Japan', match_confidence: 0.5 }),
    visionEnabled: () => true,
  });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
    });
    assert.equal(json.status, 'needs_details');
    assert.deepEqual(json.missing_fields, ['artist', 'year', 'size', 'medium']);
    assert.equal(json.identity.country, 'Japan');
    assert.equal(json.value, null);
  } finally {
    server.close();
    db.close();
  }
});

test('a provider failure falls back to needs_details and names the failure', async () => {
  const db = seededDb();
  const app = createApp({
    db,
    vision: async () => ({ identified: false, reason: 'vision HTTP 503' }),
    visionEnabled: () => true,
  });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
    });
    assert.equal(json.status, 'needs_details');
    assert.deepEqual(json.missing_fields, ['artist', 'year', 'country', 'size', 'medium']);
    assert.ok(json.confidence.basis.some((line) => line.includes('vision HTTP 503')));
  } finally {
    server.close();
    db.close();
  }
});

test('with no vision key an image still prices from the user hints', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
      hints: { artist: 'andy-warhol', title: "Campbell's Soup", size: '100 x 100 cm', medium: 'print', year: '1968' },
    });
    assert.equal(json.status, 'priced');
    assert.equal(json.identity.artist, 'andy-warhol');
    assert.equal(json.identity.method, 'catalog');
    assert.equal(typeof json.value.low, 'number');
  } finally {
    server.close();
    db.close();
  }
});

test('malformed bodies return 400', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const badHints = await postJson(base, '/appraise', { hints: 'nope' });
    assert.equal(badHints.status, 400);

    const badImage = await postJson(base, '/appraise', { imageBase64: 123 });
    assert.equal(badImage.status, 400);

    const res = await fetch(`${base}/appraise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
    db.close();
  }
});

const CACHE_HINTS = {
  // No title: the estimate uses the pooled hedonic model, whose basis line
  // reports the trained row count.
  hints: {
    artist: 'andy-warhol',
    size: '100 x 100 cm',
    medium: 'print',
    year: '1968',
    country: 'USA',
  },
};

function growTable(db) {
  const rows = [];
  for (let i = 100; i < 120; i++) {
    rows.push(
      makeSale({
        artist: 'andy-warhol',
        title: 'Soup',
        price: 5000,
        area: 900,
        medium: 'print',
        year: 1970,
        id: i,
      }),
    );
  }
  insertSales(db, rows);
}

function hedonicBasis(json) {
  return json.confidence.basis.find((b) => b.startsWith('Hedonic'));
}

async function cacheApp(db, rebuildMinutes) {
  process.env.MODEL_REBUILD_MINUTES = rebuildMinutes;
  try {
    const app = createApp({ db, visionEnabled: () => false });
    const server = await startApp(app);
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  } finally {
    delete process.env.MODEL_REBUILD_MINUTES;
  }
}

test('model is served from cache while the table grows, within the throttle window', async () => {
  const db = seededDb();
  const { server, base } = await cacheApp(db, '60');
  try {
    const before = await postJson(base, '/appraise', CACHE_HINTS);
    assert.equal(before.json.status, 'priced');
    const basisBefore = hedonicBasis(before.json);

    growTable(db);

    // Window has not elapsed: the request must be served from the cached
    // model even though the table now has 20 more rows.
    const stale = await postJson(base, '/appraise', CACHE_HINTS);
    assert.equal(stale.json.status, 'priced');
    assert.equal(hedonicBasis(stale.json), basisBefore);
  } finally {
    server.close();
    db.close();
  }
});

test('model refreshes after the throttle window elapses', async () => {
  const db = seededDb();
  const { server, base } = await cacheApp(db, '0');
  try {
    const before = await postJson(base, '/appraise', CACHE_HINTS);
    assert.equal(before.json.status, 'priced');
    const basisBefore = hedonicBasis(before.json);

    growTable(db);

    // Window is zero: a request triggers a background rebuild; once it
    // finishes, the new rows are reflected in responses.
    let refreshed = null;
    for (let i = 0; i < 50 && !refreshed; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const res = await postJson(base, '/appraise', CACHE_HINTS);
      if (hedonicBasis(res.json) && hedonicBasis(res.json) !== basisBefore) refreshed = res.json;
    }
    assert.ok(refreshed, 'expected the model to refresh after the throttle window');
    assert.equal(refreshed.status, 'priced');
    assert.equal(refreshed.value.currency, 'USD');
    assert.ok(hedonicBasis(refreshed).includes('80 recorded auction sales'));
  } finally {
    server.close();
    db.close();
  }
});

test('the priced range is capped to ±10% around its midpoint', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      hints: {
        artist: 'andy-warhol',
        title: "Campbell's Soup",
        size: '100 x 100 cm',
        medium: 'print',
        year: '1968',
        country: 'USA',
      },
    });
    assert.equal(json.status, 'priced');
    const { low, high } = json.value;
    const mid = (low + high) / 2;
    assert.ok(low >= mid * 0.9 - 1e-6, `low ${low} should be within 10% below the mid ${mid}`);
    assert.ok(high <= mid * 1.1 + 1e-6, `high ${high} should be within 10% above the mid ${mid}`);
  } finally {
    server.close();
    db.close();
  }
});

test('the appraisal reply never names the auction data provider', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      hints: {
        artist: 'andy-warhol',
        title: "Campbell's Soup",
        size: '100 x 100 cm',
        medium: 'print',
        year: '1968',
        country: 'USA',
      },
    });
    assert.equal(json.status, 'priced');
    assert.deepEqual(json.sources, []);
    for (const entry of json.provenance) {
      assert.equal(entry.source, undefined, 'provenance entries carry no provider');
      assert.ok(!/artsy/i.test(JSON.stringify(entry)));
    }
    assert.ok(!/artsy/i.test(JSON.stringify(json)));
  } finally {
    server.close();
    db.close();
  }
});

test('a price with a piece assessment still names no record source', async () => {
  const db = seededDb();
  const app = createApp({
    db,
    visionEnabled: () => true,
    vision: async () => ({
      identified: true,
      method: 'vision',
      artist: 'andy-warhol',
      title: "Campbell's Soup",
      medium: 'print',
      dimensions: '100 x 100 cm',
      year: '1968',
      country: 'USA',
      match_confidence: 0.9,
      attributes: { composition: 84, colorLight: 80, subject: 78, originality: 86, condition: 82 },
    }),
  });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
      hints: { size: '100 x 100 cm', medium: 'print' },
    });
    assert.equal(json.status, 'priced');
    assert.ok(json.assessment, 'expected the piece assessment');
    assert.deepEqual(json.sources, []);
    assert.ok(!/artsy/i.test(JSON.stringify(json)), 'no record source is named');
  } finally {
    server.close();
    db.close();
  }
});

test('the app renders no data-provider footer', () => {
  const src = readFileSync(new URL('../../app/App.js', import.meta.url), 'utf8');
  assert.ok(!/artsy/i.test(src), 'the app should not name the provider');
  assert.ok(!/provenance\[0\]\?\.source/.test(src), 'the provenance source footer should be gone');
});

test('malformed chat messages return 400', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await postJson(base, '/chat', { message: '   ' })).status, 400);
    assert.equal((await postJson(base, '/chat', { message: 42 })).status, 400);
    assert.equal((await postJson(base, '/chat', [1, 2, 3])).status, 400);
  } finally {
    server.close();
    db.close();
  }
});

test('a text-only chat message is answered and never runs the image path', async () => {
  const db = seededDb();
  const visionCalls = [];
  const chatCalls = [];
  const app = createApp({
    db,
    visionEnabled: () => true,
    vision: async (args) => {
      visionCalls.push(args);
      return { identified: false, reason: 'should not run' };
    },
    chat: async (args) => {
      chatCalls.push(args);
      return { answer: 'A fair offer sits near the low end of the recorded sales.', source: 'model' };
    },
  });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/chat', {
      message: 'What offer should I put down for this painting?',
      identity: { artist: 'andy-warhol', title: "Campbell's Soup" },
      value: { low: 1000, high: 5000, currency: 'USD' },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'answered');
    assert.match(json.answer, /offer/);
    assert.equal(json.source, 'model');
    assert.equal(visionCalls.length, 0);
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].message, 'What offer should I put down for this painting?');
    // A chat answer is a reply, not a fresh appraisal.
    assert.equal(json.value, undefined);
    assert.equal(json.identity, undefined);
  } finally {
    server.close();
    db.close();
  }
});

test('chat falls back to a grounded answer when no model key is configured', async () => {
  const db = seededDb();
  const app = createApp({ db, visionEnabled: () => false });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, json } = await postJson(base, '/chat', {
      message: 'What offer should I put down?',
      identity: { artist: 'andy-warhol', title: "Campbell's Soup" },
      value: { low: 1000, high: 5000, currency: 'USD' },
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'answered');
    assert.equal(json.source, 'grounded');
    assert.match(json.answer, /\$/);
  } finally {
    server.close();
    db.close();
  }
});
