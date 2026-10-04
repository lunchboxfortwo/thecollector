import { openDb } from './db.js';
import { ingestAll, DEFAULT_ARTISTS } from './artsy.js';

const db = openDb();

console.log(`Ingesting realized auction sales for ${DEFAULT_ARTISTS.length} artists from Artsy...`);
const result = await ingestAll({ db });
console.log(`Fetched ${result.fetched} realized sales; inserted ${result.inserted} new rows.`);
console.log(`sales table now holds ${result.total} rows.`);

db.close();
