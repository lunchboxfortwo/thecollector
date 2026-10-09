// Valuation: parsing, hedonic + edition estimator, and residual-calibrated bands.
// Pure functions so tests can inject synthetic rows without a database.

export const MEDIUM_CLASSES = ['print', 'photograph', 'sculpture', 'painting', 'work_on_paper', 'other'];
export const MEDIUM_BASELINE = 'other';
export const COVERAGE_LEVELS = [0.5, 0.6, 0.8, 0.9];
// The requester asked for a tighter, less conservative range. The displayed
// range defaults to the central 60% of comparable sales rather than the wide
// 80% residual band; the 80/90 levels stay available.
export const DEFAULT_COVERAGE = 0.6;

// Minimum comparable sales before the range is taken from the comps themselves.
const MIN_COMPS = 8;
const MAX_COMPS = 200;
// Area windows tried in order; the first that yields enough comps wins.
const COMP_AREA_FACTORS = [1.6, 3.16, 10, Infinity];

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

// Non-artist hedonic columns: log area, centred year, and medium-class dummies.
// Artist identity is a fixed effect, so it never becomes a dense column.
function otherFeatures(core, r) {
  const logArea = Number.isFinite(r.area_cm2) && r.area_cm2 > 0 ? Math.log10(r.area_cm2) : core.defaultLogArea;
  const year = Number.isFinite(r.creation_year) && r.creation_year > 1500 && r.creation_year < 2100 ? r.creation_year : core.defaultYear;
  const feats = [logArea, (year - 1900) / 100];
  for (const cls of MEDIUM_CLASSES) if (cls !== MEDIUM_BASELINE) feats.push(r.medium_class === cls ? 1 : 0);
  return feats;
}

