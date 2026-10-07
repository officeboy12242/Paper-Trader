import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
try {
    await client.connect();
    const db = client.db('papertrader');
    const counts = await Promise.all([db.collection('signals').countDocuments(), db.collection('trades').countDocuments()]);
    console.log(`mongo totals — signals: ${counts[0]}, trades: ${counts[1]}`);
    const open = await db.collection('trades').find({ status: 'OPEN' }).toArray();
    console.log('mirrored OPEN trades (first 15):');
    for (const d of open.slice(0, 15)) console.log(`  ${d.symbol} | ${d.direction} | entry ${d.entry} | stop ${d.stop} | target ${d.target} | ${d.strategyCode} | backfilled: ${Boolean(d.backfilled)}`);
    const hpe = await db.collection('trades').find({ symbol: /HIDEF|HDFC|PES|PE-/ }).limit(5).toArray();
    console.log('any HDFC/PE rows:');
    for (const d of hpe) console.log(`  symbol=${d.symbol} status=${d.status ?? 'n/a'} exitReason=${d.exitReason} entry=${d.entry} strategyCode=${d.strategyCode}`);
    // exact-match the open 700 PE row
    const ex = await db.collection('trades').find({ symbol: 'OPT-HDFCBANK-700-PE' }).toArray();
    console.log(`exact match OPT-HDFCBANK-700-PE docs: ${ex.length}`);
    for (const d of ex) console.log(`  status=${d.status ?? 'n/a'} | entry=${d.entry} | stop=${d.stop} | target=${d.target} | text: ${d.text?.slice(0, 90)}`);
} finally {
    await client.close();
}