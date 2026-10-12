import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, estimate, classifyMedium, normalizeTitle } from '../src/valuation.js';
import { positionWork, MIN_POSITION_SAMPLE } from '../src/positioning.js';

function makeSale({ artist, name = artist, title, price, area, medium, year, id }) {
  return {
    artist_slug: artist,
    artist_name: name,
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

// `count` stored works by one artist, with area and year ascending so the
// percentile order is unambiguous.
function sampleRows(count, { artist = 'artist-a', medium = 'print' } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      makeSale({
        artist,
        name: 'Artist A',
        title: `Work ${i}`,
        price: 1000 + i * 100,
        area: 100 + i * 100,
        medium,
        year: 1970 + i,
        id: i,
      }),
    );
  }
  return rows;
}

test('positioning is unavailable for an artist with no stored works', () => {
  const model = buildModel(sampleRows(12));
  const p = positionWork(model, {
    artist: 'a-stranger',
    medium: 'print',
    dimensions: '50 x 50 cm',
    year: '2000',
  });
  assert.equal(p.available, false);
  assert.equal(p.percentiles, null);
  assert.match(p.basis[0], /unavailable/i);
});

test('positioning is unavailable when the artist is not matched', () => {
  const model = buildModel(sampleRows(12));
  const p = positionWork(model, { medium: 'print', dimensions: '50 x 50 cm' });
  assert.equal(p.available, false);
  assert.equal(p.percentiles, null);
  assert.match(p.basis[0], /unavailable/i);
});

test('a percentile is shown only at or above the minimum sample', () => {
  const below = positionWork(buildModel(sampleRows(MIN_POSITION_SAMPLE - 1)), {
    artist: 'artist-a',
    medium: 'print',
    dimensions: '100 x 100 cm',
    year: '1990',
  });
  assert.equal(below.available, false);
  assert.equal(below.sampleSize, MIN_POSITION_SAMPLE - 1);
  assert.equal(below.percentiles, null);
  assert.match(below.basis[0], /minimum of 5/);

  const at = positionWork(buildModel(sampleRows(MIN_POSITION_SAMPLE)), {
    artist: 'artist-a',
    title: 'A New Work',
    medium: 'print',
    dimensions: '100 x 100 cm',
    year: '1990',
  });
  assert.equal(at.available, true);
  assert.equal(at.sampleSize, MIN_POSITION_SAMPLE);
  for (const key of ['medium', 'size', 'year', 'edition']) {
    assert.equal(typeof at.percentiles[key], 'number', `${key} should have a percentile`);
  }
});

test('the artist resolves through the case-folding lookup', () => {
  const model = buildModel(sampleRows(8));
  const upper = positionWork(model, { artist: 'ARTIST A', medium: 'print', dimensions: '100 x 100 cm' });
  const lower = positionWork(model, { artist: 'artist-a', medium: 'print', dimensions: '100 x 100 cm' });
  assert.equal(upper.available, true);
  assert.deepEqual(upper, lower);
});

test('positioning is deterministic', () => {
  const model = buildModel(sampleRows(12));
  const query = { artist: 'artist-a', medium: 'print', dimensions: '500 x 500 cm', year: '1978' };
  assert.deepEqual(positionWork(model, query), positionWork(model, query));
});

test('a larger work and a later work map to a percentile no lower', () => {
  const model = buildModel(sampleRows(12));
  const small = positionWork(model, { artist: 'artist-a', medium: 'print', area_cm2: 250 });
  const large = positionWork(model, { artist: 'artist-a', medium: 'print', area_cm2: 1000 });
  assert.ok(large.percentiles.size >= small.percentiles.size, `${large.percentiles.size} < ${small.percentiles.size}`);

  const early = positionWork(model, { artist: 'artist-a', year: '1972' });
  const late = positionWork(model, { artist: 'artist-a', year: '1981' });
  assert.ok(late.percentiles.year >= early.percentiles.year, `${late.percentiles.year} < ${early.percentiles.year}`);
});

test('a more common edition maps to a percentile no lower', () => {
  const rows = [];
  // Five recorded sales of the common edition, seven unique works.
  for (let i = 0; i < 5; i++) {
    rows.push(makeSale({ artist: 'artist-a', title: 'Common Piece', price: 2000, area: 400, medium: 'print', year: 1990, id: `c${i}` }));
  }
  for (let i = 0; i < 7; i++) {
    rows.push(makeSale({ artist: 'artist-a', title: `Solo ${i}`, price: 2000, area: 400, medium: 'print', year: 1990, id: `s${i}` }));
  }
  const model = buildModel(rows);
  const common = positionWork(model, { artist: 'artist-a', title: 'Common Piece', medium: 'print', dimensions: '20 x 20 cm' });
  const solo = positionWork(model, { artist: 'artist-a', title: 'Solo 3', medium: 'print', dimensions: '20 x 20 cm' });
  assert.equal(typeof common.percentiles.edition, 'number');
  assert.equal(typeof solo.percentiles.edition, 'number');
  assert.ok(common.percentiles.edition >= solo.percentiles.edition, `${common.percentiles.edition} < ${solo.percentiles.edition}`);
});

test('a thin key shows no percentile for that key but keeps the sample size', () => {
  // 6 works, but only 3 carry an image area: size must be null, year present.
  const rows = sampleRows(6).map((r, i) => (i < 3 ? { ...r, area_cm2: null, dimension_text: null } : r));
  const model = buildModel(rows);
  const p = positionWork(model, { artist: 'artist-a', medium: 'print', dimensions: '100 x 100 cm', year: '1975' });
  assert.equal(p.available, true);
  assert.equal(p.sampleSize, 6);
  assert.equal(p.percentiles.size, null);
  assert.equal(typeof p.percentiles.year, 'number');
});

test('positioning never changes the estimate output or the model', () => {
  const model = buildModel(sampleRows(40));
  const query = { artist: 'artist-a', medium: 'print', dimensions: '500 x 500 cm', year: '1990' };
  const before = estimate(model, query);
  const rowsSnapshot = JSON.stringify(model.rows);
  const p = positionWork(model, query);
  const after = estimate(model, query);
  assert.equal(p.available, true);
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(model.rows), rowsSnapshot);
});
