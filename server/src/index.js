import { pathToFileURL } from 'node:url';
import express from 'express';
import { openDb, allSales, salesCount, getArtistSignals } from './db.js';
import {
  buildModel,
  estimate,
  roundNice,
  MAX_BAND_FRACTION,
  RECENCY_HALF_LIFE_YEARS,
} from './valuation.js';
import { identifyFromImage, visionConfigured } from './vision.js';
import { buildAssessment, cohortPriceSignal } from './assessment.js';
import { answerQuestion, groundedAnswer } from './chat.js';
import { positionWork } from './positioning.js';

const HINT_FIELDS = ['artist', 'title', 'year', 'country', 'size', 'medium'];
// The five extra fields the app prompts for when it cannot identify a piece.
const MISSING_FIELDS = ['artist', 'year', 'country', 'size', 'medium'];

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function optionalString(value, field) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
  return { ok: true, value };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Two-significant-figure rounding inward, so a display value never crosses a
// bound it is clamped to.
function niceDown(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.max(1, Math.floor(value / magnitude) * magnitude);
}

function niceUp(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.max(1, Math.ceil(value / magnitude) * magnitude);
}

function identityFromHints(hints) {
  return {
    artist: hints.artist ?? null,
    title: hints.title ?? null,
    medium: hints.medium ?? null,
    dimensions: hints.size ?? null,
    year: hints.year ?? null,
    country: hints.country ?? null,
  };
}

function identityFromVision(v) {
  return {
    artist: v.artist ?? null,
    title: v.title ?? null,
    medium: v.medium ?? null,
    dimensions: v.dimensions ?? null,
    year: v.year ?? null,
    country: v.country ?? null,
    provenance: v.provenance ?? null,
    edition: v.edition ?? null,
    match_confidence: v.match_confidence ?? 0.5,
  };
}

// Vision fills what it can; the user's own hints always win on conflict.
function mergeIdentity(vision, hints) {
  const merged = { ...(vision || {}) };
  for (const [key, value] of Object.entries(hints || {})) {
    if (value != null && value !== '') merged[key] = value;
  }
  return {
    artist: merged.artist ?? null,
    title: merged.title ?? null,
    medium: merged.medium ?? null,
    dimensions: merged.dimensions ?? null,
    year: merged.year ?? null,
    country: merged.country ?? null,
    provenance: merged.provenance ?? null,
    edition: merged.edition ?? null,
    method: vision ? 'vision' : 'catalog',
    match_confidence: vision?.match_confidence ?? (merged.artist ? 0.9 : 0.4),
  };
}

function definedIdentity(identity) {
  const defined = {};
  for (const [key, value] of Object.entries(identity)) {
    if (value != null && value !== '') defined[key] = value;
  }
  return defined;
}

// The estimator needs artist, title, medium, dimensions or year; country and
// provenance alone cannot price a work.
function hasUsableSignal(identity) {
  return Boolean(
    identity.artist || identity.title || identity.medium || identity.dimensions || identity.year,
  );
}

function missingFields(identity) {
  const missing = [];
  if (!identity.artist) missing.push('artist');
  if (!identity.year) missing.push('year');
  if (!identity.country) missing.push('country');
  if (!identity.dimensions) missing.push('size');
  if (!identity.medium) missing.push('medium');
  return missing;
}

function needsDetails(basis, identity = {}, missing = MISSING_FIELDS, assessment = null) {
  return {
    status: 'needs_details',
    identity: definedIdentity(identity),
    value: null,
    confidence: { level: 'low', coverage: 0, basis },
    provenance: [],
    sources: [],
    missing_fields: missing,
    ...(assessment ? { assessment } : {}),
  };
}

// A price/momentum signal in 0..100 for the underpriced flag. For a work with
// no auction record the momentum score is the signal; otherwise it is the
// percentile of the estimated price inside the artist's recorded sales, or the
// whole cohort when the artist sample is thin.
function priceSignalFor(est, model) {
  if (est.method === 'momentum' && est.momentum) return est.momentum.score;
  const artistRows = est.query.artist_slug
    ? model.rows.filter((row) => row.artist_slug === est.query.artist_slug)
    : [];
  const cohort = artistRows.length >= 5 ? artistRows : model.rows;
  return cohortPriceSignal(
    cohort.map((row) => row.price_cents / 100),
    est.predicted,
  );
}

