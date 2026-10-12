// An independent, piece-based notice assessment.
//
// The notice score is derived only from vision attributes of the work itself
// (composition, color/light, subject, originality against the artist's known
// motifs, condition). It never reads price, momentum or the artist's fame, so
// it can speak for a little-known artist with no auction record.
//
// The "potentially underpriced" flag is set only when the notice score is high
// AND the price/momentum signal is low (at or below the cohort median). It is
// an assistive signal, never an appraisal and never investment advice.
//
// A small human-curated rubric in `rubric.json` is the ground-truth yardstick;
// the score is measured against it and the agreement is reported. Where no
// ground truth exists, coverage is reported as "unavailable".

import { readFileSync } from 'node:fs';

// Piece-intrinsic attributes the notice score reads, with fixed weights that
// sum to 1. The weights are named here so the score is testable and stable.
export const ATTRIBUTE_KEYS = ['composition', 'colorLight', 'subject', 'originality', 'condition'];
export const ATTRIBUTE_WEIGHTS = {
  composition: 0.25,
  colorLight: 0.2,
  subject: 0.2,
  originality: 0.25,
  condition: 0.1,
};

// Named thresholds so boundaries are testable.
export const NOTICE_HIGH = 70;
export const NOTICE_MEDIUM = 45;
// A price/momentum signal is "low" at or below the cohort median (50th percentile).
export const PRICE_LOW_MAX = 50;
export const RUBRIC_NOTICE_LABELS = ['high', 'medium', 'low'];

const RUBRIC_URL = new URL('./rubric.json', import.meta.url);
let rubricCache = null;

// Number(null) and Number('') are 0, which would read as a real low signal.
// Treat missing inputs as absent, never as zero.
function toNumber(value) {
  if (value == null || value === '') return NaN;
  return Number(value);
}

