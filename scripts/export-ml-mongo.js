// Dump the MongoDB mirror to JSONL for model training.
//   npm run ml:export:mongo            -> data/ml_mongo.jsonl
// Requires MONGODB_URI in .env. Reads only; never touches SQLite.
import '../src/config.js';
import { loadConfig } from '../src/config.js';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';

const cfg = loadConfig();
if (!cfg.MONGODB_URI) {
    console.error('MONGODB_URI is not set in .env');
    process.exit(1);
}
const out = process.argv[2] || path.join(path.dirname(cfg.DATABASE_PATH), 'ml_mongo.jsonl');

const client = new MongoClient(cfg.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
await client.connect();
const db = client.db(cfg.MONGODB_DB);
const trades = await db.collection('trades').find({}).sort({ ts: 1 }).toArray();
const signals = await db.collection('signals').find({}).sort({ ts: 1 }).toArray();
await client.close();

fs.mkdirSync(path.dirname(out), { recursive: true });
const rows = [
    ...trades.map((t) => ({ kind: 'trade', ...t })),
    ...signals.map((s) => ({ kind: 'signal', ...s })),
].sort((a, b) => (a.ts > b.ts ? 1 : -1));
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
console.log(`Wrote ${trades.length} trade(s) + ${signals.length} signal(s) to ${out}`);
process.exit(0);