// The piece-based assessment is additive: it never touches the value or its
// range. It is built only when vision returned attributes of the work itself.
function assessmentFor(attributes, est, model) {
  if (!attributes) return null;
  const priceSignal = est ? priceSignalFor(est, model) : null;
  return buildAssessment({ attributes, priceSignal });
}

function assessmentBasisLines(assessment) {
  if (!assessment) return [];
  const labels = { composition: 'composition', colorLight: 'color/light', subject: 'subject', originality: 'originality', condition: 'condition' };
  const attributes = Object.entries(assessment.attributes)
    .map(([key, value]) => `${labels[key] || key} ${value}`)
    .join(', ');
  const lines = [
    `Notice score ${assessment.notice_score}/100 (${assessment.notice_band}) from the work itself, independent of price.`,
    `Attributes: ${attributes}.`,
  ];
  if (assessment.coverage === 'unavailable') {
    lines.push('Rubric coverage: unavailable (no ground-truth labels).');
  } else {
    lines.push(
      `Rubric agreement ${Math.round((assessment.agreement ?? 0) * 100)}% over ${assessment.rubric.labeled} labelled works; coverage: ${Math.round(assessment.coverage * 100)}%.`,
    );
  }
  lines.push(...assessment.basis);
  return lines;
}

function basisReasons(est, model, identity) {
  const reasons = [];
  // A zero-auction artist priced from momentum: state each signal's contribution
  // and be honest that there is no held-out coverage to quote.
  if (est.method === 'momentum') {
    const p = est.momentum.parts;
    reasons.push('No auction record for this artist; the estimate is built from artist momentum.');
    reasons.push(
      `Momentum ${Math.round(est.momentum.score)}/100: exhibition ${Math.round(p.exhibition)}, gallery ${Math.round(p.gallery)}, press ${Math.round(p.press)}, social ${Math.round(p.social)}.`,
    );
    reasons.push('Exhibition counts recent solo and group shows, weighted by venue tier.');
    reasons.push('Gallery uses the best representing partner tier and how many galleries show the work.');
    reasons.push('Press counts recent articles; social uses capped followers and 90-day growth.');
    reasons.push('Artist is not in the auction comps, so the pooled model level was used.');
    reasons.push(`Range is capped at ±${Math.round(MAX_BAND_FRACTION * 100)}% around the central estimate.`);
    if (est.coverage == null) reasons.push('coverage: unavailable');
    return reasons;
  }
  if (est.method === 'edition') {
    reasons.push(`Matched ${est.comps.length} recorded auction sales of the same artist and title.`);
  } else {
    reasons.push(
      `Hedonic estimate from ${model.count} recorded auction sales across ${model.artists.length} artists.`,
    );
    reasons.push('Uses artist, image area, medium class and creation year.');
  }
  if (identity.artist && !est.query.artist_slug) {
    reasons.push('Artist was not matched in the comps, so the pooled model was used.');
  }
  // Recency weighting and the fitted sale-year trend, stated so the why is
  // honest about the recent prices driving the estimate.
  reasons.push(
    `Recent sales weigh more: a sale ${Math.round(RECENCY_HALF_LIFE_YEARS)} years old counts half as much as a new one.`,
  );
  const slope = model.trend?.slope;
  if (Number.isFinite(slope) && Math.abs(slope) > 1e-4) {
    const pctPerYear = (Math.pow(10, slope) - 1) * 100;
    const dir = pctPerYear >= 0 ? 'up' : 'down';
    reasons.push(
      `Fitted sale-price trend ${Math.abs(pctPerYear).toFixed(1)}% a year ${dir}, projected forward to the latest recorded sale.`,
    );
  }
  const capPct = Math.round(MAX_BAND_FRACTION * 100);
  reasons.push(`Range is capped at ±${capPct}% around the central estimate.`);
  const empirical = est.capped ? model.cappedCoverage : model.coverage?.[est.coverage];
  if (empirical != null) {
    reasons.push(`On held-out sales this range covered ${(empirical * 100).toFixed(0)}%.`);
  }
  if (est.coverage == null) reasons.push('coverage: unavailable');
  return reasons;
}

