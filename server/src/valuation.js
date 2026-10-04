// Valuation: parsing, hedonic + edition estimator, and residual-calibrated bands.
// Pure functions so tests can inject synthetic rows without a database.

export const MEDIUM_CLASSES = ['print', 'photograph', 'sculpture', 'painting', 'work_on_paper', 'other'];
export const MEDIUM_BASELINE = 'other';
export const COVERAGE_LEVELS = [0.5, 0.8, 0.9];
export const DEFAULT_COVERAGE = 0.8;

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

// Fold case and diacritics so "Joan Miro" matches "Joan Miró".
function foldName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeTitle(title) {
  if (!title) return '';
  return String(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const GENERIC_TITLES = new Set(['untitled', 'no title', 'none', 'unknown', 'n a', 'na']);

export function isGenericTitle(norm) {
  if (!norm) return true;
  return GENERIC_TITLES.has(norm) || norm.startsWith('untitled');
}

function parseNumberToken(token) {
  if (token == null) return null;
  const s = String(token).trim();
  const frac = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const d = Number(frac[3]);
    if (!d) return null;
    return Number(frac[1]) + Number(frac[2]) / d;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Parse a dimension string to the largest plausible area in cm².
// Handles "103.2 x 78.9 cm (40 5/8 x 31 1/8 in.)" and inches-only strings.
export function parseAreaCm2(dimensionText) {
  if (!dimensionText) return null;
  const text = String(dimensionText);
  const NUM = '(\\d+(?:\\.\\d+)?(?:\\s+\\d+\\s*\\/\\s*\\d+)?)';

  const cmAreas = [];
  const cmRe = new RegExp(`${NUM}\\s*[x×]\\s*${NUM}\\s*cm`, 'gi');
  let m;
  while ((m = cmRe.exec(text))) {
    const a = parseNumberToken(m[1]);
    const b = parseNumberToken(m[2]);
    if (a && b) cmAreas.push(a * b);
  }
  // Prefer a stated cm measurement; only convert inches when no cm value exists.
  if (cmAreas.length) return Math.max(...cmAreas);

  const inAreas = [];
  const inRe = new RegExp(`${NUM}\\s*[x×]\\s*${NUM}\\s*(?:in|inch|inches)\\b`, 'gi');
  while ((m = inRe.exec(text))) {
    const a = parseNumberToken(m[1]);
    const b = parseNumberToken(m[2]);
    if (a && b) inAreas.push(a * b * 2.54 * 2.54);
  }

  if (!inAreas.length) return null;
  return Math.max(...inAreas);
}

function hasWord(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

export function classifyMedium(mediumText) {
  const t = String(mediumText || '').toLowerCase();
  if (!t) return 'other';
  const has = (...words) => words.some((w) => hasWord(t, w));
  if (has('print', 'lithograph', 'screenprint', 'screen print', 'silkscreen', 'serigraph', 'etching', 'engraving', 'aquatint', 'woodcut', 'linocut', 'monoprint', 'poster', 'multiple')) {
    return 'print';
  }
  if (has('photograph', 'gelatin silver', 'chromogenic', 'c print', 'c-print', 'daguerreotype', 'ambrotype', 'photogravure', 'photo')) {
    return 'photograph';
  }
  if (has('sculpture', 'bronze', 'marble', 'ceramic', 'porcelain', 'terracotta', 'glass', 'assemblage', 'maquette', 'statue', 'relief')) {
    return 'sculpture';
  }
  if (has('oil', 'acrylic', 'canvas', 'tempera', 'painting', 'encaustic')) {
    return 'painting';
  }
  if (has('paper', 'watercolor', 'watercolour', 'gouache', 'ink', 'pencil', 'charcoal', 'pastel', 'crayon', 'graphite', 'drawing', 'collage')) {
    return 'work_on_paper';
  }
  return 'other';
}

// First four-digit year in a date string ("1986-1987" -> 1986).
export function parseYear(dateText) {
  const m = String(dateText || '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// small numerics
// ---------------------------------------------------------------------------

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (!factor) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// Ridge-regularised ordinary least squares.
function ols(X, y) {
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  return solveLinearSystem(XtX, Xty);
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

function prepareRow(sale) {
  const price_cents = Number(sale.price_cents) || 0;
  return {
    ...sale,
    price_cents,
    area_cm2: sale.area_cm2 != null ? sale.area_cm2 : parseAreaCm2(sale.dimension_text),
    medium_class: sale.medium_class || classifyMedium(sale.medium_text),
    creation_year: sale.creation_year != null ? sale.creation_year : parseYear(sale.date_text),
    title_norm: sale.title_norm || normalizeTitle(sale.title),
    logPrice: price_cents > 0 ? Math.log10(price_cents / 100) : null,
  };
}

function buildCore(preparedRows) {
  const rows = preparedRows.filter((r) => r.price_cents > 0);

  const areas = rows.map((r) => r.area_cm2).filter((v) => Number.isFinite(v) && v > 0);
  const years = rows.map((r) => r.creation_year).filter((v) => Number.isFinite(v) && v > 1500 && v < 2100);
  const defaultLogArea = areas.length ? Math.log10(median(areas)) : Math.log10(1000);
  const defaultYear = years.length ? median(years) : 1980;

  const artists = [...new Set(rows.map((r) => r.artist_slug))].sort();
  const artistBaseline = artists[0] ?? null;

  const artistByName = new Map();
  for (const r of rows) {
    if (r.artist_name) artistByName.set(foldName(r.artist_name), r.artist_slug);
    artistByName.set(foldName(r.artist_slug), r.artist_slug);
  }

  const editionIndex = new Map();
  for (const r of rows) {
    if (isGenericTitle(r.title_norm)) continue;
    const key = `${r.artist_slug}|${r.title_norm}`;
    if (!editionIndex.has(key)) editionIndex.set(key, []);
    editionIndex.get(key).push(r);
  }

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

  let beta = null;
  if (rows.length && rows.length >= featureRow(rows[0]).length + 5) {
    beta = ols(rows.map(featureRow), rows.map((r) => r.logPrice));
  }

  const artistMedians = new Map();
  const byArtist = new Map();
  for (const r of rows) {
    if (!byArtist.has(r.artist_slug)) byArtist.set(r.artist_slug, []);
    byArtist.get(r.artist_slug).push(r.logPrice);
  }
  for (const [slug, vals] of byArtist) artistMedians.set(slug, median(vals));

  return {
    rows,
    artists,
    artistBaseline,
    artistByName,
    defaultLogArea,
    defaultYear,
    editionIndex,
    artistMedians,
    beta,
    featureRow,
  };
}

// Resolve a free-form query into core feature fields.
function prepareQuery(core, query = {}) {
  const rawArtist = query.artist ? String(query.artist).trim() : '';
  let artist_slug = null;
  if (rawArtist) {
    artist_slug = core.artistByName.get(foldName(rawArtist)) || null;
  }
  const title_norm = normalizeTitle(query.title);
  return {
    artist: rawArtist || null,
    artist_slug,
    title: query.title || null,
    title_norm,
    area_cm2: query.area_cm2 != null ? query.area_cm2 : parseAreaCm2(query.dimensions || query.size),
    medium_class: query.medium_class || classifyMedium(query.medium),
    creation_year: query.creation_year != null ? query.creation_year : parseYear(query.year),
  };
}

function predictCore(core, q) {
  const key = q.artist_slug && q.title_norm && !isGenericTitle(q.title_norm)
    ? `${q.artist_slug}|${q.title_norm}`
    : null;
  if (key && core.editionIndex.has(key) && core.editionIndex.get(key).length >= 2) {
    const comps = core.editionIndex.get(key);
    return { log10: median(comps.map((r) => r.logPrice)), method: 'edition', comps };
  }
  if (core.beta) {
    if (q.artist_slug && core.artists.includes(q.artist_slug)) {
      return { log10: dot(core.featureRow(q), core.beta), method: 'hedonic', comps: [] };
    }
    // Unknown artist: pool over every known artist rather than picking one intercept.
    let sum = 0;
    for (const artist of core.artists) {
      sum += dot(core.featureRow({ ...q, artist_slug: artist }), core.beta);
    }
    return { log10: sum / core.artists.length, method: 'hedonic', comps: [] };
  }
  if (q.artist_slug && core.artistMedians.has(q.artist_slug)) {
    return { log10: core.artistMedians.get(q.artist_slug), method: 'hedonic', comps: [] };
  }
  return null;
}

const FALLBACK_BAND = { 0.5: 1.9, 0.8: 4.3, 0.9: 8.0 };

// Build a model from raw sale rows and calibrate band multipliers on a held-out split.
export function buildModel(sales = []) {
  const prepared = sales.map(prepareRow);
  const core = buildCore(prepared);

  let band = { ...FALLBACK_BAND };
  let coverage = null;

  const evalRows = prepared.filter((_, i) => i % 5 === 4);
  const calRows = prepared.filter((_, i) => i % 5 === 3);
  const trainRows = prepared.filter((_, i) => i % 5 !== 3 && i % 5 !== 4);

  if (trainRows.length >= 20) {
    const trainCore = buildCore(trainRows);

    const calResiduals = [];
    for (const r of calRows) {
      const p = predictCore(trainCore, r);
      if (p) calResiduals.push(Math.abs(r.logPrice - p.log10));
    }
    if (calResiduals.length >= 10) {
      band = {};
      for (const level of COVERAGE_LEVELS) band[level] = Math.pow(10, quantile(calResiduals, level));
    }

    const evalResiduals = [];
    for (const r of evalRows) {
      const p = predictCore(trainCore, r);
      if (p) evalResiduals.push(Math.abs(r.logPrice - p.log10));
    }
    if (evalResiduals.length >= 10) {
      coverage = {};
      for (const level of COVERAGE_LEVELS) {
        const halfLog = Math.log10(band[level]);
        coverage[level] = evalResiduals.filter((r) => r <= halfLog).length / evalResiduals.length;
      }
    }
  }

  return { ...core, band, coverage, count: prepared.length, prepared };
}

const COVERAGE_NAMES = { 0.5: 'low', 0.8: 'medium', 0.9: 'high' };

// Estimate a value for `query` against `model`. Returns {ok:false} when nothing supports it.
export function estimate(model, query = {}, { coverage = DEFAULT_COVERAGE } = {}) {
  if (!model || !model.rows || model.rows.length === 0) {
    return { ok: false, reason: 'no comparable sales ingested' };
  }
  const q = prepareQuery(model, query);
  const prediction = predictCore(model, q);
  if (!prediction) {
    return { ok: false, reason: 'no comparable sales and no usable model' };
  }

  const level = model.band[coverage] != null ? coverage : DEFAULT_COVERAGE;
  const multiplier = model.band[level];
  const halfLog = Math.log10(multiplier);

  const predicted = Math.pow(10, prediction.log10);
  const low = Math.pow(10, prediction.log10 - halfLog);
  const high = Math.pow(10, prediction.log10 + halfLog);

  return {
    ok: true,
    method: prediction.method,
    query: q,
    predicted,
    low,
    high,
    band: multiplier,
    coverage: level,
    levelName: COVERAGE_NAMES[level] || 'medium',
    comps: prediction.comps,
  };
}

// Round to two significant figures for friendlier display values.
export function roundNice(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.max(1, Math.round(value / magnitude) * magnitude);
}
