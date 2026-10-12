import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTE_KEYS,
  NOTICE_HIGH,
  PRICE_LOW_MAX,
  noticeScore,
  noticeBand,
  underpricedFlag,
  cohortPriceSignal,
  validateRubric,
  rubricAgreement,
  buildAssessment,
  loadRubric,
} from '../src/assessment.js';
import { identifyFromImage } from '../src/vision.js';
import { openDb, insertSales } from '../src/db.js';
import { createApp } from '../src/index.js';
import { classifyMedium, normalizeTitle } from '../src/valuation.js';

const HIGH_ATTRIBUTES = {
  composition: 84,
  colorLight: 80,
  subject: 78,
  originality: 86,
  condition: 82,
};

// ---------------------------------------------------------------------------
// 1. The notice score comes from the work's attributes, never from price.
// ---------------------------------------------------------------------------

test('noticeScore reads only the piece attributes, never price', () => {
  const base = { composition: 60, colorLight: 55, subject: 50, originality: 70, condition: 80 };
  const withPrice = { ...base, price: 999999, value: 1 };
  assert.equal(noticeScore(base), noticeScore(withPrice));
  // Changing a price-only field cannot move the score.
  assert.equal(noticeScore({ ...base, price: 1 }), noticeScore({ ...base, price: 1000000 }));
});

test('noticeScore is a weighted average over the attributes present', () => {
  const all = Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, 70]));
  assert.equal(noticeScore(all), 70);
  assert.equal(noticeBand(noticeScore(all)), 'high');
  // A missing attribute is dropped, not treated as zero.
  assert.equal(noticeScore({ composition: 80 }), 80);
});

test('noticeScore rises as the attributes rise and is null without attributes', () => {
  const weak = { composition: 30, colorLight: 30, subject: 30, originality: 30, condition: 30 };
  const strong = { composition: 90, colorLight: 90, subject: 90, originality: 90, condition: 90 };
  assert.ok(noticeScore(strong) > noticeScore(weak));
  assert.equal(noticeScore(null), null);
  assert.equal(noticeScore({}), null);
  assert.equal(noticeBand(null), null);
});

// ---------------------------------------------------------------------------
// 2 + 3. The flag fires only when notice is high AND price/momentum is low.
// ---------------------------------------------------------------------------

test('underpriced fires only when notice is high and the price signal is low', () => {
  assert.equal(underpricedFlag({ notice: 80, priceSignal: 30 }).underpriced, true);
  assert.equal(underpricedFlag({ notice: 80, priceSignal: 70 }).underpriced, false);
  assert.equal(underpricedFlag({ notice: 40, priceSignal: 30 }).underpriced, false);
  assert.equal(underpricedFlag({ notice: 40, priceSignal: 70 }).underpriced, false);
});

test('the flag boundaries are inclusive at the high and median thresholds', () => {
  assert.equal(underpricedFlag({ notice: NOTICE_HIGH, priceSignal: PRICE_LOW_MAX }).underpriced, true);
  assert.equal(underpricedFlag({ notice: NOTICE_HIGH - 1, priceSignal: PRICE_LOW_MAX }).underpriced, false);
  assert.equal(underpricedFlag({ notice: NOTICE_HIGH, priceSignal: PRICE_LOW_MAX + 1 }).underpriced, false);
});

test('a missing half of the flag never fires and is stated honestly', () => {
  const noPrice = underpricedFlag({ notice: 90, priceSignal: null });
  assert.equal(noPrice.underpriced, false);
  assert.equal(noPrice.notice_high, true);
  assert.ok(noPrice.basis.some((line) => line.includes('unavailable')));

  const noNotice = underpricedFlag({ notice: null, priceSignal: 10 });
  assert.equal(noNotice.underpriced, false);
  assert.equal(noNotice.price_low, true);

  assert.equal(underpricedFlag({}).underpriced, false);
  assert.equal(underpricedFlag().underpriced, false);
});

// ---------------------------------------------------------------------------
// 4. Coverage is "unavailable" where there is no ground truth.
// ---------------------------------------------------------------------------

test('coverage is unavailable when the rubric has no ground truth', () => {
  const empty = { version: 1, entries: [] };
  assert.equal(rubricAgreement(empty).coverage, null);
  const assessment = buildAssessment({ attributes: HIGH_ATTRIBUTES, priceSignal: 20, rubric: empty });
  assert.equal(assessment.coverage, 'unavailable');
  assert.equal(assessment.agreement, 'unavailable');
  assert.equal(assessment.rubric.coverage, 'unavailable');
});

