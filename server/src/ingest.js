import { openDb } from './db.js';
import { ingestAll, ingestAllFull, ingestSignals, DEFAULT_ARTISTS } from './artsy.js';

const db = openDb();
const all = process.argv.includes('--all') || process.env.ALL === '1';

if (all) {
  console.log('Full ingest: walking every Artsy artist with auction results (resumable).');
  const result = await ingestAllFull({ db });
  const elapsed = `${(result.elapsedMs / 1000).toFixed(0)}s`;
  console.log(
    `Discovered ${result.discovered} artist(s) with auction results; ingested ${result.artistsIngested} artist(s) this run.`,
  );
  console.log(`Fetched ${result.fetched} realized sales; inserted ${result.inserted} new rows.`);
  console.log(
    `Artists queued: ${result.done} done, ${result.pending} pending, ${result.failed} failed; discovery ${
      result.discoveryDone ? 'complete' : 'in progress'
    }.`,
  );
  console.log(`sales table now holds ${result.total} rows. Elapsed ${elapsed}.`);

  // Enrich the queued artists (including the zero-auction ones) with momentum signals.
  console.log('Enriching artist momentum signals (resumable)...');
  const signals = await ingestSignals({ db });
  console.log(
    `Stored ${signals.stored} artist signal snapshot(s) this run; ${signals.pending} pending, ${signals.queueDone} done, ${signals.queueFailed} failed.`,
  );
} else {
  console.log(`Ingesting realized auction sales for ${DEFAULT_ARTISTS.length} artists from Artsy...`);
  const result = await ingestAll({ db });
  console.log(`Fetched ${result.fetched} realized sales; inserted ${result.inserted} new rows.`);
  console.log(`sales table now holds ${result.total} rows.`);
}

db.close();
