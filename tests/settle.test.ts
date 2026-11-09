import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  elapsedMs, formatCents, formatDuration, ledgerDiff, parseDollars,
  proportionalAdjustments, settle, settleWithHost, totalsByPlayer, type Net,
} from '../src/lib/settle';

describe('settle', () => {
  it('handles the worked example from the plan', () => {
    // A: in 100 out 250 (+150). B: in 100 out 20 (−80). C: in 200 out 130 (−70).
    const t = settle([
      { playerId: 'A', cents: 15000 },
      { playerId: 'B', cents: -8000 },
      { playerId: 'C', cents: -7000 },
    ]);
    expect(t).toEqual([
      { from: 'B', to: 'A', cents: 8000 },
      { from: 'C', to: 'A', cents: 7000 },
    ]);
  });

  it('returns nothing when everyone breaks even', () => {
    expect(settle([{ playerId: 'A', cents: 0 }, { playerId: 'B', cents: 0 }])).toEqual([]);
    expect(settle([])).toEqual([]);
  });

  it('rejects unbalanced input', () => {
    expect(() => settle([{ playerId: 'A', cents: 100 }])).toThrow(/sum to zero/);
  });

  it('rejects non-integer cents', () => {
    expect(() => settle([{ playerId: 'A', cents: 0.5 }, { playerId: 'B', cents: -0.5 }])).toThrow(/integer/);
  });

  it('breaks ties by player id so output is deterministic', () => {
    const t = settle([
      { playerId: 'b', cents: 500 }, { playerId: 'a', cents: 500 },
      { playerId: 'd', cents: -500 }, { playerId: 'c', cents: -500 },
    ]);
    expect(t).toEqual([
      { from: 'c', to: 'a', cents: 500 },
      { from: 'd', to: 'b', cents: 500 },
    ]);
  });
});

// Arbitrary balanced nets: random amounts, then one player absorbs the total.
const balancedNets = fc
  .array(fc.integer({ min: -500_000, max: 500_000 }), { minLength: 1, maxLength: 12 })
  .map((amts): Net[] => {
    const nets = amts.map((c, i) => ({ playerId: `p${String(i).padStart(2, '0')}`, cents: c }));
    const total = nets.reduce((s, n) => s + n.cents, 0);
    nets.push({ playerId: 'zz', cents: -total });
    return nets;
  });

describe('settle properties', () => {
  it('leaves every player at exactly zero', () => {
    fc.assert(fc.property(balancedNets, nets => {
      const bal = new Map(nets.map(n => [n.playerId, n.cents]));
      for (const t of settle(nets)) {
        bal.set(t.from, bal.get(t.from)! + t.cents);
        bal.set(t.to, bal.get(t.to)! - t.cents);
      }
      for (const v of bal.values()) expect(v).toBe(0);
    }));
  });

  it('never has anyone pay themselves, and all amounts are positive integers', () => {
    fc.assert(fc.property(balancedNets, nets => {
      for (const t of settle(nets)) {
        expect(t.from).not.toBe(t.to);
        expect(t.cents).toBeGreaterThan(0);
        expect(Number.isInteger(t.cents)).toBe(true);
      }
    }));
  });

  it('uses at most (nonzero players − 1) transfers', () => {
    fc.assert(fc.property(balancedNets, nets => {
      const nonzero = nets.filter(n => n.cents !== 0).length;
      expect(settle(nets).length).toBeLessThanOrEqual(Math.max(0, nonzero - 1));
    }));
  });

  it('only losers pay and only winners receive', () => {
    fc.assert(fc.property(balancedNets, nets => {
      const sign = new Map(nets.map(n => [n.playerId, Math.sign(n.cents)]));
      for (const t of settle(nets)) {
        expect(sign.get(t.from)).toBe(-1);
        expect(sign.get(t.to)).toBe(1);
      }
    }));
  });

  it('pay-the-host mode also zeroes everyone out', () => {
    fc.assert(fc.property(balancedNets, nets => {
      const host = nets[0].playerId;
      const bal = new Map(nets.map(n => [n.playerId, n.cents]));
      for (const t of settleWithHost(nets, host)) {
        expect(t.from).not.toBe(t.to);
        bal.set(t.from, bal.get(t.from)! + t.cents);
        bal.set(t.to, bal.get(t.to)! - t.cents);
      }
      for (const v of bal.values()) expect(v).toBe(0);
    }));
  });
});

