import test from 'node:test';
import assert from 'node:assert/strict';
import { momentumScore } from '../src/signals.js';
import {
  buildModel,
  estimate,
  momentumMultiplier,
  classifyMedium,
  normalizeTitle,
} from '../src/valuation.js';

// ---------------------------------------------------------------------------
// momentum scoring (acceptance criterion 6: deterministic and monotonic)
// ---------------------------------------------------------------------------

const BASE_SIGNALS = {
  follows: 5000,
  followers_delta_90d: 200,
  shows_total: 10,
  shows_36mo: 8,
  solo_36mo: 4,
  group_36mo: 4,
  gallery_count: 5,
  best_gallery_tier: 'B',
  articles_total: 20,
  articles_24mo: 10,
  press_tier: 'B',
};

// Which sub-score each numeric signal feeds, so monotonicity is checked on the
// part that consumes it, not just the total.
const NUMERIC_SIGNALS = {
  follows: 'social',
  followers_delta_90d: 'social',
  shows_total: 'exhibition',
  shows_36mo: 'exhibition',
  solo_36mo: 'exhibition',
  group_36mo: 'exhibition',
  gallery_count: 'gallery',
  articles_total: 'press',
  articles_24mo: 'press',
};

test('momentum scoring is deterministic', () => {
  assert.deepEqual(momentumScore(BASE_SIGNALS), momentumScore({ ...BASE_SIGNALS }));
  assert.deepEqual(momentumScore(BASE_SIGNALS), momentumScore(JSON.parse(JSON.stringify(BASE_SIGNALS))));
});

test('momentum is monotonic in every numeric signal', () => {
  const lo = momentumScore(BASE_SIGNALS);
  for (const [field, part] of Object.entries(NUMERIC_SIGNALS)) {
    const hi = momentumScore({ ...BASE_SIGNALS, [field]: BASE_SIGNALS[field] * 2 });
    assert.ok(hi.score >= lo.score, `${field}: score ${hi.score} should not drop below ${lo.score}`);
    assert.ok(
      hi.parts[part] >= lo.parts[part],
      `${field}: ${part} ${hi.parts[part]} should not drop below ${lo.parts[part]}`,
    );
  }
});

test('momentum is monotonic in venue and outlet tiers', () => {
  const b = momentumScore(BASE_SIGNALS).score;
  const a = momentumScore({ ...BASE_SIGNALS, best_gallery_tier: 'A' }).score;
  const c = momentumScore({ ...BASE_SIGNALS, best_gallery_tier: 'C' }).score;
  assert.ok(a >= b && b >= c, `venue tiers should order A >= B >= C (${a}/${b}/${c})`);

  const pa = momentumScore({ ...BASE_SIGNALS, press_tier: 'A' }).score;
  const pb = momentumScore({ ...BASE_SIGNALS, press_tier: 'B' }).score;
  const pc = momentumScore({ ...BASE_SIGNALS, press_tier: 'C' }).score;
  assert.ok(pa >= pb && pb >= pc, `press tiers should order A >= B >= C (${pa}/${pb}/${pc})`);
});

test('sub-scores stay capped even for absurd, gameable inputs', () => {
  const gamed = momentumScore({
    follows: 1e15,
    followers_delta_90d: 1e12,
    shows_total: 1e6,
    shows_36mo: 1e6,
    solo_36mo: 1e6,
    group_36mo: 1e6,
    gallery_count: 1e6,
    best_gallery_tier: 'A',
    articles_total: 1e6,
    articles_24mo: 1e6,
    press_tier: 'A',
  });
  assert.ok(gamed.score >= 0 && gamed.score <= 100, `score ${gamed.score}`);
  for (const [name, value] of Object.entries(gamed.parts)) {
    assert.ok(value >= 0 && value <= 100, `${name} ${value} should be capped to 0..100`);
  }
});

// ---------------------------------------------------------------------------
// momentum pricing (acceptance criterion 1: zero-auction artist is priced)
// ---------------------------------------------------------------------------

