import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore, signalText, tradeText } from '../src/db/mongo.js';
import { nullLogger } from '../src/logger.js';

test('mongo mirror is a no-op without a URI', async () => {
    const m = new MongoStore({ uri: '', logger: nullLogger });
    assert.equal(m.enabled, false);
    m.push('signals', { hello: 'world' }); // must not throw
    await m.flush(); // must not throw
    await m.close();
});

test('signal text summarises the decision for future embeddings', () => {
    const t = signalText({
        strategyCode: 'Strategy-07', source: 'gold_sweep', symbol: 'XAUUSD',
        direction: 'LONG', status: 'ACCEPTED',
        setup: { entry: 4160, stop: 4145, target: 4200, score: 75, checks: { sweepLow: true } },
        confluence: 70,
    });
    assert.match(t, /Strategy-07/);
    assert.match(t, /BUY XAUUSD @ 4160/);
    const w = signalText({ strategyCode: 'Strategy-07', source: 'gold_sweep', symbol: 'XAUUSD', direction: null, status: 'WATCH', setup: null, reason: 'no setup' });
    assert.match(w, /watch/);
});

test('trade text summarises the outcome label', () => {
    const t = tradeText({
        strategyCode: 'Strategy-07', source: 'gold_sweep', symbol: 'XAUUSD',
        direction: 'SHORT', entry: 4166, exitPrice: 4126, netPnl: 2000, rMultiple: 2.6,
        exitReason: 'TARGET', holdingSeconds: 1800,
    });
    assert.match(t, /SELL XAUUSD/);
    assert.match(t, /WIN/);
});