describe('ledger totals and adjustments', () => {
  it('ignores voided transactions and counts rebuys', () => {
    const totals = totalsByPlayer(['a', 'b'], [
      { game_player_id: 'a', type: 'buy_in', amount_cents: 2000 },
      { game_player_id: 'a', type: 'rebuy', amount_cents: 2000 },
      { game_player_id: 'a', type: 'rebuy', amount_cents: 2000, voided_at: '2026-01-01' },
      { game_player_id: 'a', type: 'cash_out', amount_cents: 1000 },
      { game_player_id: 'b', type: 'buy_in', amount_cents: 2000 },
      { game_player_id: 'b', type: 'cash_out', amount_cents: 5000 },
    ]);
    expect(totals).toEqual([
      { playerId: 'a', buyInCents: 4000, cashOutCents: 1000, netCents: -3000 },
      { playerId: 'b', buyInCents: 2000, cashOutCents: 5000, netCents: 3000 },
    ]);
    expect(ledgerDiff(totals)).toBe(0);
  });

  it('spreads a miscount in proportion to buy-ins', () => {
    // $10 too much was counted out; $100 vs $300 buy-ins → $2.50 / $7.50
    const adj = proportionalAdjustments([
      { playerId: 'a', buyInCents: 10000, cashOutCents: 0, netCents: -10000 },
      { playerId: 'b', buyInCents: 30000, cashOutCents: 41000, netCents: 11000 },
    ]);
    expect(Object.fromEntries(adj)).toEqual({ a: -250, b: -750 });
  });

  it('adjustments always rebalance the ledger exactly', () => {
    const rows = fc.array(
      fc.record({ in: fc.integer({ min: 0, max: 200_000 }), out: fc.integer({ min: 0, max: 400_000 }) }),
      { minLength: 1, maxLength: 10 },
    ).filter(rs => rs.some(r => r.in > 0));
    fc.assert(fc.property(rows, rs => {
      const totals = rs.map((r, i) => ({
        playerId: `p${i}`, buyInCents: r.in, cashOutCents: r.out, netCents: r.out - r.in,
      }));
      const adj = proportionalAdjustments(totals);
      const diff = ledgerDiff(totals);
      const sum = [...adj.values()].reduce((s, v) => s + v, 0);
      expect(sum).toBe(-diff);
      for (const [id, v] of adj) {
        const t = totals.find(x => x.playerId === id)!;
        expect(t.buyInCents).toBeGreaterThan(0);
        // each adjustment is within 1 cent of its exact proportional share
        expect(Math.abs(v - (-diff * t.buyInCents) / ledgerIn(totals))).toBeLessThan(1);
      }
    }));
  });
});

const ledgerIn = (ts: { buyInCents: number }[]) => ts.reduce((s, t) => s + t.buyInCents, 0);

describe('money and time helpers', () => {
  it('formats cents', () => {
    expect(formatCents(4000)).toBe('$40');
    expect(formatCents(4050)).toBe('$40.50');
    expect(formatCents(-705)).toBe('−$7.05');
    expect(formatCents(123456700, { sign: true })).toBe('+$1,234,567');
  });

  it('parses dollars without float error', () => {
    expect(parseDollars('40')).toBe(4000);
    expect(parseDollars('$40.5')).toBe(4050);
    expect(parseDollars('0.29')).toBe(29); // 0.29 * 100 = 28.999… in floats
    expect(parseDollars('1,000.10')).toBe(100010);
    expect(parseDollars('-5')).toBeNull();
    expect(parseDollars('4.567')).toBeNull();
    expect(parseDollars('abc')).toBeNull();
  });

  it('computes elapsed time with pauses', () => {
    const start = '2026-01-01T20:00:00Z';
    const now = Date.parse('2026-01-01T21:30:00Z');
    expect(elapsedMs({ started_at: start, paused_at: null, total_paused_ms: 600_000 }, now)).toBe(80 * 60_000);
    expect(elapsedMs({ started_at: start, paused_at: '2026-01-01T21:00:00Z', total_paused_ms: 0 }, now)).toBe(60 * 60_000);
    expect(elapsedMs({ started_at: null, paused_at: null, total_paused_ms: 0 }, now)).toBe(0);
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(65_000)).toBe('01:05');
  });
});
