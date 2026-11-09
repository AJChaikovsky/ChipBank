/// <reference types="node" />
// Runs the real migration inside PGlite (embedded Postgres) with a minimal
// stand-in for Supabase's auth schema and roles, then exercises the API as
// different signed-in users — including RLS and permission checks.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PGlite } from '@electric-sql/pglite';
import { settle } from '../src/lib/settle';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');

const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  grant usage on schema auth, public to anon, authenticated;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;
  create publication supabase_realtime;
  -- Supabase grants broad defaults; the migration must lock them down itself.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  for (const f of readdirSync(MIGRATIONS).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

type DB = Awaited<ReturnType<typeof freshDb>>;

async function signUp(db: DB, username: string, display = username) {
  const id = randomUUID();
  await db.query('reset role');
  await db.query('insert into auth.users (id, raw_user_meta_data) values ($1, $2)', [
    id, JSON.stringify({ username, display_name: display }),
  ]);
  return id;
}

/** Run a query as a signed-in user (role authenticated + jwt sub). */
async function as<T = any>(db: DB, uid: string | null, sql: string, params: unknown[] = []) {
  await db.query('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.query(uid ? 'set role authenticated' : 'set role anon');
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.query('reset role');
  }
}

const one = async <T = any>(db: DB, uid: string, sql: string, params: unknown[] = []) =>
  (await as<T>(db, uid, sql, params))[0];

async function befriend(db: DB, a: string, aName: string, b: string, bName: string) {
  await as(db, a, 'select public.send_friend_request($1)', [bName]);
  await as(db, b, 'select public.respond_friend_request($1, true)', [a]);
  void aName;
}

describe('database', () => {
  let db: DB;
  let host: string, bob: string, cara: string, eve: string;

  beforeAll(async () => {
    db = await freshDb();
    host = await signUp(db, 'host', 'Hank');
    bob = await signUp(db, 'bob');
    cara = await signUp(db, 'cara');
    eve = await signUp(db, 'eve');
    await befriend(db, host, 'host', bob, 'bob');
    await befriend(db, host, 'host', cara, 'cara');
  }, 30_000);

  it('creates profiles on signup and falls back on a taken username', async () => {
    const dup = await signUp(db, 'bob');
    const p = await one(db, dup, 'select username from public.profiles where id = $1', [dup]);
    expect(p.username).toMatch(/^user_[0-9a-f]{12}$/);
    expect((await one(db, host, `select public.username_available('bob') as ok`)).ok).toBe(false);
    expect((await as(db, null, `select public.username_available('newname') as ok`))[0].ok).toBe(true);
  });

  it('friend requests: mutual request auto-accepts; strangers cannot be added to games', async () => {
    const x = await signUp(db, 'xavier');
    const y = await signUp(db, 'yolanda');
    expect((await one(db, x, `select public.send_friend_request('yolanda') as r`)).r).toBe('requested');
    expect((await one(db, y, `select public.send_friend_request('xavier') as r`)).r).toBe('accepted');
    expect((await one(db, x, `select public.are_friends($1, $2) as f`, [x, y])).f).toBe(true);
    // eve sees nothing of x/y's friendship
    expect(await as(db, eve, 'select * from public.friendships where requester_id = $1', [x])).toHaveLength(0);
  });

  it('clients cannot write tables directly', async () => {
    await expect(as(db, host, `insert into public.games (host_id, name, join_code) values ($1, 'x', 'ZZZZZZ')`, [host]))
      .rejects.toThrow(/permission denied/);
    await expect(as(db, host, `update public.profiles set username = 'hacker' where id = $1`, [host]))
      .rejects.toThrow(/permission denied/);
    await expect(as(db, host, 'select public._add_player($1, $2, null, 100)', [randomUUID(), host]))
      .rejects.toThrow(/permission denied/);
    // cosmetic profile fields are editable
    await as(db, host, `update public.profiles set venmo_handle = 'hank-poker' where id = $1`, [host]);
  });

  it('runs a full game: lobby → buy-ins → rebuy → cash-outs → settlement', async () => {
    const game = (await one(db, host, `select public.create_game('Thursday', null, 10000) as id`)).id;
    const bobP = (await one(db, host, 'select public.add_player($1, $2, null, 0) as id', [game, bob])).id;
    const caraP = (await one(db, host, 'select public.add_player($1, $2, null, 0) as id', [game, cara])).id;
    const guestP = (await one(db, host, `select public.add_player($1, null, 'Uncle Joe', 0) as id`, [game])).id;
    const hostP = (await one(db, host, 'select id from public.game_players where game_id = $1 and user_id = $2', [game, host])).id;

    // eve can't add herself to the money or see the game
    expect(await as(db, eve, 'select * from public.games where id = $1', [game])).toHaveLength(0);
    expect(await as(db, eve, 'select * from public.transactions where game_id = $1', [game])).toHaveLength(0);
    await expect(as(db, eve, 'select public.add_player($1, $2, null, 0)', [game, eve])).rejects.toThrow(/Only the host/);
    // and host can't add a stranger
    await expect(as(db, host, 'select public.add_player($1, $2, null, 0)', [game, eve])).rejects.toThrow(/friends/);

    await as(db, host, 'select public.start_game($1)', [game]);
    const ins = await as(db, bob, `select game_player_id, type, amount_cents from public.transactions where game_id = $1`, [game]);
    expect(ins).toHaveLength(4); // everyone got the $100 default
    expect(ins.every((t: any) => t.type === 'buy_in' && Number(t.amount_cents) === 10000)).toBe(true);

    // players can't log money — only the host
    await expect(as(db, bob, 'select public.record_buy_in($1, 5000)', [bobP])).rejects.toThrow(/Only the host/);

    const r = await one(db, host, 'select public.record_buy_in($1, 10000) as id', [bobP]);
    expect((await one(db, host, 'select type from public.transactions where id = $1', [r.id])).type).toBe('rebuy');

    // bob leaves early with $20, then comes back with a rebuy, then cashes out again
    await as(db, host, 'select public.cash_out($1, 2000)', [bobP]);
    expect((await one(db, host, 'select status, left_at from public.game_players where id = $1', [bobP])).status).toBe('cashed_out');
    await expect(as(db, host, 'select public.cash_out($1, 100)', [bobP])).rejects.toThrow(/already cashed out/);
    await as(db, host, 'select public.record_buy_in($1, 5000)', [bobP]);
    expect((await one(db, host, 'select status, left_at from public.game_players where id = $1', [bobP]))).toMatchObject({ status: 'active', left_at: null });

    // pause/resume accrues paused time
    await as(db, host, 'select public.pause_game($1)', [game]);
    await as(db, host, 'select public.resume_game($1)', [game]);

    // finalize refused while chips are out
    await expect(as(db, host, 'select public.finalize_game($1)', [game])).rejects.toThrow(/still have chips/);

    // totals in: host 100, bob 100+100+50=250, cara 100, guest 100 → 550
    await as(db, host, 'select public.cash_out($1, 0)', [bobP]);      // bob: 20 + 0 out → −230
    await as(db, host, 'select public.cash_out($1, 30000)', [hostP]); // host +200
    await as(db, host, 'select public.cash_out($1, 18000)', [caraP]); // cara +80
    // guest: miscount first, then fix via void
    const bad = await one(db, host, 'select public.cash_out($1, 9999) as id', [guestP]);
    await expect(as(db, host, 'select public.finalize_game($1)', [game])).rejects.toThrow(/off by/);
    await as(db, host, 'select public.void_transaction($1)', [bad.id]);
    expect((await one(db, host, 'select status from public.game_players where id = $1', [guestP])).status).toBe('active');
    await as(db, host, 'select public.cash_out($1, 5000)', [guestP]); // guest −50

    await as(db, host, 'select public.finalize_game($1)', [game]);

    const nets = await as(db, bob, 'select game_player_id, net_cents from public.game_nets($1)', [game]);
    const netMap: Record<string, number> = Object.fromEntries(nets.map((n: any) => [n.game_player_id, Number(n.net_cents)]));
    expect(netMap).toEqual({ [hostP]: 20000, [bobP]: -23000, [caraP]: 8000, [guestP]: -5000 });

    const s = await as(db, cara, 'select id, from_player_id, to_player_id, amount_cents from public.settlements where game_id = $1', [game]);
    const expected = settle(Object.entries(netMap).map(([playerId, cents]) => ({ playerId, cents })));
    expect(s.map((x: any) => ({ from: x.from_player_id, to: x.to_player_id, cents: Number(x.amount_cents) }))
      .sort((a: any, b: any) => b.cents - a.cents)).toEqual([...expected].sort((a, b) => b.cents - a.cents));

    // game is locked now
    const g = await one(db, host, 'select status, ended_at, paused_at from public.games where id = $1', [game]);
    expect(g.status).toBe('settled');
    await expect(as(db, host, 'select public.record_buy_in($1, 100)', [bobP])).rejects.toThrow(/settled/);

    // payer can mark paid; outsider cannot
    const bobsDebt = s.find((x: any) => x.from_player_id === bobP)!;
    await expect(as(db, eve, 'select public.mark_settlement_paid($1)', [bobsDebt.id])).rejects.toThrow();
    await as(db, bob, 'select public.mark_settlement_paid($1)', [bobsDebt.id]);
    expect((await one(db, host, 'select paid_at from public.settlements where id = $1', [bobsDebt.id])).paid_at).not.toBeNull();

    // stats view respects RLS
    const mine = await as(db, bob, 'select net_cents from public.player_results where user_id = $1', [bob]);
    expect(mine.map((x: any) => Number(x.net_cents))).toEqual([-23000]);
    expect(await as(db, eve, 'select * from public.player_results where game_id = $1', [game])).toHaveLength(0);
  });

  it('proportional mismatch fix and pay-the-host mode', async () => {
    const game = (await one(db, host, `select public.create_game('Friday', null, 0) as id`)).id;
    const hostP = (await one(db, host, 'select id from public.game_players where game_id = $1', [game])).id;
    const bobP = (await one(db, host, 'select public.add_player($1, $2, null, 10000) as id', [game, bob])).id;
    const caraP = (await one(db, host, 'select public.add_player($1, $2, null, 30000) as id', [game, cara])).id;
    await as(db, host, 'select public.record_buy_in($1, 10000)', [hostP]);
    await as(db, host, 'select public.start_game($1)', [game]);
    // in: 100 + 100 + 300 = 500. out counted: 0 + 50 + 460 = 510 → $10 too many
    await as(db, host, 'select public.cash_out($1, 0)', [hostP]);
    await as(db, host, 'select public.cash_out($1, 5000)', [bobP]);
    await as(db, host, 'select public.cash_out($1, 46000)', [caraP]);
    await as(db, host, `select public.finalize_game($1, 'proportional', 'host')`, [game]);

    const nets = await as(db, host, 'select game_player_id, adjustment_cents, net_cents from public.game_nets($1)', [game]);
    const by = Object.fromEntries(nets.map((n: any) => [n.game_player_id, n]));
    expect(nets.reduce((s: number, n: any) => s + Number(n.net_cents), 0)).toBe(0);
    expect(Number(by[hostP].adjustment_cents)).toBe(-200);
    expect(Number(by[bobP].adjustment_cents)).toBe(-200);
    expect(Number(by[caraP].adjustment_cents)).toBe(-600);

    const s = await as(db, host, 'select from_player_id, to_player_id, amount_cents from public.settlements where game_id = $1', [game]);
    expect(s.every((x: any) => x.from_player_id === hostP || x.to_player_id === hostP)).toBe(true);
  });

  it('join by code, group crew seating, and remove a no-show', async () => {
    const crew = (await one(db, host, `select public.create_group('Thursday crew') as id`)).id;
    await as(db, host, 'select public.add_group_member($1, $2)', [crew, bob]);
    await as(db, host, 'select public.add_group_member($1, $2)', [crew, cara]);
    await expect(as(db, host, 'select public.add_group_member($1, $2)', [crew, eve])).rejects.toThrow(/friends/);
    expect(await as(db, bob, 'select * from public.group_members where group_id = $1', [crew])).toHaveLength(3);
    expect(await as(db, eve, 'select * from public.groups where id = $1', [crew])).toHaveLength(0);

    const game = (await one(db, host, `select public.create_game('Crew night', $1, 2000) as id`, [crew])).id;
    const seated = await as(db, cara, 'select user_id from public.game_players where game_id = $1', [game]);
    expect(seated).toHaveLength(3);

    const code = (await one(db, host, 'select join_code from public.games where id = $1', [game])).join_code;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await one(db, eve, 'select public.join_game($1) as id', [code.toLowerCase()])).id).toBe(game);
    expect(await as(db, eve, 'select * from public.games where id = $1', [game])).toHaveLength(1);

    const caraP = (await one(db, host, 'select id from public.game_players where game_id = $1 and user_id = $2', [game, cara])).id;
    await as(db, host, 'select public.remove_player($1)', [caraP]);
    await as(db, host, 'select public.start_game($1)', [game]);
    const ins = await as(db, host, 'select count(*)::int as n from public.transactions where game_id = $1', [game]);
    expect(ins[0].n).toBe(3); // host, bob, eve each got the $20 default
  });

  it('SQL settlement matches the TypeScript algorithm on random games', async () => {
    const pool = [host, bob, cara];
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        buys: fc.array(fc.integer({ min: 1, max: 50_000 }), { minLength: 1, maxLength: 3 }),
        out: fc.integer({ min: 0, max: 150_000 }),
      }), { minLength: 2, maxLength: 7 }),
      async players => {
        const game = (await one(db, host, `select public.create_game('Prop', null, 0) as id`)).id;
        const ids: string[] = [];
        for (let i = 0; i < players.length; i++) {
          const pid = i === 0
            ? (await one(db, host, 'select id from public.game_players where game_id = $1', [game])).id
            : i < pool.length
              ? (await one(db, host, 'select public.add_player($1, $2, null, 0) as id', [game, pool[i]])).id
              : (await one(db, host, `select public.add_player($1, null, $2, 0) as id`, [game, `Guest ${i}`])).id;
          ids.push(pid);
          for (const b of players[i].buys) await as(db, host, 'select public.record_buy_in($1, $2)', [pid, b]);
        }
        // force the ledger to balance by giving the last player the remainder
        const totalIn = players.flatMap(p => p.buys).reduce((s, b) => s + b, 0);
        let outSoFar = 0;
        for (let i = 0; i < players.length; i++) {
          const amt = i === players.length - 1 ? totalIn - outSoFar : Math.min(players[i].out, totalIn - outSoFar);
          outSoFar += amt;
          await as(db, host, 'select public.cash_out($1, $2)', [ids[i], amt]);
        }
        await as(db, host, 'select public.finalize_game($1)', [game]);

        const nets = await as(db, host, 'select game_player_id, net_cents from public.game_nets($1)', [game]);
        const expected = settle(nets.map((n: any) => ({ playerId: n.game_player_id, cents: Number(n.net_cents) })));
        const actual = await as(db, host, 'select from_player_id, to_player_id, amount_cents from public.settlements where game_id = $1', [game]);
        const norm = (xs: { from: string; to: string; cents: number }[]) =>
          xs.map(x => `${x.from}>${x.to}:${x.cents}`).sort();
        expect(norm(actual.map((x: any) => ({ from: x.from_player_id, to: x.to_player_id, cents: Number(x.amount_cents) }))))
          .toEqual(norm(expected));
      },
    ), { numRuns: 25 });
  }, 120_000);
});
