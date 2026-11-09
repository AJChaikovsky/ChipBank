// Settlement math. The server (finalize_game in the SQL migration) is the source
// of truth; this file mirrors it exactly so the app can preview results, and so
// the algorithm can be property-tested. All amounts are integer cents.

export type TxnType = 'buy_in' | 'rebuy' | 'cash_out' | 'adjustment';

export type Txn = {
  game_player_id: string;
  type: TxnType;
  amount_cents: number;
  voided_at?: string | null;
};

export type Net = { playerId: string; cents: number }; // positive = is owed money
export type Transfer = { from: string; to: string; cents: number };

export type PlayerTotals = {
  playerId: string;
  buyInCents: number;
  cashOutCents: number; // includes adjustments
  netCents: number;
};

/** Sum the live (non-voided) ledger per player. */
export function totalsByPlayer(playerIds: string[], txns: Txn[]): PlayerTotals[] {
  const map = new Map<string, PlayerTotals>();
  for (const id of playerIds) map.set(id, { playerId: id, buyInCents: 0, cashOutCents: 0, netCents: 0 });
  for (const t of txns) {
    if (t.voided_at) continue;
    const row = map.get(t.game_player_id);
    if (!row) continue;
    if (t.type === 'buy_in' || t.type === 'rebuy') row.buyInCents += t.amount_cents;
    else row.cashOutCents += t.amount_cents;
  }
  for (const row of map.values()) row.netCents = row.cashOutCents - row.buyInCents;
  return [...map.values()];
}

const byAmountThenId = (a: Net, b: Net) =>
  b.cents - a.cents || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);

/**
 * Biggest debtor pays biggest creditor until everyone is square.
 * Produces at most (players with nonzero net − 1) transfers.
 * Throws if nets don't sum to zero: settle only a balanced ledger.
 */
export function settle(nets: Net[]): Transfer[] {
  const total = nets.reduce((s, n) => s + n.cents, 0);
  if (total !== 0) throw new Error(`Nets must sum to zero (off by ${total})`);
  for (const n of nets) if (!Number.isSafeInteger(n.cents)) throw new Error('Amounts must be integer cents');

  const creditors = nets.filter(n => n.cents > 0).map(n => ({ ...n })).sort(byAmountThenId);
  const debtors = nets.filter(n => n.cents < 0).map(n => ({ ...n, cents: -n.cents })).sort(byAmountThenId);

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].cents, creditors[j].cents);
    transfers.push({ from: debtors[i].playerId, to: creditors[j].playerId, cents: amt });
    debtors[i].cents -= amt;
    creditors[j].cents -= amt;
    if (debtors[i].cents === 0) i++;
    if (creditors[j].cents === 0) j++;
  }
  return transfers;
}

/** "Pay the host" mode: every player settles directly with the host. */
export function settleWithHost(nets: Net[], hostId: string): Transfer[] {
  const total = nets.reduce((s, n) => s + n.cents, 0);
  if (total !== 0) throw new Error(`Nets must sum to zero (off by ${total})`);
  return nets
    .filter(n => n.playerId !== hostId && n.cents !== 0)
    .map(n => (n.cents < 0
      ? { from: n.playerId, to: hostId, cents: -n.cents }
      : { from: hostId, to: n.playerId, cents: n.cents }));
}

/**
 * When the cash-outs don't match the buy-ins (a miscounted stack), spread the
 * difference across players by buy-in. Uses largest-remainder rounding so the
 * adjustments are whole cents and sum exactly to −diff.
 * Returns playerId → adjustment cents (only nonzero entries).
 */
export function proportionalAdjustments(totals: PlayerTotals[]): Map<string, number> {
  const totalIn = totals.reduce((s, t) => s + t.buyInCents, 0);
  const totalOut = totals.reduce((s, t) => s + t.cashOutCents, 0);
  const target = -(totalOut - totalIn);
  const out = new Map<string, number>();
  if (target === 0 || totalIn === 0) return out;

  // exact share = target * in / totalIn. Work in integers: floor via BigInt-safe math.
  const rows = totals
    .filter(t => t.buyInCents > 0)
    .map(t => {
      const num = target * t.buyInCents; // safe for realistic stakes (< 2^53)
      const fl = Math.floor(num / totalIn);
      const fracNum = num - fl * totalIn; // in [0, totalIn): fractional part × totalIn
      return { id: t.playerId, fl, fracNum };
    });
  const remainder = target - rows.reduce((s, r) => s + r.fl, 0);
  rows.sort((a, b) => b.fracNum - a.fracNum || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  rows.forEach((r, idx) => {
    const adj = r.fl + (idx < remainder ? 1 : 0);
    if (adj !== 0) out.set(r.id, adj);
  });
  return out;
}

/** Ledger balance: positive means more chips came out than went in. */
export function ledgerDiff(totals: PlayerTotals[]): number {
  return totals.reduce((s, t) => s + t.cashOutCents - t.buyInCents, 0);
}

// ───────────────────────────────────────────────────────── money helpers ──

export function formatCents(cents: number, opts: { sign?: boolean } = {}): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = abs % 100;
  const body = rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, '0')}`;
  if (neg) return `−${body}`;
  if (opts.sign && cents > 0) return `+${body}`;
  return body;
}

/** Parse "40", "$40.5", "40.25" into cents. Returns null if invalid. */
export function parseDollars(input: string): number | null {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Elapsed game time, computed on each device from stored timestamps. */
export function elapsedMs(game: {
  started_at: string | null;
  ended_at?: string | null;
  paused_at: string | null;
  total_paused_ms: number;
}, now: number = Date.now()): number {
  if (!game.started_at) return 0;
  const end = game.ended_at ? Date.parse(game.ended_at) : game.paused_at ? Date.parse(game.paused_at) : now;
  return Math.max(0, end - Date.parse(game.started_at) - game.total_paused_ms);
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