function clamp100(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

// Accepts a raw attribute object from the vision model and returns a clean
// object with every key present as a number 0..100, or null when none of the
// attributes could be read.
export function normalizeAttributes(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let seen = 0;
  for (const key of ATTRIBUTE_KEYS) {
    const value = clamp100(raw[key]);
    if (value == null) continue;
    out[key] = value;
    seen += 1;
  }
  if (!seen) return null;
  // A missing attribute is treated conservatively as absent from the average,
  // so a partial reading is not silently rewarded.
  return out;
}

function weightedScore(attributes) {
  let sum = 0;
  let weight = 0;
  for (const key of ATTRIBUTE_KEYS) {
    if (!(key in attributes)) continue;
    sum += attributes[key] * ATTRIBUTE_WEIGHTS[key];
    weight += ATTRIBUTE_WEIGHTS[key];
  }
  if (weight === 0) return null;
  return sum / weight;
}

// The notice score: a weighted average (0..100) over the attributes present.
export function noticeScore(attributes) {
  const normalized = normalizeAttributes(attributes);
  if (!normalized) return null;
  return Math.round(weightedScore(normalized));
}

// high >= NOTICE_HIGH, medium >= NOTICE_MEDIUM, else low.
export function noticeBand(score) {
  const n = toNumber(score);
  if (!Number.isFinite(n)) return null;
  if (n >= NOTICE_HIGH) return 'high';
  if (n >= NOTICE_MEDIUM) return 'medium';
  return 'low';
}

// The flag fires only when notice is high AND the price/momentum signal is low.
// Either half missing means no flag.
export function underpricedFlag({ notice, priceSignal } = {}) {
  const n = toNumber(notice);
  const p = toNumber(priceSignal);
  const noticeHigh = Number.isFinite(n) && n >= NOTICE_HIGH;
  const priceLow = Number.isFinite(p) && p <= PRICE_LOW_MAX;
  const basis = [];

  if (Number.isFinite(n)) {
    basis.push(
      noticeHigh
        ? `Notice score ${Math.round(n)}/100 is high (at or above ${NOTICE_HIGH}).`
        : `Notice score ${Math.round(n)}/100 is not high enough (needs ${NOTICE_HIGH}); no underpriced flag.`,
    );
  } else {
    basis.push('Notice score unavailable; no underpriced flag.');
  }

  if (Number.isFinite(p)) {
    basis.push(
      priceLow
        ? `Price/momentum signal ${Math.round(p)}/100 is at or below the cohort median (${PRICE_LOW_MAX}).`
        : `Price/momentum signal ${Math.round(p)}/100 is above the cohort median (${PRICE_LOW_MAX}); no underpriced flag.`,
    );
  } else {
    basis.push('Price/momentum signal unavailable; no underpriced flag.');
  }

  const underpriced = noticeHigh && priceLow;
  if (underpriced) {
    basis.push(
      'Potentially underpriced: high notice with a low price/momentum signal. An assistive signal only, not an appraisal or investment advice.',
    );
  }
  return { underpriced, notice_high: noticeHigh, price_low: priceLow, basis };
}

// Percentile of one predicted price inside a cohort of recorded prices, 0..100.
// Null when the cohort is too small to be meaningful.
export function cohortPriceSignal(cohortPrices, predicted, { minCohort = 5 } = {}) {
  const prices = (Array.isArray(cohortPrices) ? cohortPrices : [])
    .map(Number)
    .filter((p) => Number.isFinite(p) && p > 0);
  const target = Number(predicted);
  if (prices.length < minCohort || !Number.isFinite(target) || target <= 0) return null;
  const atOrBelow = prices.filter((p) => p <= target).length;
  return Math.round((atOrBelow / prices.length) * 100);
}

export function loadRubric(url = RUBRIC_URL) {
  if (url === RUBRIC_URL && rubricCache) return rubricCache;
  const parsed = JSON.parse(readFileSync(url, 'utf8'));
  if (url === RUBRIC_URL) rubricCache = parsed;
  return parsed;
}

// Structural check for the curated rubric. Returns { ok, errors }.
export function validateRubric(rubric = loadRubric()) {
  const errors = [];
  if (rubric == null || typeof rubric !== 'object' || Array.isArray(rubric)) {
    return { ok: false, errors: ['rubric must be an object'] };
  }
  if (!Number.isInteger(rubric.version) || rubric.version < 1) errors.push('version must be a positive integer');
  if (!Array.isArray(rubric.entries) || rubric.entries.length === 0) {
    errors.push('entries must be a non-empty array');
  } else {
    rubric.entries.forEach((entry, index) => {
      const where = `entries[${index}]`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!entry.id) errors.push(`${where}.id is required`);
      if (!RUBRIC_NOTICE_LABELS.includes(entry.notice)) {
        errors.push(`${where}.notice must be one of ${RUBRIC_NOTICE_LABELS.join(', ')}`);
      }
      if (!normalizeAttributes(entry.attributes)) {
        errors.push(`${where}.attributes must carry at least one 0..100 attribute`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

// How well the notice score reproduces the human labels in the rubric, and how
// much of the rubric carries a usable ground-truth label.
export function rubricAgreement(rubric = loadRubric()) {
  const entries = Array.isArray(rubric?.entries) ? rubric.entries : [];
  let labeled = 0;
  let agree = 0;
  for (const entry of entries) {
    const normalized = normalizeAttributes(entry?.attributes);
    if (!normalized || !RUBRIC_NOTICE_LABELS.includes(entry?.notice)) continue;
    labeled += 1;
    if (noticeBand(noticeScore(normalized)) === entry.notice) agree += 1;
  }
  const coverage = entries.length === 0 || labeled === 0 ? null : labeled / entries.length;
  return {
    entries: entries.length,
    labeled,
    agree,
    agreement: labeled === 0 ? null : agree / labeled,
    coverage,
  };
}

// The additive assessment block returned with an appraisal. Null when there are
// no attributes to assess (vision disabled, no key, or no image) so today's
// behaviour is unchanged.
export function buildAssessment({ attributes, priceSignal = null, rubric = loadRubric() } = {}) {
  const normalized = normalizeAttributes(attributes);
  if (!normalized) return null;
  const score = noticeScore(normalized);
  const band = noticeBand(score);
  const flag = underpricedFlag({ notice: score, priceSignal });
  const agreement = rubricAgreement(rubric);
  const coverage = agreement.coverage == null ? 'unavailable' : agreement.coverage;
  return {
    notice_score: score,
    notice_band: band,
    attributes: normalized,
    underpriced: flag.underpriced,
    notice_high: flag.notice_high,
    price_low: flag.price_low,
    price_signal: Number.isFinite(toNumber(priceSignal)) ? Math.round(toNumber(priceSignal)) : null,
    coverage,
    agreement: agreement.agreement == null ? 'unavailable' : agreement.agreement,
    rubric: {
      version: rubric?.version ?? null,
      entries: agreement.entries,
      labeled: agreement.labeled,
      agreement: agreement.agreement == null ? 'unavailable' : agreement.agreement,
      coverage,
    },
    basis: flag.basis,
    advisory: 'Assistive signal only; not an appraisal and not investment advice.',
  };
}