// Within-artist fixed-effects fit. Demeaning each artist's rows and fitting the
// seven non-artist columns (Frisch-Waugh-Lovell) gives the same slopes as the
// previous design, which carried one dummy column per artist. Each artist
// intercept is then the group mean of the residual, y - beta'z.
function withinArtistFit(rows, core) {
  const p = otherFeatures(core, rows[0]).length;

  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.artist_slug);
    if (!g) {
      g = { n: 0, sz: new Array(p).fill(0), sy: 0 };
      groups.set(r.artist_slug, g);
    }
    g.n++;
    g.sy += r.logPrice;
    const z = otherFeatures(core, r);
    for (let j = 0; j < p; j++) g.sz[j] += z[j];
  }

  const means = new Map();
  for (const [slug, g] of groups) {
    means.set(slug, { z: g.sz.map((v) => v / g.n), y: g.sy / g.n });
  }

  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  const d = new Array(p);
  for (const r of rows) {
    const z = otherFeatures(core, r);
    const m = means.get(r.artist_slug);
    const dy = r.logPrice - m.y;
    for (let j = 0; j < p; j++) d[j] = z[j] - m.z[j];
    for (let a = 0; a < p; a++) {
      Xty[a] += d[a] * dy;
      for (let b = 0; b < p; b++) XtX[a][b] += d[a] * d[b];
    }
  }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  const beta = solveLinearSystem(XtX, Xty);
  if (!beta) return null;

  const residual = new Map();
  for (const r of rows) {
    let g = residual.get(r.artist_slug);
    if (!g) {
      g = { sum: 0, n: 0 };
      residual.set(r.artist_slug, g);
    }
    g.sum += r.logPrice - dot(otherFeatures(core, r), beta);
    g.n++;
  }

  const artistEffects = new Map();
  let total = 0;
  for (const slug of core.artists) {
    const g = residual.get(slug);
    const effect = g && g.n ? g.sum / g.n : 0;
    artistEffects.set(slug, effect);
    total += effect;
  }
  const meanArtistEffect = core.artists.length ? total / core.artists.length : 0;
  return { beta, artistEffects, meanArtistEffect };
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

  // Editions are repeat sales of the same printed work, so a comp must share
  // the medium class too: a painting and a same-title print are different
  // markets and must never bind to each other.
  const editionIndex = new Map();
  const byArtistMedium = new Map();
  for (const r of rows) {
    const mediumKey = `${r.artist_slug}|${r.medium_class}`;
    if (!byArtistMedium.has(mediumKey)) byArtistMedium.set(mediumKey, []);
    byArtistMedium.get(mediumKey).push(r);
    if (isGenericTitle(r.title_norm)) continue;
    const key = `${r.artist_slug}|${r.title_norm}|${r.medium_class}`;
    if (!editionIndex.has(key)) editionIndex.set(key, []);
    editionIndex.get(key).push(r);
  }

  const core = {
    rows,
    artists,
    artistBaseline,
    artistByName,
    defaultLogArea,
    defaultYear,
    editionIndex,
    byArtistMedium,
    artistMedians: new Map(),
    beta: null,
    artistEffects: new Map(),
    meanArtistEffect: 0,
  };

  // Same guard as the old dense fit: enough rows to identify the intercept,
  // the artist effects and the seven non-artist columns.
  const otherCount = 2 + (MEDIUM_CLASSES.length - 1);
  if (rows.length && rows.length >= artists.length + otherCount + 5) {
    const fit = withinArtistFit(rows, core);
    if (fit) {
      core.beta = fit.beta;
      core.artistEffects = fit.artistEffects;
      core.meanArtistEffect = fit.meanArtistEffect;
    }
  }

  const artistMedians = new Map();
  const byArtist = new Map();
  for (const r of rows) {
    if (!byArtist.has(r.artist_slug)) byArtist.set(r.artist_slug, []);
    byArtist.get(r.artist_slug).push(r.logPrice);
  }
  for (const [slug, vals] of byArtist) artistMedians.set(slug, median(vals));
  core.artistMedians = artistMedians;

  return core;
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
    ? `${q.artist_slug}|${q.title_norm}|${q.medium_class}`
    : null;
  if (key && core.editionIndex.has(key) && core.editionIndex.get(key).length >= 2) {
    const comps = core.editionIndex.get(key);
    return { log10: median(comps.map((r) => r.logPrice)), method: 'edition', comps };
  }
  if (core.beta) {
    // Known artist: its own fixed effect. Unknown artist: pool over every known
    // artist rather than picking one intercept.
    const intercept = q.artist_slug && core.artistEffects.has(q.artist_slug)
      ? core.artistEffects.get(q.artist_slug)
      : core.meanArtistEffect;
    return { log10: intercept + dot(otherFeatures(core, q), core.beta), method: 'hedonic', comps: [] };
  }
  if (q.artist_slug && core.artistMedians.has(q.artist_slug)) {
    return { log10: core.artistMedians.get(q.artist_slug), method: 'hedonic', comps: [] };
  }
  return null;
}

const FALLBACK_BAND = { 0.5: 1.9, 0.6: 2.6, 0.8: 4.3, 0.9: 8.0 };
// The raw spread of a comp set under-covers out of sample, so it is inflated by a
// factor measured on the held-out split. These are the conservative defaults.
const FALLBACK_COMP_INFLATION = { 0.5: 1.15, 0.6: 1.2, 0.8: 1.3, 0.9: 1.5 };

