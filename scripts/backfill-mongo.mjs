// One-off backfill: mirror the local SQLite's current signals + trades into the
// Mongo Atlas mirror, in the SAME document shapes the live engine pushes. Tags
// every backfilled doc with backfilled:true. Open positions land in trades with
// status:'OPEN' and null exit fields.
import { MongoClient } from 'mongodb';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { signalText, tradeText } from '../src/db/mongo.js';

dotenv.config();
const uri = process.env.MONGODB_URI;
if (!uri) {
    console.log('no MONGODB_URI in .env — nothing pushed');
    process.exit(0);
}

const db = new DatabaseSync('data/papertrader.db', { readOnly: true });
const parse = (v) => {
    try {
        return v ? JSON.parse(v) : null;
    } catch {
        return null;
    }
};
const strats = new Map();
for (const r of db.prepare('SELECT id, code, key FROM strategies').all()) strats.set(r.id, r);

const sigs = db.prepare('SELECT * FROM signals ORDER BY id').all();
const sigDocs = sigs.map((s) => {
    const meta = parse(s.signal_metadata) || {};
    const doc = {
        ts: s.timestamp,
        sessionDate: s.session_date,
        strategyCode: meta.strategyCode ?? strats.get(s.strategy_id)?.code ?? null,
        source: meta.source ?? strats.get(s.strategy_id)?.key ?? null,
        symbol: s.symbol,
        direction: s.direction ?? null,
        signalType: s.signal_type,
        status: s.status,
        price: s.price ?? null,
        reason: s.reject_reason ?? null,
        filterCondition: s.filter_condition ?? null,
        setup: meta.setup ?? null,
        confluence: meta.confluence ?? null,
        ai: meta.ai ?? null,
        aiMode: meta.aiMode ?? null,
        softGate: Boolean(meta.softGate),
        isHiddenGem: Boolean(meta.isHiddenGem),
        modelScore: meta.modelScore ?? null,
        system1: meta.system1 ?? null,
        featureBars: meta.featureBars ?? null,
        option: null,
        underlying: null,
        backfilled: true,
    };
    doc.text = signalText(doc);
    return doc;
});

const toTradeDoc = (t, closed) => {
    const meta = parse(t.signal_metadata) || {};
    const risk = Math.abs(Number(t.entry_price) - Number(t.initial_stop));
    const sgn = t.direction === 'LONG' ? 1 : t.direction === 'SHORT' ? -1 : 0;
    const rMultiple =
        closed && risk > 0 && t.exit_price != null
            ? Math.round(((Number(t.exit_price) - Number(t.entry_price)) * sgn) / risk * 100) / 100
            : null;
    const doc = {
        ts: t.entry_time,
        exitTime: closed ? t.exit_time : null,
        strategyCode: meta.strategyCode ?? strats.get(t.strategy_id)?.code ?? null,
        source: meta.source ?? strats.get(t.strategy_id)?.key ?? null,
        symbol: t.symbol,
        direction: t.direction,
        quantity: t.quantity,
        entry: t.entry_price,
        exitPrice: closed ? t.exit_price : null,
        stop: t.initial_stop,
        target: t.target_price,
        netPnl: closed ? t.net_pnl : null,
        grossPnl: closed ? t.gross_pnl : null,
        fees: closed ? t.fees : null,
        exitReason: closed ? t.exit_reason : null,
        holdingSeconds: closed ? t.holding_seconds : null,
        rMultiple,
        win: closed && t.net_pnl != null ? t.net_pnl > 0 : null,
        setup: meta.setup ?? null,
        confluence: meta.confluence ?? null,
        ai: meta.ai ?? null,
        filterCondition: t.filter_condition ?? null,
        featureBars: meta.featureBars ?? null,
        backfilled: true,
    };
    doc.text = closed ? tradeText(doc) : `${doc.strategyCode ?? ''} ${doc.source ?? ''} | ${doc.direction === 'LONG' ? 'BUY' : 'SELL'} ${t.symbol} entry ${t.entry_price} OPEN`.trim();
    if (!closed) doc.status = 'OPEN';
    return doc;
};

const closed = db.prepare("SELECT * FROM trades WHERE status='CLOSED' ORDER BY id").all();
const open = db.prepare("SELECT * FROM trades WHERE status='OPEN' ORDER BY id").all();
const tradeDocs = [...closed.map((t) => toTradeDoc(t, true)), ...open.map((t) => toTradeDoc(t, false))];

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await client.connect();
try {
    const paper = client.db('papertrader');
    const push = async (col, docs) => {
        if (!docs.length) return 0;
        const r = await paper.collection(col).insertMany(docs, { ordered: false });
        return r.insertedCount;
    };
    const ns = await push('signals', sigDocs);
    const nt = await push('trades', tradeDocs);
    console.log(`Mirrored to Mongo 'papertrader': signals +${ns} docs, trades +${nt} docs (${closed.length} closed, ${open.length} open).`);
} finally {
    await client.close();
}