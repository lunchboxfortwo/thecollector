// Artist momentum: a deterministic, capped score over precomputed signals.
// Pure functions only. The appraisal path never computes this from the network;
// it reads the latest snapshot stored by the resumable signals ingest.

export const MOMENTUM_WEIGHTS = { exhibition: 0.4, gallery: 0.25, press: 0.2, social: 0.15 };
export const MOMENTUM_TOTAL_WEIGHT =
  MOMENTUM_WEIGHTS.exhibition + MOMENTUM_WEIGHTS.gallery + MOMENTUM_WEIGHTS.press + MOMENTUM_WEIGHTS.social;

// Venue and outlet tiers: A is a blue-chip or museum-scale partner, C an
// emerging one. An unknown tier is treated conservatively.
export const TIER_WEIGHT = { A: 1.0, B: 0.7, C: 0.4 };
export const UNKNOWN_TIER_WEIGHT = 0.25;
export const DEFAULT_PRESS_TIER_WEIGHT = 0.5;

// Caps that keep one signal from swamping the score. Every sub-score is a
// bounded, non-decreasing function of the raw inputs, so it lands in 0..100 and
// can never be gamed past it.
export const SOLO_SHOW_WEIGHT = 1.0;
export const GROUP_SHOW_WEIGHT = 0.4;
export const EXHIBITION_CAP = 8; // weighted (solo + 0.4*group) shows in 36 months
export const GALLERY_BREADTH_CAP = 12; // distinct representing partners
export const PRESS_ARTICLE_CAP = 12; // articles in the trailing 24 months
export const PRESS_HISTORY_CAP = 40; // total articles
export const SOCIAL_FOLLOWERS_CAP = 1_000_000;
export const SOCIAL_DELTA_CAP = 5_000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function tierWeight(tier, fallback = UNKNOWN_TIER_WEIGHT) {
  const key = String(tier ?? '').trim().toUpperCase();
  return TIER_WEIGHT[key] ?? fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Exhibition: recent solo shows count full, group shows 0.4, scaled by the
// venue tier and capped.
export function exhibitionScore(signals = {}) {
  const solo = num(signals.solo_36mo);
  // `shows_36mo` is the total; any shows not accounted for as solo are group.
  const group = Math.max(num(signals.group_36mo), num(signals.shows_36mo) - solo);
  const points = SOLO_SHOW_WEIGHT * solo + GROUP_SHOW_WEIGHT * group;
  return 100 * clamp01((points * tierWeight(signals.best_gallery_tier)) / EXHIBITION_CAP);
}

// Gallery: the best representing partner tier, plus credit for breadth. A tier
// with no represented galleries still scores its tier at half weight.
export function galleryScore(signals = {}) {
  const tier = tierWeight(signals.best_gallery_tier);
  const breadth = clamp01(num(signals.gallery_count) / GALLERY_BREADTH_CAP);
  return 100 * clamp01(tier * (0.5 + 0.5 * breadth));
}

// Press: articles in the trailing 24 months weighted by outlet tier, with a
// smaller credit for the longer history.
export function pressScore(signals = {}) {
  const recent = num(signals.articles_24mo);
  const total = Math.max(num(signals.articles_total), recent);
  const breadth = clamp01(0.6 * (recent / PRESS_ARTICLE_CAP) + 0.4 * (total / PRESS_HISTORY_CAP));
  return 100 * clamp01(tierWeight(signals.press_tier, DEFAULT_PRESS_TIER_WEIGHT) * breadth);
}

// Social: capped log10 followers plus capped 90-day growth.
export function socialScore(signals = {}) {
  const follows = num(signals.follows);
  const delta = num(signals.followers_delta_90d);
  const base = clamp01(Math.log10(1 + follows) / Math.log10(1 + SOCIAL_FOLLOWERS_CAP));
  const growth = clamp01(delta / SOCIAL_DELTA_CAP);
  return 100 * clamp01(0.75 * base + 0.25 * growth);
}

// The weighted total. Deterministic and non-decreasing in every signal.
export function momentumScore(signals = {}) {
  const parts = {
    exhibition: exhibitionScore(signals),
    gallery: galleryScore(signals),
    press: pressScore(signals),
    social: socialScore(signals),
  };
  const weighted =
    (MOMENTUM_WEIGHTS.exhibition * parts.exhibition +
      MOMENTUM_WEIGHTS.gallery * parts.gallery +
      MOMENTUM_WEIGHTS.press * parts.press +
      MOMENTUM_WEIGHTS.social * parts.social) /
    MOMENTUM_TOTAL_WEIGHT;
  return {
    score: round2(clamp01(weighted / 100) * 100),
    parts: {
      exhibition: round2(parts.exhibition),
      gallery: round2(parts.gallery),
      press: round2(parts.press),
      social: round2(parts.social),
    },
  };
}
