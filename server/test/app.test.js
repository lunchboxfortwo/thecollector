import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertSales } from '../src/db.js';
import { createApp } from '../src/index.js';
import { classifyMedium, normalizeTitle } from '../src/valuation.js';

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
