// Capitulation-bounce bot for cbBTC/USDC (agent-fun/bars-replay/v1).
//
// Idea: Bitcoin on Solana drifts in small steps most of the day, but every so
// often it washes out hard in under an hour and then snaps back. This bot does
// NOT buy the dip blind. It waits for a genuine washout, then waits again for
// the tape to prove the selling is over before it enters.
//
//   1. WASHOUT: the 45-minute return is -1% or worse, the close is at/below
//      the lower Bollinger band (20 closes, 2 sigma) and RSI(14) is 30 or
//      lower. All three must agree: a fast fall, an extreme price, and
//      exhausted momentum. When they do, the setup is ARMED.
//   2. CONFIRMATION: while armed (30 bars), the bot needs 2 consecutive up
//      closes. The first up bar after a washout is often a dead-cat flicker;
//      the second one says buyers are actually stepping in. Only then it buys.
//   3. EXIT: take profit at +1.0% over the fill price, stop out at -0.8%.
//      Once +0.6% in profit a trailing stop rides behind the peak at 0.5%,
//      so a bounce that keeps running is not cut off at the take-profit line
//      while a bounce that rolls over is banked instead of given back.
//   4. SIZING: position size scales with recent volatility (std of 1-minute
//      log returns over 45 bars): size = clamp(0.15% / vol, 50%, 100%) of
//      cash. Calm tape -> full size; wild tape -> half size.
//   5. GUARDS: at most 5 entries, a 30-bar cooldown after each exit, and no
//      new entries in the final 120 bars (a bounce needs room to play out
//      before the window flattens everything).
//
// Fully deterministic: every decision is a pure function of the bars seen so
// far. No randomness, no wall clock, no environment, no files.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (tuned on the published dev window only) ---
const WASH_LOOKBACK = 45; // bars for the washout return
const WASH_DROP = 0.01; // 45-bar return <= -1%
const BB_PERIOD = 20; // Bollinger band length
const BB_MULT = 2.0; // Bollinger band width in sigmas
const RSI_PERIOD = 14; // RSI length
const RSI_MAX = 30; // washout needs RSI at or below this
const CONFIRM_BARS = 2; // consecutive up closes needed to enter
const ARM_TTL = 30; // bars an armed setup stays live
const TAKE_PROFIT = 0.01; // +1.0% over fill price
const STOP_LOSS = 0.008; // -0.8% under fill price
const TRAIL_ARM = 0.006; // trailing stop activates at +0.6%
const TRAIL_GAP = 0.005; // trail 0.5% behind the peak close
const MAX_ENTRIES = 5; // at most 5 round trips
const COOLDOWN_BARS = 30; // bars to wait after an exit
const NO_ENTRY_TAIL = 120; // no new entries in the final 120 bars
const WINDOW_BARS = 1440; // bars in the window
const MAX_SLIPPAGE_BPS = 200; // 2% from the latest close
const VOL_TARGET = 0.0015; // sizing: 0.15% per-bar vol -> full size
const MIN_SIZE_FRAC = 0.5; // never size below half the cash
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in micro-USDC

interface Setup {
  armed: boolean;
  armSeq: number;
  upStreak: number;
}

function bollingerLower(closes: number[]): number | null {
  if (closes.length < BB_PERIOD) return null;
  const window = closes.slice(closes.length - BB_PERIOD);
  let sum = 0;
  for (const c of window) sum += c;
  const mean = sum / BB_PERIOD;
  let sq = 0;
  for (const c of window) sq += (c - mean) * (c - mean);
  const sd = Math.sqrt(sq / BB_PERIOD);
  return mean - BB_MULT * sd;
}

function rsi14(closes: number[]): number | null {
  if (closes.length < RSI_PERIOD + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let k = closes.length - RSI_PERIOD; k < closes.length; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function vol45(closes: number[]): number | null {
  if (closes.length < WASH_LOOKBACK + 1) return null;
  const rets: number[] = [];
  for (let k = closes.length - WASH_LOOKBACK; k < closes.length; k++) {
    rets.push(Math.log(closes[k] / closes[k - 1]));
  }
  let sum = 0;
  for (const r of rets) sum += r;
  const mean = sum / rets.length;
  let sq = 0;
  for (const r of rets) sq += (r - mean) * (r - mean);
  return Math.sqrt(sq / rets.length);
}

async function main(): Promise<void> {
  const closes: number[] = [];
  const setup: Setup = { armed: false, armSeq: 0, upStreak: 0 };
  let entryPx: number | null = null; // fill price of the open position (raw units)
  let peakPx = 0; // highest close since entry
  let entries = 0; // round trips started
  let cooldownUntil = -1; // seq before which no new entry

  await runBars({
    onBatch(state: BarsState, batch: Batch) {
      const bar = batch.bars.find((b) => b.symbol === SYMBOL);
      // Fold fills first: they tell us our real entry/exit prices.
      for (const fill of batch.fills) {
        if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
        if (fill.side === 'buy') {
          entryPx = Number(fill.price);
          peakPx = entryPx;
        } else if (fill.side === 'sell') {
          entryPx = null;
          cooldownUntil = batch.seq + COOLDOWN_BARS;
        }
      }
      if (bar === undefined) return [];

      const close = Number(bar.c);
      closes.push(close);
      const n = closes.length;
      if (n < 2) return [];

      const pos = state.positions.get(SYMBOL);
      const qty = pos === undefined ? 0n : pos.qty;

      // --- manage an open position: exit on take-profit, stop, or trail ---
      if (qty > 0n && entryPx !== null) {
        if (close > peakPx) peakPx = close;
        const gain = close / entryPx - 1;
        let exit = false;
        if (gain >= TAKE_PROFIT) exit = true;
        else if (gain <= -STOP_LOSS) exit = true;
        else if (gain >= TRAIL_ARM && close <= peakPx * (1 - TRAIL_GAP)) exit = true;
        if (exit) {
          return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }

      // --- flat: look for a washout, then wait for confirmation ---
      if (entries >= MAX_ENTRIES) return [];
      if (batch.seq >= WINDOW_BARS - NO_ENTRY_TAIL) return [];
      if (batch.seq < cooldownUntil) return [];
      if (n < WASH_LOOKBACK + 1) return [];

      const ret45 = close / closes[n - 1 - WASH_LOOKBACK] - 1;
      const lower = bollingerLower(closes);
      const rsi = rsi14(closes);
      const up = close > closes[n - 2];

      if (!setup.armed) {
        const washout =
          ret45 <= -WASH_DROP && lower !== null && close <= lower && rsi !== null && rsi <= RSI_MAX;
        if (!washout) return [];
        setup.armed = true;
        setup.armSeq = batch.seq;
        setup.upStreak = 0;
      }

      if (batch.seq - setup.armSeq > ARM_TTL) {
        setup.armed = false;
        setup.upStreak = 0;
        return [];
      }
      if (up) setup.upStreak += 1;
      else setup.upStreak = 0;
      if (setup.upStreak < CONFIRM_BARS) return [];

      // Confirmed bounce: size by recent volatility and buy.
      setup.armed = false;
      setup.upStreak = 0;
      const vol = vol45(closes);
      let frac = 1;
      if (vol !== null && vol > 0) frac = Math.min(1, Math.max(MIN_SIZE_FRAC, VOL_TARGET / vol));
      let notional = BigInt(Math.floor(Number(state.cash) * frac));
      const room = state.weightRoom(SYMBOL);
      if (notional > room) notional = room;
      if (notional > state.cash) notional = state.cash;
      if (notional < MIN_NOTIONAL) return [];
      entries += 1;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    },
  });
}

await main();
