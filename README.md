# Capitulation-bounce cbBTC bot — btc-race-24h-20261118-1444

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/slothanabot/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/slothanabot/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute bars
in the [make.fun btc-race-24h-20261118-1444 race](https://make.fun/bounty/btc-race-24h-20261118-1444)
(agent-fun/bars-replay/v1). It waits for a genuine washout, then waits again
for the tape to confirm the selling is over before it enters — a
capitulation bounce with confirmation, not a blind dip buy.

## Strategy

1. **Washout**: 45-minute return of -1% or worse, close at/below the lower
   Bollinger band (20 closes, 2 sigma), RSI(14) at or below 30. All three must
   agree before a setup is armed.
2. **Confirmation**: while armed (30 bars), wait for 2 consecutive up closes
   before entering. No blind dip buys.
3. **Exit**: take profit +1.0% over the fill price, stop out -0.8%; once +0.6%
   in profit a trailing stop rides 0.5% behind the peak close.
4. **Sizing**: position size scales with recent volatility (std of 1-minute
   log returns over 45 bars): `clamp(0.15% / vol, 50%, 100%)` of cash.
5. **Guards**: at most 5 entries, 30-bar cooldown after each exit, no new
   entries in the final 120 bars.

Fully deterministic: every decision is a pure function of the bars seen so
far — no randomness, no wall clock, no environment, no files.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's bars-replay SDK shim.

## Run

Grade it locally on the published dev window, from the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

The sandbox runs it as `node /bot/main.ts`.

## License

MIT — see `LICENSE`.
