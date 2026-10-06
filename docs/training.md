# Self-tuning (the nightly trainer)

PaperTrader can retrain itself once a day from its own closed trades — no
extra service, no cloud, no external model. It fits a small logistic
regression gate in-process and hot-swaps it into the decision path.

## What runs

At `ML_TRAIN_HOUR_IST` (default **03:00 IST**) the engine takes every closed
trade, joins it back to the signal that produced it, and rebuilds the exact
16-number feature vector the decision saw at the time:

| group   | features                                                              |
|---------|-----------------------------------------------------------------------|
| setup   | reward:risk offered, stop distance %, direction, setup score, confluence |
| time    | IST hour + day-of-week as sine/cosine pairs                            |
| venue   | one-hot gold / ETH / NSE                                               |
| bars    | `hasBars`, vol (stdev of log returns), trend %, position in range      |

Labels are real: `net_pnl > 0`. The same `featuresFor()` function is used
live (to score a setup) and at training time (to re-score a closed trade), so
nothing the gate sees in production is different from what it was trained on.

## Safety rails (why this cannot hurt live trading)

1. **It refuses to run below `ML_MIN_TRADES`=100 closed trades.** Training on
   a handful of outcomes memorises them. Until the sample exists the nightly
   run logs `not enough closed trades: N / 100` and writes nothing.
2. **Promotion requires a forward-chaining test, not a fit.** Trades are
   split chronologically 70/30; the model is trained only on the earlier 70%
   and measured on the later 30% it never saw. It is promoted only when all
   of:
   - test accuracy ≥ `ML_MIN_ACC` (0.55);
   - the trades it would veto LOST money in aggregate (a gate that rejects
     winners destroys value faster than no gate);
   - it beats the incumbent model's test accuracy (a re-run of the same data
     is automatically held back).
3. **The gate never blocks anything.** Without a promoted model there is no
   opinion at all. In `ML_GATE_MODE=shadow` (default) every accepted setup is
   scored and stored but never vetoed. Flip to `on` only after watching the
   scores: then a setup scoring below `ML_GATE_THRESHOLD` is rejected like any
   other gate. Every scoring call is wrapped so a bad row degrades to "no
   opinion" instead of an error.
4. **Models never touch open trades.** The gate only scores *new* decisions,
   so a hot-swap is inherently mid-trade-safe.
5. **History survives.** Every run (promoted or not) is written to
   `model_versions` in SQLite; pruning keeps the last `ML_KEEP_VERSIONS` runs
   *plus* whatever model is currently in force, so a string of failed nights
   can never evict the one good model.

## Dashboard

`/api/health` → `ml` and `/api/config` → `ml` expose the mode, whether a model
is in force, and the last run's decision with its reason. The Risk & Config
page shows the same.

## Knobs (all in `.env`)

| variable             | default | meaning                                        |
|----------------------|---------|------------------------------------------------|
| `ML_TRAIN_ENABLED`   | true    | master switch (keep on — it self-limits)       |
| `ML_TRAIN_HOUR_IST`  | 3       | hour of the daily run                          |
| `ML_MIN_TRADES`      | 100     | refuse below this many closed trades           |
| `ML_MIN_TEST`        | 20      | refuse if either window is smaller             |
| `ML_MIN_ACC`         | 0.55    | minimum walk-forward test accuracy             |
| `ML_GATE_MODE`       | shadow  | off / shadow (score only) / on (veto)          |
| `ML_GATE_THRESHOLD`  | 0.45    | score below which `on` mode rejects            |
| `ML_KEEP_VERSIONS`   | 12      | model history kept after pruning               |

## Where the code lives

- `src/ml/logreg.js`   — dependency-free L2 logistic regression + AUC/log-loss
- `src/ml/features.js` — the 16-value vector (decision- and training-time)
- `src/ml/trainer.js`  — build the dataset, walk-forward split, promote/refuse
- `src/ml/gate.js`     — the read-only scoring used at decision time
- `src/engine/engine.js` — daily `trainer` loop + in-memory model hot-swap
- `src/engine/trader.js` — the gate applied to accepted setups pre-record