// ---------------------------------------------------------------------------
// 5. The human rubric is validated and the score is measured against it.
// ---------------------------------------------------------------------------

test('the shipped rubric validates and is a non-trivial human yardstick', () => {
  const rubric = loadRubric();
  const { ok, errors } = validateRubric(rubric);
  assert.ok(ok, `rubric errors: ${errors.join('; ')}`);
  assert.ok(rubric.entries.length >= 12, `expected a small curated rubric, got ${rubric.entries.length}`);
  assert.ok(rubric.limitations, 'the rubric documents its limitation');
  for (const entry of rubric.entries) {
    assert.ok(entry.provenance, `${entry.id} cites its provenance`);
    assert.ok(['high', 'medium', 'low'].includes(entry.notice));
  }
});

test('rubricAgreement measures the score against the human labels', () => {
  const agree = {
    version: 1,
    entries: [
      { id: 'A', notice: 'high', attributes: { ...HIGH_ATTRIBUTES } },
      { id: 'B', notice: 'low', attributes: { composition: 20, colorLight: 20, subject: 20, originality: 20, condition: 20 } },
    ],
  };
  const perfect = rubricAgreement(agree);
  assert.equal(perfect.agreement, 1);
  assert.equal(perfect.coverage, 1);

  const disagree = {
    version: 1,
    entries: [agree.entries[0], { ...agree.entries[1], notice: 'high' }],
  };
  const mixed = rubricAgreement(disagree);
  assert.equal(mixed.agreement, 0.5);
  assert.equal(mixed.coverage, 1);

  // The shipped rubric is measured, not assumed: coverage is full and the
  // agreement is a real fraction below the ceiling.
  const shipped = rubricAgreement(loadRubric());
  assert.equal(shipped.coverage, 1);
  assert.ok(shipped.agreement > 0.5 && shipped.agreement <= 1, `agreement ${shipped.agreement}`);
});

