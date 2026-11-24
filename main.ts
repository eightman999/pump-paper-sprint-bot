// Momentum-entry, disciplined-exit bot for the pump.fun replay.
//
// Entry: a coin becomes watchable at its CreateEvent. Once its real SOL reserve has grown to at
// least MIN_RESERVE_LAMPORTS from zero AND the flow over its last FLOW_TRADES trades is net-buying
// (more buys than dust, buy SOL >= 1.25x sell SOL), it is a candidate. Candidates are ranked by net
// inflow and bought for STAKE_LAMPORTS, bounded by state.maxBuyLamports (the per-reply share-of-
// reserve cap) and by free cash minus the tx fee. One entry per coin, at most
// hello.caps.max_open_positions open at once.
//
// Exit: every batch each held position is marked to market off the latest reserves (batch.marks
// for held mints, else the curve's last trade reserves). Selling t tokens into the constant-
// product curve returns t*vq/(vt+t) quote before fees; the estimated net proceeds subtract the
// curve fee share (protocol + creator fallback bps) and one tx fee. A position is sold whole when
// that estimate reaches +TAKE_PROFIT of cost or drops to -STOP_LOSS of cost. Take-profit sells go
// out at SELL_TP_SLIPPAGE_BPS; stop-loss sells at full slippage so the exit is never refused while
// a coin keeps falling. A curve that completes is closed by the harness itself (_complete_ fills);
// a sell then would only be rejected token_complete.
//
// Never orders what the caps refuse: buys are clamped to maxBuyLamports, the reply never exceeds
// max_orders_per_batch, positions never exceed max_open_positions, and each buy must fit in free
// cash with its tx fee. Deterministic: no clock, no randomness; all decisions come from the batch
// stream.

import { LAMPORTS_PER_SOL, runBot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 100n; // 0.08 SOL target per position
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 11n) / 1000n; // 0.011 SOL; above the 0.01 round-trip bar
const MIN_RESERVE_LAMPORTS = 2n * LAMPORTS_PER_SOL; // entry needs real SOL reserve >= 2
const MAX_RESERVE_LAMPORTS = 60n * LAMPORTS_PER_SOL; // skip curves this far along (near completion)
const FLOW_TRADES = 25; // recent-flow window, in trades
const MIN_WINDOW_BUYS = 3; // buys required inside the window
const BUY_SLIPPAGE_BPS = 10_000; // wide open like the baseline: a refused buy just skips the coin
const TP_SLIPPAGE_BPS = 5_000; // take-profit sells: fills unless the price halved in latency
const SL_SLIPPAGE_BPS = 10_000; // stop-loss sells: never refused, the exit matters more than the price
const BPS = 10_000n;

interface Watched {
  /** The mint's last FLOW_TRADES trades, oldest first. */
  tape: { buy: boolean; sol: bigint }[];
}

const watched = new Map<Pubkey, Watched>();
/** Mints a buy of ours filled on: one entry per coin ever. */
const entered = new Set<Pubkey>();

const watch = (mint: Pubkey): Watched => {
  let w = watched.get(mint);
  if (w === undefined) {
    w = { tape: [] };
    watched.set(mint, w);
  }
  return w;
};

await runBot({
  onBatch(state, batch) {
    const { caps, fees } = state.hello;
    const orderCap = caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const feeBps = BigInt(fees.protocol_bps_fallback) + BigInt(fees.creator_bps_fallback);

    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled' && !f.client_id.startsWith('_')) entered.add(f.mint);
    }

    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        watch(e.mint);
      } else if (e.event === 'TradeEvent') {
        const w = watch(e.mint);
        w.tape.push({ buy: e.is_buy, sol: BigInt(e.sol_amount) });
        if (w.tape.length > FLOW_TRADES) w.tape.shift();
        traded.add(e.mint);
      }
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const busy = new Set<Pubkey>();
    for (const p of state.pending.values()) busy.add(p.order.mint);

    const orders: OrderInput[] = [];

    // Exits first: they free cash and slots for later batches.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= orderCap) break;
      if (busy.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      if (vt + pos.token_amount === 0n) continue;
      // Constant-product sell quote: tokens * vq / (vt + tokens), minus curve fee share and tx fee.
      const gross = (pos.token_amount * vq) / (vt + pos.token_amount);
      const net = (gross * (BPS - feeBps)) / BPS - tx;
      const cost = pos.cost_lamports;
      let slip = -1;
      if (net * 100n >= cost * 160n) slip = TP_SLIPPAGE_BPS;
      else if (net * 100n <= cost * 75n) slip = SL_SLIPPAGE_BPS;
      if (slip < 0) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: slip });
      busy.add(mint);
    }

    // Entries: coins that traded this batch and now show early strength.
    const cands: { mint: Pubkey; netFlow: bigint }[] = [];
    for (const mint of traded) {
      if (entered.has(mint) || busy.has(mint) || state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const rq = curve.real_quote_reserves;
      if (rq < MIN_RESERVE_LAMPORTS || rq > MAX_RESERVE_LAMPORTS) continue;
      const w = watched.get(mint)!;
      let buySol = 0n;
      let sellSol = 0n;
      let buys = 0;
      for (const t of w.tape) {
        if (t.buy) {
          buySol += t.sol;
          buys++;
        } else sellSol += t.sol;
      }
      const netFlow = buySol - sellSol;
      if (buys < MIN_WINDOW_BUYS || netFlow <= 0n || buySol * 4n < sellSol * 5n) continue;
      cands.push({ mint, netFlow });
    }
    cands.sort((a, b) => (a.netFlow > b.netFlow ? -1 : a.netFlow < b.netFlow ? 1 : 0));

    let free = state.freeCashLamports();
    let slotsLeft = caps.max_open_positions - state.committedPositionCount();
    for (const c of cands) {
      if (orders.length >= orderCap || slotsLeft <= 0) break;
      const sizeCap = state.maxBuyLamports(c.mint);
      let amount = STAKE_LAMPORTS < sizeCap ? STAKE_LAMPORTS : sizeCap;
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_LAMPORTS) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      busy.add(c.mint);
      free -= amount + tx;
      slotsLeft--;
    }

    return orders;
  },
});
