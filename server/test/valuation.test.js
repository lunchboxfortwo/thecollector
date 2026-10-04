import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DB_PATH, allSales, openDb } from '../src/db.js';
import {
  buildModel,
  estimate,
  classifyMedium,
  isGenericTitle,
  normalizeTitle,
  parseAreaCm2,
  parseYear,
} from '../src/valuation.js';

// ---------------------------------------------------------------------------
// synthetic sample (deterministic) so tests never depend on the ingested DB
// ---------------------------------------------------------------------------

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

function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function syntheticSales(n = 400) {
  const rand = lcg(42);
  const artists = [
    { slug: 'artist-a', base: 5000 },
    { slug: 'artist-b', base: 15000 },
    { slug: 'artist-c', base: 1200 },
  ];
  const media = ['oil on canvas', 'lithograph print', 'gelatin silver photograph', 'ink on paper'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = artists[Math.floor(rand() * artists.length)];
    const medium = media[Math.floor(rand() * media.length)];
    const area = 200 + rand() * 8000;
    const year = 1920 + Math.floor(rand() * 80);
    const title = i % 7 === 0 ? 'Campbell\'s Soup' : `Work ${i}`;
    const price = a.base * Math.pow(area / 2000, 0.5) * (0.6 + rand() * 0.9);
    rows.push(makeSale({ artist: a.slug, title, price, area, medium, year, id: i }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test('parseAreaCm2 reads cm and ignores trailing inches', () => {
  const area = parseAreaCm2('103.2 x 78.9 cm (40 5/8 x 31 1/8 in.)');
  assert.ok(Math.abs(area - 103.2 * 78.9) < 0.5, `got ${area}`);
});

test('parseAreaCm2 converts inches-only strings', () => {
  const area = parseAreaCm2('20 x 16 in.');
  assert.ok(Math.abs(area - 20 * 16 * 2.54 * 2.54) < 1, `got ${area}`);
});

test('parseAreaCm2 returns null when no size present', () => {
  assert.equal(parseAreaCm2('dimensions on request'), null);
});

test('parseYear takes the first four-digit year', () => {
  assert.equal(parseYear('1986-1987'), 1986);
  assert.equal(parseYear('c. 1910'), 1910);
  assert.equal(parseYear(null), null);
});

test('classifyMedium buckets common media', () => {
  assert.equal(classifyMedium('synthetic polymer print and silkscreen ink on canvas'), 'print');
  assert.equal(classifyMedium('gelatin silver print'), 'print');
  assert.equal(classifyMedium('oil on canvas'), 'painting');
  assert.equal(classifyMedium('ink, gold leaf and foil on paper'), 'work_on_paper');
  assert.equal(classifyMedium('bronze'), 'sculpture');
  assert.equal(classifyMedium(''), 'other');
});

test('normalizeTitle / isGenericTitle', () => {
  assert.equal(normalizeTitle("Campbell's Soup I"), 'campbell s soup i');
  assert.equal(isGenericTitle(normalizeTitle('Untitled (Blue)')), true);
  assert.equal(isGenericTitle(normalizeTitle('Campbell\'s Soup')), false);
});

// ---------------------------------------------------------------------------
// estimator
// ---------------------------------------------------------------------------

test('edition match wins when two or more sales share artist + title', () => {
  const sales = syntheticSales(200);
  const model = buildModel(sales);
  const result = estimate(model, {
    artist: 'artist-a',
    title: 'Campbell\'s Soup',
    dimensions: '100 x 100 cm',
    medium: 'print',
    year: '1965',
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'edition');
  assert.ok(result.comps.length >= 2);
});

test('hedonic fallback for a title with no edition match', () => {
  const model = buildModel(syntheticSales(400));
  const result = estimate(model, {
    artist: 'artist-a',
    title: 'A Unique Painting',
    dimensions: '120 x 90 cm',
    medium: 'oil on canvas',
    year: '1950',
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'hedonic');
  assert.ok(result.low > 0 && result.high > result.low);
});

test('band multipliers are monotonic across coverage levels', () => {
  const model = buildModel(syntheticSales(400));
  assert.ok(model.band[0.5] <= model.band[0.8]);
  assert.ok(model.band[0.8] <= model.band[0.9]);
});

test('refusal when there are no comps and no model', () => {
  const model = buildModel([]);
  const result = estimate(model, { artist: 'Nobody', title: 'Nothing' });
  assert.equal(result.ok, false);
});

test('unknown artist still prices through the pooled hedonic model', () => {
  const model = buildModel(syntheticSales(400));
  const result = estimate(model, {
    artist: 'Unmatched Name',
    title: 'Unknown Work',
    dimensions: '50 x 40 cm',
    medium: 'print',
  });
  assert.equal(result.ok, true);
  assert.equal(result.query.artist_slug, null);
});

test('artist matching folds diacritics and unknown artists pool', () => {
  const rows = syntheticSales(160).map((r) =>
    r.artist_slug === 'artist-a' ? { ...r, artist_slug: 'joan-miro', artist_name: 'Joan Miró' } : r,
  );
  const model = buildModel(rows);
  const matched = estimate(model, { artist: 'Joan Miro', title: 'Unique X', dimensions: '50 x 50 cm', medium: 'painting' });
  assert.equal(matched.ok, true);
  assert.equal(matched.query.artist_slug, 'joan-miro');
  const unknown = estimate(model, { artist: 'Nobody At All', title: 'Unique Y', dimensions: '50 x 50 cm', medium: 'painting' });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.query.artist_slug, null);
  assert.ok(unknown.low > 0 && unknown.high > unknown.low);
});

// ---------------------------------------------------------------------------
// empirical coverage (the headline number the checklist asks to print)
// ---------------------------------------------------------------------------

test('prints empirical coverage at 50/80/90 on the synthetic sample', () => {
  const model = buildModel(syntheticSales(400));
  assert.ok(model.coverage, 'coverage should be computed');
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(
    `[coverage synthetic] 50%=${pct(model.coverage[0.5])} 80%=${pct(model.coverage[0.8])} 90%=${pct(model.coverage[0.9])}`,
  );
  assert.ok(model.coverage[0.5] <= model.coverage[0.8]);
  assert.ok(model.coverage[0.8] <= model.coverage[0.9]);
});

test('prints empirical coverage on the ingested DB when present', (t) => {
  if (!fs.existsSync(DB_PATH)) {
    t.skip(`no ingested DB at ${DB_PATH}`);
    return;
  }
  const db = openDb(DB_PATH);
  const model = buildModel(allSales(db));
  db.close();
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  if (!model.coverage) {
    t.skip('not enough rows to hold out a calibration/eval split');
    return;
  }
  console.log(
    `[coverage ingested n=${model.count}] 50%=${pct(model.coverage[0.5])} 80%=${pct(model.coverage[0.8])} 90%=${pct(model.coverage[0.9])}`,
  );
  assert.ok(model.coverage[0.5] <= model.coverage[0.8]);
  assert.ok(model.coverage[0.8] <= model.coverage[0.9]);
});
