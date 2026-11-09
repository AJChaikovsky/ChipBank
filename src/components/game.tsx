import { useMemo, useState } from 'react';
import { Linking, View } from 'react-native';
import {
  Body, Button, Card, Divider, ErrorText, Field, H2, Money, Muted, Row, Segmented, Sheet, confirm, useTheme,
} from '@/components/ui';
import { venmoPayUrl } from '@/lib/payments';
import {
  formatCents, formatDuration, ledgerDiff, parseDollars, proportionalAdjustments, settle, settleWithHost,
  totalsByPlayer, type Transfer, type Txn,
} from '@/lib/settle';
import { errorMessage, rpc } from '@/lib/supabase';
import { playerName, type GamePlayer, type ProfileLite, type Transaction } from '@/lib/types';
import type { GameState } from '@/lib/useGame';

// ─────────────────────────────────────────────────────────── add player ──

export function AddPlayerSheet({ visible, onClose, friends, seatedUserIds, defaultBuyIn, gameId, started, onDone }: {
  visible: boolean; onClose: () => void; friends: ProfileLite[]; seatedUserIds: Set<string>;
  defaultBuyIn: number; gameId: string; started: boolean; onDone: () => void;
}) {
  const [guest, setGuest] = useState('');
  const [buyIn, setBuyIn] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState(false);
  if (visible !== lastOpen) {
    setLastOpen(visible);
    if (visible) { setGuest(''); setErr(null); setBuyIn(started && defaultBuyIn ? String(defaultBuyIn / 100) : ''); }
  }
  const cents = buyIn.trim() === '' ? 0 : parseDollars(buyIn);
  const available = friends.filter(f => !seatedUserIds.has(f.id));

  const add = async (args: { p_user_id?: string; p_guest_name?: string }) => {
    setErr(null);
    try {
      await rpc('add_player', { p_game: gameId, p_user_id: null, p_guest_name: null, ...args, p_buy_in_cents: cents ?? 0 });
      onDone();
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <H2>Add player</H2>
      <Field label={started ? 'Buy-in ($)' : 'Buy-in now ($, optional)'} value={buyIn} onChangeText={setBuyIn}
        keyboardType="decimal-pad" inputMode="decimal"
        placeholder={started ? '' : `Leave blank to use ${formatCents(defaultBuyIn)} at start`} />
      {available.length > 0 && <Muted style={{ fontWeight: '600' }}>Friends</Muted>}
      <View style={{ gap: 6, maxHeight: 220 }}>
        {available.slice(0, 8).map(f => (
          <Row key={f.id} style={{ justifyContent: 'space-between' }}>
            <Body>{f.display_name}</Body>
            <Button small title="Add" disabled={cents === null} onPress={() => add({ p_user_id: f.id })} />
          </Row>
        ))}
      </View>
      <Divider />
      <Muted style={{ fontWeight: '600' }}>Guest (no app needed)</Muted>
      <Row style={{ gap: 8 }}>
        <View style={{ flex: 1 }}><Field value={guest} onChangeText={setGuest} placeholder="Name" /></View>
        <Button title="Add guest" disabled={!guest.trim() || cents === null} onPress={() => add({ p_guest_name: guest.trim() })} />
      </Row>
      <ErrorText>{err}</ErrorText>
      <Button title="Done" variant="secondary" onPress={onClose} />
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────── settle up ──

type Mismatch = 'strict' | 'proportional';
type Payout = 'minimize' | 'host';

/** Host enters final stacks, sees the balance check and a preview, then finalizes. */
export function SettlePanel({ state, onCancel, onDone }: { state: GameState; onCancel: () => void; onDone: () => void }) {
  const t = useTheme();
  const { game, players, txns } = state;
  const active = players.filter(p => p.status === 'active');
  const [stacks, setStacks] = useState<Record<string, string>>({});
  const [mismatch, setMismatch] = useState<Mismatch>('strict');
  const [payout, setPayout] = useState<Payout>('minimize');
  const [err, setErr] = useState<string | null>(null);

  const parsed = active.map(p => ({ p, cents: parseDollars(stacks[p.id] ?? '') }));
  const allEntered = parsed.every(x => x.cents !== null);

  const preview = useMemo(() => {
    if (!allEntered) return null;
    const synthetic: Txn[] = parsed.map(x => ({ game_player_id: x.p.id, type: 'cash_out', amount_cents: x.cents! }));
    const totals = totalsByPlayer(players.map(p => p.id), [...txns, ...synthetic]);
    const diff = ledgerDiff(totals);
    let nets = totals.map(r => ({ playerId: r.playerId, cents: r.netCents }));
    if (diff !== 0) {
      if (mismatch === 'strict') return { diff, transfers: null as Transfer[] | null, nets };
      const adj = proportionalAdjustments(totals);
      nets = nets.map(n => ({ ...n, cents: n.cents + (adj.get(n.playerId) ?? 0) }));
    }
    const hostP = players.find(p => p.user_id === game.host_id)!;
    const transfers = payout === 'host' ? settleWithHost(nets, hostP.id) : settle(nets);
    return { diff, transfers, nets };
  }, [allEntered, stacks, mismatch, payout, players, txns]);

  const nameOf = (id: string) => playerName(players.find(p => p.id === id));

  const finalize = async () => {
    setErr(null);
    if (!preview?.transfers) return;
    const ok = await confirm('Finalize game?', 'This locks the ledger and posts who pays whom.', 'Finalize');
    if (!ok) return;
    try {
      for (const x of parsed) await rpc('cash_out', { p_player: x.p.id, p_amount_cents: x.cents });
      await rpc('finalize_game', { p_game: game.id, p_mismatch: mismatch, p_payout: payout });
      onDone();
    } catch (e) { setErr(errorMessage(e)); onDone(); }
  };

  return (
    <Card style={{ borderColor: t.primary, borderWidth: 1.5 }}>
      <H2>Settle up</H2>
      {active.length > 0
        ? <Muted>Count each remaining stack and enter its dollar value.</Muted>
        : <Muted>Everyone has cashed out.</Muted>}
      {active.map(p => (
        <Row key={p.id} style={{ gap: 10 }}>
          <Body style={{ flex: 1 }} numberOfLines={1}>{playerName(p)}</Body>
          <View style={{ width: 130 }}>
            <Field value={stacks[p.id] ?? ''} onChangeText={v => setStacks(s => ({ ...s, [p.id]: v }))}
              placeholder="0.00" keyboardType="decimal-pad" inputMode="decimal" style={{ textAlign: 'right' }} />
          </View>
        </Row>
      ))}

      {preview && preview.diff !== 0 && (
        <View style={{ gap: 8 }}>
          <Body style={{ color: t.danger, fontWeight: '700' }}>
            Off by {formatCents(Math.abs(preview.diff))}: {preview.diff > 0 ? 'more came out than went in' : 'less came out than went in'}.
          </Body>
          <Segmented value={mismatch} onChange={setMismatch} options={[
            { value: 'strict', label: 'Recount' },
            { value: 'proportional', label: 'Split by buy-in' },
          ]} />
        </View>
      )}

      {preview && preview.diff === 0 && <Muted style={{ color: t.primary, fontWeight: '700' }}>✓ Ledger balances</Muted>}

      <Muted style={{ fontWeight: '600' }}>Payout style</Muted>
      <Segmented value={payout} onChange={setPayout} options={[
        { value: 'minimize', label: 'Fewest payments' },
        { value: 'host', label: 'Everyone pays host' },
      ]} />

      {preview?.transfers && (
        <View style={{ gap: 6 }}>
          <Divider />
          {preview.transfers.length === 0 && <Muted>Everyone broke even. No payments needed.</Muted>}
          {preview.transfers.map((x, i) => (
            <Row key={i} style={{ justifyContent: 'space-between' }}>
              <Body style={{ flex: 1 }}>{nameOf(x.from)} → {nameOf(x.to)}</Body>
              <Body style={{ fontWeight: '700' }}>{formatCents(x.cents)}</Body>
            </Row>
          ))}
        </View>
      )}

      <ErrorText>{err}</ErrorText>
      <Row style={{ gap: 10 }}>
        <Button title="Back" variant="secondary" onPress={onCancel} style={{ flex: 1 }} />
        <Button title="Finalize" onPress={finalize} disabled={!preview?.transfers} style={{ flex: 1 }} />
      </Row>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────── settled ──

export function SettledView({ state, userId, onChange }: { state: GameState; userId: string; onChange: () => void }) {
  const t = useTheme();
  const { game, players, txns, settlements } = state;
  const totals = totalsByPlayer(players.map(p => p.id), txns).sort((a, b) => b.netCents - a.netCents);
  const byId = new Map(players.map(p => [p.id, p]));
  const isHost = game.host_id === userId;
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (id: string, paid: boolean) => {
    setErr(null);
    try { await rpc('mark_settlement_paid', { p_settlement: id, p_paid: paid }); onChange(); }
    catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <>
      <H2>Results</H2>
      <Card>
        {totals.map(r => (
          <Row key={r.playerId} style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Body style={{ fontWeight: '600' }}>{playerName(byId.get(r.playerId))}</Body>
              <Muted>in {formatCents(r.buyInCents)} · out {formatCents(r.cashOutCents)}</Muted>
            </View>
            <Money cents={r.netCents} />
          </Row>
        ))}
      </Card>

      <H2>Payments</H2>
      {settlements.length === 0 && <Muted>No payments needed.</Muted>}
      {settlements.map(s => {
        const from = byId.get(s.from_player_id);
        const to = byId.get(s.to_player_id);
        const iPay = from?.user_id === userId;
        const involved = isHost || iPay || to?.user_id === userId;
        const handle = to?.profile?.venmo_handle;
        return (
          <Card key={s.id} style={s.paid_at ? { opacity: 0.6 } : undefined}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ flex: 1 }}>
                <Body style={{ fontWeight: '700' }}>{playerName(from)}</Body> pays <Body style={{ fontWeight: '700' }}>{playerName(to)}</Body>
              </Body>
              <Body style={{ fontWeight: '800' }}>{formatCents(s.amount_cents)}</Body>
            </Row>
            {s.paid_at
              ? <Muted style={{ color: t.primary, fontWeight: '600' }}>✓ Paid {new Date(s.paid_at).toLocaleDateString()}</Muted>
              : null}
            <Row style={{ gap: 8, flexWrap: 'wrap' }}>
              {iPay && !s.paid_at && handle && (
                <Button small title={`Pay on Venmo`} onPress={() => { Linking.openURL(venmoPayUrl(handle, s.amount_cents, `${game.name} 🃏`)); }} />
              )}
              {iPay && !s.paid_at && !handle && <Muted>{playerName(to)} hasn't added a Venmo username yet.</Muted>}
              {involved && (
                <Button small variant={s.paid_at ? 'ghost' : 'secondary'} title={s.paid_at ? 'Mark unpaid' : 'Mark paid'}
                  onPress={() => toggle(s.id, !s.paid_at)} />
              )}
            </Row>
          </Card>
        );
      })}
      <ErrorText>{err}</ErrorText>
    </>
  );
}

// ───────────────────────────────────────────────────────────── ledger ──

const TYPE_LABEL: Record<Transaction['type'], string> = {
  buy_in: 'Buy-in', rebuy: 'Rebuy', cash_out: 'Cash-out', adjustment: 'Adjustment',
};

export function Ledger({ txns, players, canVoid, onChange }: {
  txns: Transaction[]; players: GamePlayer[]; canVoid: boolean; onChange: () => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const byId = new Map(players.map(p => [p.id, p]));
  const shown = open ? [...txns].reverse() : [...txns].reverse().slice(0, 5);
  if (txns.length === 0) return null;

  return (
    <>
      <Row style={{ justifyContent: 'space-between' }}>
        <H2>Ledger</H2>
        {txns.length > 5 && <Button small variant="ghost" title={open ? 'Show less' : `Show all ${txns.length}`} onPress={() => setOpen(o => !o)} />}
      </Row>
      <Card>
        {shown.map(x => {
          const voided = !!x.voided_at;
          const strike = voided ? { textDecorationLine: 'line-through' as const, color: t.muted } : undefined;
          return (
            <Row key={x.id} style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Body style={strike}>{playerName(byId.get(x.game_player_id))} · {TYPE_LABEL[x.type]}</Body>
                <Muted>{new Date(x.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{voided ? ' · voided' : ''}</Muted>
              </View>
              <Body style={[{ fontWeight: '700', fontVariant: ['tabular-nums'] }, strike]}>{formatCents(x.amount_cents)}</Body>
              {canVoid && !voided && x.type !== 'adjustment' && (
                <Button small variant="ghost" title="Void" onPress={async () => {
                  if (await confirm('Void this entry?', `${TYPE_LABEL[x.type]} of ${formatCents(x.amount_cents)} for ${playerName(byId.get(x.game_player_id))}. It stays in the history, crossed out.`, 'Void')) {
                    await rpc('void_transaction', { p_txn: x.id });
                    onChange();
                  }
                }} />
              )}
            </Row>
          );
        })}
      </Card>
    </>
  );
}

export function seatTime(p: GamePlayer, gameStartedAt: string | null, now: number) {
  const start = Math.max(Date.parse(p.joined_at), gameStartedAt ? Date.parse(gameStartedAt) : Infinity);
  if (!Number.isFinite(start)) return null;
  const end = p.left_at ? Date.parse(p.left_at) : now;
  return formatDuration(Math.max(0, end - start));
}
