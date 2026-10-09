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
  MEDIUM_BASELINE,
  MEDIUM_CLASSES,
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
    const isSoup = i % 7 === 0;
    const title = isSoup ? 'Campbell\'s Soup' : `Work ${i}`;
    const price = a.base * Math.pow(area / 2000, 0.5) * (0.6 + rand() * 0.9);
    rows.push(makeSale({ artist: a.slug, title, price, area, medium: isSoup ? 'lithograph print' : medium, year, id: i }));
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
    medium: 'lithograph print',
    year: '1965',
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'edition');
  assert.ok(result.comps.length >= 2);
});

// ---------------------------------------------------------------------------
// comp binding: a painting must never price from same-title prints
// ---------------------------------------------------------------------------

// One artist with a real market of million-dollar paintings plus a same-title
// edition of cheap prints, the shape of the reported bug.
function painterWithCheapPrintEdition() {
  const rows = [];
  let id = 0;
  for (let i = 0; i < 160; i++) {
    const area = 6000 + (i % 20) * 400;
    const price = 900_000 * (1 + (i % 25) / 8);
    rows.push(
      makeSale({
        artist: 'painter',
        title: `Canvas ${i}`,
        price,
        area,
        medium: 'acrylic on canvas',
        year: 2000 + (i % 20),
        id: id++,
      }),
    );
  }
  for (let i = 0; i < 16; i++) {
    rows.push(
      makeSale({
        artist: 'painter',
        title: 'Miss Spring',
        price: 3500 + i * 400,
        area: 640,
        medium: 'digital pigment print',
        year: 2012,
        id: id++,
      }),
    );
  }
  for (const artist of ['other-a', 'other-b', 'other-c']) {
    for (let i = 0; i < 120; i++) {
      rows.push(
        makeSale({
          artist,
          title: `Work ${i}`,
          price: 4000 + (i % 30) * 1500,
          area: 1500 + (i % 15) * 200,
          medium: i % 3 === 0 ? 'acrylic on canvas' : 'lithograph print',
          year: 1970 + (i % 30),
          id: id++,
        }),
      );
    }
  }
  return rows;
}

test('a painting does not bind to cheap same-title prints', () => {
  const model = buildModel(painterWithCheapPrintEdition());
  const result = estimate(model, {
    artist: 'painter',
    title: 'Miss Spring',
    dimensions: '120 x 100 cm',
    medium: 'acrylic on canvas',
    year: '2012',
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.method, 'edition');
  // Never the $8,000-$20,000 print range: the painting market is near $1M-$4M.
  assert.ok(result.low > 200_000, `low ${result.low} should clear the print range`);
  assert.ok(result.high <= 12_000_000, `high ${result.high} should stay near the painting comps`);
  assert.ok(result.low <= 4_000_000 && result.high >= 1_000_000, `range ${result.low}-${result.high} should sit in the million-dollar comp set`);
});

test('a print edition still matches same-title, same-medium comps tightly', () => {
  const model = buildModel(painterWithCheapPrintEdition());
  const result = estimate(model, {
    artist: 'painter',
    title: 'Miss Spring',
    medium: 'digital pigment print',
    year: '2012',
  });
  assert.equal(result.method, 'edition');
  assert.ok(result.low < result.high);
  // The range stays inside the print edition and is materially tighter than the
  // x4.3 residual band.
  assert.ok(result.band < 4.3, `band ${result.band}`);
  assert.ok(result.low >= 2000 && result.high <= 12_000, `print range ${result.low}-${result.high}`);
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
// equivalence with the previous dense dummy-variable fit
// ---------------------------------------------------------------------------

// Independent oracle: the dense design the fixed-effects rewrite replaced, where
// every artist is its own column. A wrong transform would move these prices.
function denseDot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function denseMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function denseSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function denseFit(sales) {
  const rows = sales.map((r) => ({ ...r, logPrice: Math.log10(r.price_cents / 100) }));
  const areas = rows.map((r) => r.area_cm2).filter((v) => Number.isFinite(v) && v > 0);
  const years = rows.map((r) => r.creation_year).filter((v) => Number.isFinite(v) && v > 1500 && v < 2100);
  const defaultLogArea = areas.length ? Math.log10(denseMedian(areas)) : Math.log10(1000);
  const defaultYear = years.length ? denseMedian(years) : 1980;
  const artists = [...new Set(rows.map((r) => r.artist_slug))].sort();
  const artistBaseline = artists[0] ?? null;
  const featureRow = (r) => {
    const logArea = Number.isFinite(r.area_cm2) && r.area_cm2 > 0 ? Math.log10(r.area_cm2) : defaultLogArea;
    const year = Number.isFinite(r.creation_year) && r.creation_year > 1500 && r.creation_year < 2100 ? r.creation_year : defaultYear;
    const feats = [1];
    for (const a of artists) if (a !== artistBaseline) feats.push(a === r.artist_slug ? 1 : 0);
    feats.push(logArea);
    feats.push((year - 1900) / 100);
    for (const cls of MEDIUM_CLASSES) if (cls !== MEDIUM_BASELINE) feats.push(r.medium_class === cls ? 1 : 0);
    return feats;
  };
  const X = rows.map(featureRow);
  const y = rows.map((r) => r.logPrice);
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  return { beta: denseSolve(XtX, Xty), artists, featureRow };
}

test('fixed-effects fit reproduces the dense dummy-variable prices', () => {
  // Unique titles so only the hedonic path is exercised, and all six medium
  // classes present (as in the ingested table) so both designs are full rank.
  const media = ['oil on canvas', 'lithograph print', 'gelatin silver photograph', 'ink on paper', 'bronze', 'mixed media'];
  const sales = syntheticSales(400).map((r, i) => {
    const title = `Unique Work ${i}`;
    const medium_text = media[i % media.length];
    return { ...r, title, title_norm: normalizeTitle(title), medium_text, medium_class: classifyMedium(medium_text) };
  });
  const model = buildModel(sales);
  const dense = denseFit(sales);
  assert.ok(model.beta && dense.beta, 'both fits should solve');

  const queries = [
    { artist: 'artist-a', title: 'Query One', area_cm2: 500, medium_class: 'painting', creation_year: 1950 },
    { artist: 'artist-b', title: 'Query Two', area_cm2: 3000, medium_class: 'print', creation_year: 1930 },
    { artist: 'artist-c', title: 'Query Three', area_cm2: 800, medium_class: 'work_on_paper', creation_year: 1970 },
  ];
  for (const query of queries) {
    const got = estimate(model, query);
    assert.equal(got.method, 'hedonic');
    const want = denseDot(dense.featureRow(got.query), dense.beta);
    const gotLog10 = Math.log10(got.predicted);
    assert.ok(
      Math.abs(gotLog10 - want) < 1e-6,
      `${query.artist}: fixed effects ${gotLog10} vs dense ${want}`,
    );
  }

  // Unknown artist pools equally over every known artist intercept.
  const unknown = estimate(model, {
    artist: 'Nobody At All',
    title: 'Query Four',
    area_cm2: 1200,
    medium_class: 'sculpture',
    creation_year: 1960,
  });
  assert.equal(unknown.query.artist_slug, null);
  const pooled =
    dense.artists.reduce((sum, artist) => sum + denseDot(dense.featureRow({ ...unknown.query, artist_slug: artist }), dense.beta), 0) /
    dense.artists.length;
  assert.ok(
    Math.abs(Math.log10(unknown.predicted) - pooled) < 1e-6,
    `pooled: fixed effects ${Math.log10(unknown.predicted)} vs dense ${pooled}`,
  );
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