// Comparable sales for a query, from an index so a large table stays cheap.
// An edition uses its matched comps; otherwise the artist's sales in the same
// medium class, starting from the closest areas and widening until enough.
function comparableSales(core, q, prediction) {
  if (prediction.method === 'edition') return { comps: prediction.comps, source: 'edition' };
  if (!q.artist_slug || !core.byArtistMedium) return { comps: [], source: 'none' };
  const pool = core.byArtistMedium.get(`${q.artist_slug}|${q.medium_class}`) || [];
  if (!pool.length) return { comps: [], source: 'none' };
  const area = Number.isFinite(q.area_cm2) && q.area_cm2 > 0 ? q.area_cm2 : null;
  for (const factor of COMP_AREA_FACTORS) {
    let comps = pool;
    if (area && Number.isFinite(factor)) {
      const f = Math.log(factor);
      comps = pool.filter(
        (r) => Number.isFinite(r.area_cm2) && r.area_cm2 > 0 && Math.abs(Math.log10(r.area_cm2 / area)) <= f,
      );
    }
    if (comps.length >= MIN_COMPS || factor === Infinity) {
      return { comps: comps.slice(0, MAX_COMPS), source: comps.length ? 'comps' : 'none' };
    }
  }
  return { comps: [], source: 'none' };
}

// Half-width in log10 space for one prediction: the empirical spread of its
// comparable sales when there are enough, else the calibrated residual band.
function compResidualsFor(core, q, prediction) {
  const { comps, source } = comparableSales(core, q, prediction);
  const minComps = source === 'edition' ? 2 : MIN_COMPS;
  if (comps.length < minComps) return null;
  return { source, residuals: comps.map((c) => Math.abs(c.logPrice - prediction.log10)) };
}

// Build a model from raw sale rows and calibrate band multipliers on a held-out split.
export function buildModel(sales = []) {
  const prepared = sales.map(prepareRow);
  const core = buildCore(prepared);

  let band = { ...FALLBACK_BAND };
  let compInflation = { ...FALLBACK_COMP_INFLATION };
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

    // Inflate the comp spread so it covers out-of-sample sales at the stated level.
    const calComps = [];
    for (const r of calRows) {
      const p = predictCore(trainCore, r);
      if (!p) continue;
      const comp = compResidualsFor(trainCore, r, p);
      if (comp) calComps.push({ residual: Math.abs(r.logPrice - p.log10), comp });
    }
    if (calComps.length >= 10) {
      compInflation = {};
      for (const level of COVERAGE_LEVELS) {
        const ratios = calComps.map((e) => {
          const base = quantile(e.comp.residuals, level);
          return base > 0 ? e.residual / base : 1;
        });
        compInflation[level] = Math.max(1, quantile(ratios, level));
      }
    }

    const evalPreds = [];
    for (const r of evalRows) {
      const p = predictCore(trainCore, r);
      if (!p) continue;
      const comp = compResidualsFor(trainCore, r, p);
      evalPreds.push({ residual: Math.abs(r.logPrice - p.log10), comp });
    }
    if (evalPreds.length >= 10) {
      coverage = {};
      for (const level of COVERAGE_LEVELS) {
        let covered = 0;
        for (const e of evalPreds) {
          const halfLog = e.comp
            ? quantile(e.comp.residuals, level) * compInflation[level]
            : Math.log10(band[level]);
          if (e.residual <= halfLog) covered++;
        }
        coverage[level] = covered / evalPreds.length;
      }
    }
  }

  return { ...core, band, compInflation, coverage, count: prepared.length, prepared };
}

const COVERAGE_NAMES = { 0.5: 'low', 0.6: 'medium', 0.8: 'high', 0.9: 'very high' };

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

  const level = COVERAGE_LEVELS.includes(coverage) ? coverage : DEFAULT_COVERAGE;

  // Prefer the actual comparable sales for the range: it is both tighter and
  // grounded in the evidence the user is shown. Fall back to the calibrated
  // residual band when there are too few comps.
  const comp = compResidualsFor(model, q, prediction);
  const inflation = model.compInflation?.[level] ?? FALLBACK_COMP_INFLATION[level] ?? 1;
  const halfLog = comp
    ? quantile(comp.residuals, level) * inflation
    : Math.log10(model.band[level]);

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
    band: Math.pow(10, halfLog),
    bandSource: comp ? 'comps' : 'model',
    comparableCount: comp ? comp.residuals.length : (prediction.comps?.length || 0),
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