test('validateRubric rejects a malformed rubric', () => {
  assert.equal(validateRubric({}).ok, false);
  assert.equal(validateRubric({ version: 1, entries: [] }).ok, false);
  assert.equal(
    validateRubric({ version: 1, entries: [{ id: 'X', notice: 'amazing', attributes: { composition: 50 } }] }).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// Cohort price signal: low means at or below the median.
// ---------------------------------------------------------------------------

test('cohortPriceSignal places the estimate in the cohort and guards small samples', () => {
  const cohort = [100, 200, 300, 400, 500];
  assert.ok(cohortPriceSignal(cohort, 100) <= PRICE_LOW_MAX);
  assert.ok(cohortPriceSignal(cohort, 500) > PRICE_LOW_MAX);
  assert.equal(cohortPriceSignal(cohort, 100, { minCohort: 6 }), null);
  assert.equal(cohortPriceSignal([], 100), null);
});

// ---------------------------------------------------------------------------
// buildAssessment assembles the additive block.
// ---------------------------------------------------------------------------

test('buildAssessment carries the notice, the attributes and the advisory wording', () => {
  const assessment = buildAssessment({ attributes: HIGH_ATTRIBUTES, priceSignal: 20 });
  assert.equal(assessment.notice_band, 'high');
  assert.ok(assessment.notice_score >= NOTICE_HIGH);
  assert.equal(assessment.underpriced, true);
  assert.equal(assessment.price_signal, 20);
  assert.deepEqual(assessment.attributes, HIGH_ATTRIBUTES);
  assert.match(assessment.advisory, /not an appraisal/i);
  assert.ok(assessment.basis.some((line) => /not an appraisal/i.test(line)));
});

test('buildAssessment is null without attributes so today behaves unchanged', () => {
  assert.equal(buildAssessment({ attributes: null }), null);
  assert.equal(buildAssessment({}), null);
});

// ---------------------------------------------------------------------------
// Vision schema: attributes are parsed alongside identity in the same call.
// ---------------------------------------------------------------------------

function withEnv(values, fn) {
  const saved = {};
  const managed = ['OPENROUTER_API_KEY', 'VISION_API_KEY', 'VISION_API_URL', 'VISION_MODEL'];
  for (const key of managed) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of managed) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('identifyFromImage returns normalized piece attributes with the identity', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              artist: 'Little Known',
              title: 'Study',
              confidence: 0.7,
              attributes: { composition: 88, colorLight: 120, subject: 70, originality: 65, condition: 60, bogus: 5 },
              assessment_note: 'Strong, balanced composition.',
            }),
          },
        },
      ],
    }),
  });
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: 'test-key', VISION_API_URL: 'http://vision.test/chat' }, () =>
      identifyFromImage({ imageBase64: 'AAAA', mimeType: 'image/jpeg' }),
    );
    assert.equal(result.identified, true);
    assert.equal(result.artist, 'Little Known');
    // Out-of-range values are clamped and unknown keys are dropped.
    assert.equal(result.attributes.colorLight, 100);
    assert.equal(result.attributes.bogus, undefined);
    assert.equal(result.assessment_note, 'Strong, balanced composition.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a work whose artist cannot be named is still assessed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              artist: null,
              confidence: 0.2,
              attributes: { composition: 75, colorLight: 72, subject: 78, originality: 80, condition: 70 },
            }),
          },
        },
      ],
    }),
  });
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: 'test-key' }, () =>
      identifyFromImage({ imageBase64: 'AAAA' }),
    );
    assert.equal(result.identified, true);
    assert.equal(result.artist, null);
    assert.ok(result.attributes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// /appraise integration: additive field, value untouched, no source named.
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

const VISION_WITH_ATTRIBUTES = async () => ({
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
});

async function pricedApp() {
  const db = seededDb();
  const app = createApp({ db, vision: VISION_WITH_ATTRIBUTES, visionEnabled: () => true });
  const server = await startApp(app);
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('/appraise adds an additive assessment and never alters the value', async () => {
  const db = seededDb();
  const withAssessment = createApp({ db, vision: VISION_WITH_ATTRIBUTES, visionEnabled: () => true });
  const s1 = await startApp(withAssessment);
  const b1 = `http://127.0.0.1:${s1.address().port}`;
  const withoutVision = createApp({ db, visionEnabled: () => false });
  const s2 = await startApp(withoutVision);
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const body = {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
      hints: { size: '100 x 100 cm', medium: 'print' },
    };
    const { json } = await postJson(b1, '/appraise', body);
    assert.equal(json.status, 'priced');
    assert.ok(json.assessment, 'expected an assessment block');
    assert.ok(json.assessment.notice_score >= NOTICE_HIGH);
    assert.equal(json.assessment.notice_band, 'high');
    assert.equal(typeof json.assessment.underpriced, 'boolean');
    assert.ok(json.assessment.advisory);
    // The value is still the plain range from the estimator.
    assert.equal(typeof json.value.low, 'number');
    assert.equal(typeof json.value.high, 'number');
    assert.deepEqual(json.sources, []);
    assert.ok(!/artsy/i.test(JSON.stringify(json)), 'no record source is named');

    // Without vision there is no assessment field: today's reply is unchanged.
    const plain = await postJson(b2, '/appraise', {
      hints: { artist: 'andy-warhol', title: "Campbell's Soup", size: '100 x 100 cm', medium: 'print', year: '1968' },
    });
    assert.equal(plain.json.status, 'priced');
    assert.equal(plain.json.assessment, undefined);
  } finally {
    s1.close();
    s2.close();
    db.close();
  }
});

test('the underpriced flag in a priced reply needs high notice and a low signal', async () => {
  const { server, base } = await pricedApp();
  try {
    const { json } = await postJson(base, '/appraise', {
      imageBase64: 'AAAA',
      mimeType: 'image/jpeg',
      hints: { size: '100 x 100 cm', medium: 'print' },
    });
    assert.equal(json.status, 'priced');
    const a = json.assessment;
    // The flag agrees with its two halves, whatever the computed signal is.
    assert.equal(a.underpriced, a.notice_high && a.price_low);
    assert.ok(json.confidence.basis.some((line) => line.includes('Notice score')));
  } finally {
    server.close();
  }
});

test('an unnamed work with attributes asks for details but still shows the notice signal', async () => {
  const db = seededDb();
  const app = createApp({
    db,
    visionEnabled: () => true,
    vision: async () => ({
      identified: true,
      method: 'vision',
      artist: null,
      attributes: { composition: 84, colorLight: 80, subject: 78, originality: 86, condition: 82 },
    }),
  });
  const server = await startApp(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { json } = await postJson(base, '/appraise', { imageBase64: 'AAAA', mimeType: 'image/jpeg' });
    assert.equal(json.status, 'needs_details');
    assert.equal(json.value, null);
    assert.ok(json.assessment);
    assert.equal(json.assessment.underpriced, false, 'no price signal means no underpriced flag');
    assert.ok(json.assessment.notice_score >= NOTICE_HIGH);
  } finally {
    server.close();
    db.close();
  }
});
