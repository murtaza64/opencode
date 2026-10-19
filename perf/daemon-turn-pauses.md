# Provider-turn daemon pauses (#203)

2026-10-19, macOS arm64, Bun 1.3.14. Baseline: `4cf19`.

- Live read-only probe: health, capabilities, session, five latest messages, todos, and status stalled together for 1.03s; dashboard/static responses stayed below 35ms.
- Private reproduction: real CLI, eight Sessions, 400 synthetic user messages per Session (~2 MB each), three parallel prompt waves, loopback fake provider, health polling every 20ms. All 24 provider requests completed.
- JSC sampling identified `ProviderTransform.message → normalizeMessages → sanitizeSurrogates` and its lookbehind regex: 234 samples, versus 39 in JSON parsing and 36 in SQLite `values`. History-read-only profiling did not reproduce the provider-turn pause.
- Replace that regex with native `String.toWellFormed()`. The UTF-16 replacement contract is unchanged.

- Eight sanitizations, 2.7M ASCII characters each: 386.9ms before (failed 100ms budget), 0.035ms after (passed).
- Maximum health latency, 400 messages/Session: 501–808ms before, 144ms after.
- Maximum health latency, 800 messages/Session: 303ms after; baseline not measured.
- Installed baseline executable, launched privately without profiling: maximum health latency 653ms (failed 500ms budget).
- Compiled candidate, 400 messages/Session, three private runs without profiling: maximum health latencies 381/410/349ms (passed). Each run completed 24 fake-provider turns; isolation and cleanup checks passed.

These are local diagnostic maxima, not production percentiles. HTTP measurements include startup/JIT effects; the fixed 800-message run had no profiler. Production improvement still requires a coordinated candidate deployment and live soak.

## Reproduce the blocking path

From `packages/opencode`:

```sh
bun run script/bench-provider-sanitization.ts
bun test test/provider/transform.test.ts
```

The benchmark calls the actual sanitizer and fails above a local 100ms budget. It is not a machine-independent CI threshold. Unicode cases cover lone high/low surrogates, adjacent malformed sequences, BMP text, and valid pairs; the existing message test exercises all model-visible text positions.

Private HTTP runs used explicit verified nonproduction ports, private HOME/XDG/DB/config, and a fake provider. Before requests, the reported URL, listener PID, open DB path, production listener PID, and production DB inode were checked. Owned children were terminated with bounded cleanup and their listeners checked absent. No live transcript was copied, no provider calls were sent to production, and no live daemon was restarted. Temporary profiling instrumentation was removed.
