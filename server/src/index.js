import { pathToFileURL } from 'node:url';
import express from 'express';
import { openDb, allSales, salesCount } from './db.js';
import { buildModel, estimate, roundNice } from './valuation.js';
import { identifyFromImage, visionConfigured } from './vision.js';

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

function identityFromHints(hints) {
  return {
    artist: hints.artist ?? null,
    title: hints.title ?? null,
    medium: hints.medium ?? null,
    dimensions: hints.size ?? null,
    year: hints.year ?? null,
    country: hints.country ?? null,
    edition: null,
    method: 'catalog',
    match_confidence: hints.artist ? 0.9 : 0.4,
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
    edition: v.edition ?? null,
    method: 'vision',
    match_confidence: v.match_confidence ?? 0.5,
  };
}

function needsDetails(basis) {
  return {
    status: 'needs_details',
    identity: {},
    value: null,
    confidence: { level: 'low', coverage: 0, basis },
    provenance: [],
    sources: [],
    missing_fields: MISSING_FIELDS,
  };
}

function basisReasons(est, model, identity) {
  const reasons = [];
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
  reasons.push(
    `Band is ×${est.band.toFixed(1)} either side, calibrated on held-out residuals to ${Math.round(est.coverage * 100)}% coverage.`,
  );
  if (model.coverage) {
    reasons.push(`Held-out empirical coverage at 80%: ${(model.coverage[0.8] * 100).toFixed(0)}%.`);
  }
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

function provenanceFrom(comps) {
  return comps.slice(0, 5).map((c) => ({
    source: 'Artsy auction results',
    kind: 'auction_sale',
    ref: c.internal_id,
    title: c.title,
    artist: c.artist_name,
    sale_date: c.sale_date,
  }));
}

export function createApp({ db, vision = identifyFromImage, visionEnabled = visionConfigured } = {}) {
  const database = db || openDb();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '30mb' }));

  let modelCache = null;
  let modelCount = -1;
  const getModel = () => {
    const count = salesCount(database);
    if (!modelCache || count !== modelCount) {
      modelCache = buildModel(allSales(database));
      modelCount = count;
    }
    return modelCache;
  };

  app.get('/health', (_req, res) => res.json({ ok: true }));

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

    let identity = null;
    let visionNote = null;
    if (Object.keys(hints).length) {
      identity = identityFromHints(hints);
    } else if ((body.imageBase64 || body.imageUrl) && visionEnabled()) {
      const result = await vision({
        imageBase64: body.imageBase64,
        mimeType: body.mimeType,
        imageUrl: body.imageUrl,
        note: body.note,
      });
      if (result?.identified) identity = identityFromVision(result);
      else visionNote = result?.reason || 'vision returned no identity';
    }

    if (!identity) {
      const basis = [
        visionNote
          ? `Vision could not identify the work (${visionNote}).`
          : 'No identity provided; vision is not configured.',
        'Provide artist, year, country, size and medium to price it from recorded auction sales.',
      ];
      return res.json(needsDetails(basis));
    }

    const model = getModel();
    const est = estimate(model, {
      artist: identity.artist,
      title: identity.title,
      medium: identity.medium,
      dimensions: identity.dimensions,
      year: identity.year,
    });

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
        missing_fields: identity.artist ? [] : MISSING_FIELDS,
      });
    }

    const low = roundNice(est.low);
    const high = Math.max(low, roundNice(est.high));

    return res.json({
      status: 'priced',
      identity,
      value: { low, high, currency: 'USD', as_of: today() },
      confidence: {
        level: est.levelName,
        coverage: est.coverage,
        basis: basisReasons(est, model, identity),
      },
      provenance: provenanceFrom(est.comps),
      sources: ['Artsy auction results'],
      similar: similarItems(model, est.query),
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