function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

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

// A fitted hedonic model from three artists; the query artist below is not one
// of them, so it has no auction record at all.
function fittedModel(n = 400) {
  const rand = lcg(7);
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
    const price = a.base * Math.pow(area / 2000, 0.5) * (0.6 + rand() * 0.9);
    rows.push(makeSale({ artist: a.slug, title: `Work ${i}`, price, area, medium, year, id: i }));
  }
  return buildModel(rows);
}

const EMERGING_QUERY = {
  artist: 'emerging-one',
  title: 'New Work',
  medium: 'oil on canvas',
  dimensions: '100 x 100 cm',
  year: '2015',
};

const WEAK_SIGNALS = {
  follows: 0,
  followers_delta_90d: 0,
  shows_total: 0,
  shows_36mo: 0,
  solo_36mo: 0,
  group_36mo: 0,
  gallery_count: 0,
  best_gallery_tier: 'C',
  articles_total: 0,
  articles_24mo: 0,
  press_tier: 'C',
};

const STRONG_SIGNALS = {
  follows: 800_000,
  followers_delta_90d: 5_000,
  shows_total: 20,
  shows_36mo: 20,
  solo_36mo: 12,
  group_36mo: 8,
  gallery_count: 12,
  best_gallery_tier: 'A',
  articles_total: 40,
  articles_24mo: 12,
  press_tier: 'A',
};

test('an artist with zero auction results is priced from momentum, not refused', () => {
  const model = fittedModel();
  const est = estimate(model, EMERGING_QUERY, { signals: BASE_SIGNALS });
  assert.equal(est.ok, true);
  assert.equal(est.method, 'momentum');
  assert.equal(est.query.artist_slug, null);
  assert.equal(est.coverage, null);
  assert.ok(est.predicted > 0 && est.high > est.low);
  // The displayed range honors the same ±10% promise as the comps path.
  assert.ok(est.low >= est.predicted * 0.9 - 1e-9, `low ${est.low} vs ${est.predicted}`);
  assert.ok(est.high <= est.predicted * 1.1 * (1 + 1e-12), `high ${est.high} vs ${est.predicted}`);
  assert.equal(est.comps.length, 0);
});

test('a higher momentum score raises the central value', () => {
  const model = fittedModel();
  const weak = estimate(model, EMERGING_QUERY, { signals: WEAK_SIGNALS });
  const strong = estimate(model, EMERGING_QUERY, { signals: STRONG_SIGNALS });
  assert.ok(momentumScore(STRONG_SIGNALS).score > momentumScore(WEAK_SIGNALS).score);
  assert.ok(strong.predicted > weak.predicted, `${strong.predicted} should exceed ${weak.predicted}`);
  assert.ok(strong.momentumMultiplier > weak.momentumMultiplier);
});

test('an artist with auction comps keeps the auction path even with signals', () => {
  const model = fittedModel();
  const est = estimate(model, { ...EMERGING_QUERY, artist: 'artist-a' }, { signals: BASE_SIGNALS });
  assert.notEqual(est.method, 'momentum');
});

test('an unknown artist without signals keeps the pooled hedonic path', () => {
  const model = fittedModel();
  const est = estimate(model, EMERGING_QUERY);
  assert.equal(est.ok, true);
  assert.equal(est.method, 'hedonic');
});

test('momentum without a hedonic base is refused, never invented', () => {
  const empty = buildModel([]);
  const est = estimate(empty, EMERGING_QUERY, { signals: BASE_SIGNALS });
  assert.equal(est.ok, false);
});

test('momentum multiplier is neutral at 50 and clamped', () => {
  assert.equal(momentumMultiplier(50), 1);
  assert.ok(momentumMultiplier(100) > 1);
  assert.ok(momentumMultiplier(0) < 1);
  assert.ok(momentumMultiplier(1000) <= 2.0);
  assert.ok(momentumMultiplier(-1000) >= 0.5);
});
