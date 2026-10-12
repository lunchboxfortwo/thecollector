// Within-artist positioning: where a work sits inside its artist's own recorded
// output, by medium, image area, creation year, and edition.
//
// Pure and additive. It reads the rows the valuation core already holds and
// never touches the central value, the low/high range, or the ±10% cap.
//
// "Entire output" is larger than the recorded sales we hold: every percentile
// is relative to the artist's stored works and the basis line says so.
import {
  classifyMedium,
  foldName,
  isGenericTitle,
  normalizeTitle,
  parseAreaCm2,
  parseYear,
} from './valuation.js';

// Below this many stored works for the artist, no percentile is shown: a thin
// sample would print fake precision. Named so the guard is testable.
export const MIN_POSITION_SAMPLE = 5;

// Fraction of the artist's values at or below `value`. Non-decreasing in
// `value`, so a larger, later, or more common work never maps lower.
function percentileRank(value, values) {
  if (!Number.isFinite(value) || !values.length) return null;
  let atOrBelow = 0;
  for (const v of values) if (v <= value) atOrBelow++;
  return atOrBelow / values.length;
}

// Only score a key when its own usable sample reaches the minimum; otherwise
// return null so the reply shows no band for that key.
function keyPercentile(value, values, minSample) {
  if (values.length < minSample) return null;
  return percentileRank(value, values);
}

// Resolve the artist with the same case- and diacritic-folding lookup the
// valuation core used to build artistByName.
function resolveArtistSlug(model, query) {
  if (query?.artist_slug) return query.artist_slug;
  const raw = query?.artist ? String(query.artist).trim() : '';
  if (!raw || !model?.artistByName) return null;
  return model.artistByName.get(foldName(raw)) ?? null;
}

function mediumClassOf(row) {
  return row.medium_class || classifyMedium(row.medium_text);
}

function unavailable(slug, sampleSize, reason) {
  return {
    available: false,
    sampleSize,
    key: slug,
    percentiles: null,
    basis: [`Positioning within the artist's output: unavailable — ${reason}.`],
  };
}

export function positionWork(model, query = {}, { minSample = MIN_POSITION_SAMPLE } = {}) {
  const slug = resolveArtistSlug(model, query);
  if (!model || !Array.isArray(model.rows) || !model.rows.length) {
    return unavailable(slug, 0, 'no stored works');
  }
  if (!slug) {
    return unavailable(null, 0, 'the artist is not matched to any stored work');
  }

  const rows = model.rows.filter((r) => r.artist_slug === slug);
  if (rows.length < minSample) {
    return unavailable(
      slug,
      rows.length,
      `only ${rows.length} stored work${rows.length === 1 ? '' : 's'}, below the minimum of ${minSample}`,
    );
  }

  // Medium: how common this work's medium is in the artist's recorded output.
  const mediumCounts = new Map();
  for (const r of rows) {
    const m = mediumClassOf(r);
    mediumCounts.set(m, (mediumCounts.get(m) || 0) + 1);
  }
  const mediumValues = rows.map((r) => mediumCounts.get(mediumClassOf(r)));
  const queryMedium = query.medium_class || classifyMedium(query.medium);
  const medium = keyPercentile(mediumCounts.get(queryMedium) ?? 0, mediumValues, minSample);

  // Size: image area in cm². The prepared query already carries area_cm2; a
  // raw query may still spell it as dimensions or size text.
  const queryArea = Number.isFinite(query.area_cm2)
    ? query.area_cm2
    : parseAreaCm2(query.dimensions || query.size);
  const sizeValues = rows.map((r) => r.area_cm2).filter((v) => Number.isFinite(v));
  const size = keyPercentile(queryArea, sizeValues, minSample);

  // Year: creation year.
  const queryYear = Number.isFinite(query.creation_year)
    ? query.creation_year
    : parseYear(query.year);
  const yearValues = rows.map((r) => r.creation_year).filter((v) => Number.isFinite(v));
  const year = keyPercentile(queryYear, yearValues, minSample);

  // Edition: repeat recorded sales of the same title and medium — the same
  // edition key the valuation core uses. A more common edition ranks higher.
  const editionCounts = new Map();
  for (const r of rows) {
    if (isGenericTitle(r.title_norm)) continue;
    const k = `${r.title_norm}|${mediumClassOf(r)}`;
    editionCounts.set(k, (editionCounts.get(k) || 0) + 1);
  }
  const editionValues = [];
  for (const r of rows) {
    if (isGenericTitle(r.title_norm)) continue;
    editionValues.push(editionCounts.get(`${r.title_norm}|${mediumClassOf(r)}`));
  }
  let edition = null;
  const queryTitleNorm = query.title_norm || normalizeTitle(query.title);
  if (!isGenericTitle(queryTitleNorm)) {
    const queryEdition = editionCounts.get(`${queryTitleNorm}|${queryMedium}`) ?? 0;
    edition = keyPercentile(queryEdition, editionValues, minSample);
  }

  const percentiles = { medium, size, year, edition };
  const anyPercentile = Object.values(percentiles).some((v) => typeof v === 'number');

  return {
    available: true,
    sampleSize: rows.length,
    key: slug,
    percentiles: anyPercentile ? percentiles : null,
    basis: [
      `Positioned against ${rows.length} stored works by this artist; percentiles compare this work to the artist's recorded output, not their entire catalogue.`,
    ],
  };
}