function similarItems(model, query, limit = 5) {
  if (!query.artist_slug) return [];
  const target = query.area_cm2;
  const distance = (row) =>
    target && row.area_cm2 ? Math.abs(Math.log10(row.area_cm2 / target)) : 1;
  return model.rows
    .filter((row) => row.artist_slug === query.artist_slug)
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, limit)
    .map((row) => ({
      title: row.title,
      artist: row.artist_name,
      year: row.creation_year,
      medium: row.medium_text,
      dimensions: row.dimension_text,
      sale_date: row.sale_date,
      price: Math.round(row.price_cents / 100),
      currency: 'USD',
      organization: row.organization,
      ref: row.internal_id,
    }));
}

// One row per recorded sale behind the estimate. The data provider is never
// named: the requester asked that the record's source stay out of the reply.
function provenanceFrom(comps) {
  return comps.slice(0, 5).map((c) => ({
    kind: 'auction_sale',
    ref: c.internal_id,
    title: c.title,
    artist: c.artist_name,
    sale_date: c.sale_date,
  }));
}

export function createApp({ db, vision = identifyFromImage, visionEnabled = visionConfigured, chat = answerQuestion } = {}) {
  const database = db || openDb();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '30mb' }));

  // Cache the model and rebuild only on a throttled timer so a growing sales
  // table (active ingest) cannot trigger a rebuild on every request.
  const REBUILD_MS = Math.max(0, Number(process.env.MODEL_REBUILD_MINUTES ?? 15)) * 60_000;
  let modelCache = null;
  let modelCount = -1;
  let modelBuiltAt = 0;
  let rebuilding = false;
  const startRebuild = () => {
    rebuilding = true;
    setImmediate(() => {
      try {
        modelCache = buildModel(allSales(database));
        modelCount = salesCount(database);
        modelBuiltAt = Date.now();
      } finally {
        rebuilding = false;
      }
    });
  };
  const getModel = () => {
    const count = salesCount(database);
    if (!modelCache) {
      modelCache = buildModel(allSales(database));
      modelCount = count;
      modelBuiltAt = Date.now();
    } else if (!rebuilding && count !== modelCount && Date.now() - modelBuiltAt >= REBUILD_MS) {
      startRebuild();
    }
    return modelCache;
  };

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // A free-form chat message, answered conversationally in the pricing/art
  // remit. It never runs the image path and never returns a fresh estimate.
  app.post('/chat', async (req, res) => {
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(res, 'body must be a JSON object');
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return badRequest(res, 'message must be a non-empty string');
    }
    const result = await chat({
      message: body.message.trim(),
      identity: body.identity && typeof body.identity === 'object' ? body.identity : null,
      value: body.value && typeof body.value === 'object' ? body.value : null,
      confidence: body.confidence && typeof body.confidence === 'object' ? body.confidence : null,
      history: Array.isArray(body.history) ? body.history : [],
    });
    return res.json({
      status: 'answered',
      answer: result?.answer || groundedAnswer({ message: body.message, identity: body.identity, value: body.value }),
      source: result?.source || 'grounded',
    });
  });

  app.post('/appraise', async (req, res) => {
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(res, 'body must be a JSON object');
    }
    for (const field of ['imageBase64', 'mimeType', 'imageUrl', 'note']) {
      const check = optionalString(body[field], field);
      if (!check.ok) return badRequest(res, check.error);
    }

    const hints = {};
    if (body.hints != null) {
      if (typeof body.hints !== 'object' || Array.isArray(body.hints)) {
        return badRequest(res, 'hints must be an object');
      }
      for (const field of HINT_FIELDS) {
        const check = optionalString(body.hints[field], `hints.${field}`);
        if (!check.ok) return badRequest(res, check.error);
        if (check.value) hints[field] = check.value;
      }
    }

    // The identification layer runs first (when a key is configured and an
    // image was sent); the user's hints then override whatever it found.
    const hasImage = Boolean(body.imageBase64 || body.imageUrl);
    let visionIdentity = null;
    let visionNote = null;
    let visionAttributes = null;
    if (hasImage && visionEnabled()) {
      const described = Object.entries(hints).map(([key, value]) => `${key}: ${value}`);
      const note = [body.note, described.length ? `User-provided details: ${described.join(', ')}` : null]
        .filter(Boolean)
        .join('\n');
      const result = await vision({
        imageBase64: body.imageBase64,
        mimeType: body.mimeType,
        imageUrl: body.imageUrl,
        note: note || undefined,
      });
      if (result?.identified) visionIdentity = identityFromVision(result);
      else visionNote = result?.reason || 'vision returned no identity';
      if (result?.attributes) visionAttributes = result.attributes;
    }

    const identity = mergeIdentity(visionIdentity, identityFromHints(hints));

    if (!hasUsableSignal(identity)) {
      const basis = [];
      if (visionNote) basis.push(`Vision could not identify the work (${visionNote}).`);
      else if (hasImage && !visionEnabled()) basis.push('No vision key configured; the image was not identified.');
      else if (!hasImage) basis.push('No image supplied; vision was not attempted.');
      basis.push('Provide what you know and the appraiser will price it from recorded auction sales.');
      // With a piece reading but no price yet, show the notice signal only.
      const assessment = assessmentFor(visionAttributes, null, null);
      if (assessment) basis.push(...assessmentBasisLines(assessment));
      return res.json(needsDetails(basis, identity, missingFields(identity), assessment));
    }

    const model = getModel();
    // Signals are read from the cached table, never fetched live on this path.
    const signals = identity.artist ? getArtistSignals(database, identity.artist) : null;
    const est = estimate(
      model,
      {
        artist: identity.artist,
        title: identity.title,
        medium: identity.medium,
        dimensions: identity.dimensions,
        year: identity.year,
      },
      { signals },
    );

    if (!est.ok) {
      return res.json({
        status: 'refused',
        identity,
        value: null,
        confidence: {
          level: 'low',
          coverage: 0,
          basis: [est.reason, 'Ingest comps or add more identifying details and try again.'],
        },
        provenance: [],
        sources: [],
        missing_fields: missingFields(identity),
      });
    }

    // Round for display, then keep the shown range inside the ±10% promise
    // even after two-significant-figure rounding pushed an edge outward.
    const floorBound = niceUp(est.predicted * (1 - MAX_BAND_FRACTION));
    const ceilBound = niceDown(est.predicted * (1 + MAX_BAND_FRACTION));
    let low = Math.max(roundNice(est.low), floorBound);
    let high = Math.min(Math.max(low, roundNice(est.high)), ceilBound);
    if (high < low) low = high = roundNice(est.predicted);

    // Positioning and the piece assessment annotate the reply only: they are
    // computed after the value is fixed and never feed back into the central
    // estimate or its range.
    const positioning = positionWork(model, est.query);
    const basis = basisReasons(est, model, identity);
    basis.push(positioning.basis[0]);
    const assessment = assessmentFor(visionAttributes, est, model);
    if (assessment) basis.push(...assessmentBasisLines(assessment));

    return res.json({
      status: 'priced',
      identity,
      value: { low, high, currency: 'USD', as_of: today() },
      confidence: {
        level: est.levelName,
        coverage: est.coverage,
        basis,
      },
      positioning,
      provenance: provenanceFrom(est.comps),
      sources: [],
      similar: similarItems(model, est.query),
      ...(assessment ? { assessment } : {}),
    });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const db = openDb();
  const app = createApp({ db });
  app.listen(port, () => {
    console.log(`The Collector server listening on http://localhost:${port}`);
  });
}
