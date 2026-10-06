# MongoDB mirror — RAG dataset for the future AI project

SQLite remains the engine's source of truth. When `MONGODB_URI` is set in
`.env`, every signal and every closed trade is mirrored to MongoDB in the
background (buffered queue, 5s flush, failures only logged). Trading never
waits for MongoDB and works identically with the variable unset.

## Collections

### `signals` — every decision, including rejects and watchlist items

| Field | Contents |
|---|---|
| `ts` / `sessionDate` | decision time, IST session date |
| `strategyCode` / `source` / `symbol` / `direction` | who and what |
| `signalType` / `status` | SETUP / AI_DIRECTION / WATCH / ANALYSIS × ACCEPTED / REJECTED / WATCH / ERROR |
| `price` / `reason` / `filterCondition` | trigger price, gate reason, source filters |
| `setup` | entry, stop, target, target2, score, checks |
| `confluence` / `ai` / `aiMode` | gate context |
| `featureBars` | last ~90 1-minute bars (OHLCV) at decision time — the model input |
| `option` / `underlying` | ATM CE/PE leg picked for NSE signals |
| `text` | one-line human summary — **the future embedding input** |

### `trades` — closed trades with outcome labels

Same decision context plus `entry`, `exitPrice`, `stop`, `target`,
`netPnl`, `grossPnl`, `fees`, `exitReason`, `holdingSeconds`, `rMultiple`,
`win` (boolean label), and `text`.

## Indexes

Created automatically on connect: `{strategyCode, ts}`, `{symbol, ts}` on
signals; `{strategyCode, exitTime}`, `{symbol, exitTime}`, `{win}` on trades.

## Future vector search (Atlas)

1. Add an `embedding` array field per document (your embedding model writes it).
2. In Atlas UI → Database → Atlas Search → Create Search Index:
   ```json
   {
     "mappings": {
       "dynamic": false,
       "fields": {
         "embedding": { "type": "knnVector", "dimensions": 1536, "similarity": "cosine" },
         "strategyCode": { "type": "string" },
         "symbol": { "type": "string" },
         "win": { "type": "boolean" }
       }
     }
   }
   ```
3. Query example — "find losing liquidity sweeps that look like this setup":
   ```js
   db.trades.aggregate([{ $vectorSearch: {
     index: 'trades_vector', path: 'embedding',
     queryVector: emb(currentSetupText), numCandidates: 100, limit: 10,
     filter: { source: 'gold_sweep', win: false } } }])
   ```

## Export for training

```powershell
npm run ml:export:mongo        # -> data/ml_mongo.jsonl (trades + signals)
npm run ml:export              # -> SQLite-only export (no Mongo needed)
```

## Safety

- The URI is read only in `src/db/mongo.js`, never logged and never exposed
  via `/api/config` or any endpoint (covered by tests).
- Keep `MONGODB_URI` in `.env` (gitignored). Rotate it if it is ever pasted
  anywhere — including a chat window.
