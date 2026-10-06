# System-1 AI gate (Jev/Laya-style, powered by Groq)

The model does **not** analyse the market for you, and it does not write prose.
It **votes**. Every setup that passes the rules is handed to the model as a
compact "state" and it must answer with *only* a typed verdict:

```json
{ "take": "yes" | "no" | "noul",
  "direction": "buy" | "sell" | "neutral",
  "conviction": 0-100,
  "noul": "confirm" | "deny" | "uncertain" }
```

That is exactly what Jev (TypeSafe's paid "System 1" decision model) does, and
what Laya — its Apache-2.0 open clone
([convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya)) — does.
Laya itself cannot run in this deployment: nothing hosts it, and it needs
~1&nbsp;GB+ of RAM to serve, which the Render starter plan cannot afford. This
gate reproduces the behaviour on **Groq**, which is already always-on:

- temperature 0, `max_tokens` 120, and a system prompt that forbids chain of
  thought — the only thing it *can* emit is the verdict JSON;
- the reply is constrained with JSON-schema strict decoding, retried as plain
  JSON mode on models that reject the schema;
- it answers in well under a second, one call per accepted setup.

## Why a veto-gate and not "let the model trade"

The model picks a **side**, it never sizes, stops or targets. Entry, stop,
target, R:R, position size, profit-lock and the nightly logistic gate all stay
in the engine. The System-1 gate can only do two things: record an opinion
(`shadow`) or refuse a setup it is not decisively for (`on`). That bounds the
downside to "we skipped a trade", never "we took a worse one".

## The three modes

| Mode | What the verdict does |
|---|---|
| `off` | gate never called |
| `shadow` | verdict recorded in the signal metadata (SQLite + Mongo mirror), nothing blocked |
| `on` | setup REJECTED unless `take == "yes"` **and** direction agrees with the setup **and** `conviction >= SYSTEM1_CONVICTION_MIN` |

In `on` mode a rejection reads `system1 veto: no (deny)` /
`direction sell conflicts` / `conviction 42 < 60`.

## Coverage

The gate lives in the **Trader**, one level above any single strategy, so it
covers **every** strategy — the 6 NSE sources **and** the 4 gold **and** 4 ETH
24-hour traders. Gold/ETH strategies are pure rules (they never consult the
older WA-BOT text LLM); this is the first AI layer they see.

## Failure never blocks trading

- no key set → no opinion, quiet skip;
- call fails → `consecutiveErrors` grows; after 3 in a row the gate cools down
  for `SYSTEM1_COOLDOWN_MS` and skips cleanly;
- `SYSTEM1_MAX_PER_DAY` caps daily spend (a verdict per accepted setup is
  small, but the cap keeps an active week of setups bounded);
- any throw inside the gate is caught — a scan can never be slowed or blocked
  by the model being down or slow (`SYSTEM1_TIMEOUT_MS` bounds each call).

## Keys

- `SYSTEM1_API_KEY` — dedicated key for this gate only.
- `GROQ_API_KEY` — shared with the existing AI gate; the System-1 gate uses it
  when `SYSTEM1_API_KEY` is unset. Note it also turns the NSE text-LLM gate on
  (`aiConfigured`), because that is the same key the original router reads.

## Where the verdicts go

Every verdict is stored on the signal as `system1` in `signal_metadata`
(SQLite) and in the Mongo mirror — the future calibration set, exactly like
`modelScore`. `shadow` mode is the safe default: collect opinions now, compare
them to outcomes, flip to `on` only once a decisively-confirming threshold has
earned it on data.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `SYSTEM1_GATE_MODE` | `shadow` | `off` · `shadow` · `on` |
| `SYSTEM1_MODEL` | `openai/gpt-oss-120b` | any Groq-hosted model (`qwen/qwen3.8-27b`, `llama-3.3-70b-versatile`, …) |
| `SYSTEM1_CONVICTION_MIN` | `60` | minimum conviction for a pass in `on` |
| `SYSTEM1_TIMEOUT_MS` | `15000` | per-call bound |
| `SYSTEM1_MAX_PER_DAY` | `120` | daily call budget (0 = unlimited) |
| `SYSTEM1_COOLDOWN_MS` | `600000` | pause after 3 consecutive failures |
| `SYSTEM1_API_KEY` | unset | dedicated key (falls back to `GROQ_API_KEY`) |