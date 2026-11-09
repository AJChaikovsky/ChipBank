import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AddPlayerSheet, Ledger, SettlePanel, SettledView, seatTime } from '@/components/game';
import {
  AmountSheet, Body, Button, Card, ErrorText, H2, Loading, Money, Muted, Row, Screen, confirm, useTheme,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { elapsedMs, formatCents, formatDuration, totalsByPlayer } from '@/lib/settle';
import { errorMessage, rpc } from '@/lib/supabase';
import { playerName, type GamePlayer } from '@/lib/types';
import { useFriends } from '@/lib/useFriends';
import { useGame, useNow } from '@/lib/useGame';

type AmountAction = { kind: 'buy_in' | 'cash_out'; player: GamePlayer } | null;

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const t = useTheme();
  const { state, notFound, reload } = useGame(id);
  const { friends } = useFriends();
  const [amount, setAmount] = useState<AmountAction>(null);
  const [adding, setAdding] = useState(false);
  const [settling, setSettling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const running = state?.game.status === 'active' && !state.game.paused_at;
  const now = useNow(!!running);

  if (notFound) return <Screen><H2>Game not found</H2><Muted>It may have been removed, or you don't have access.</Muted></Screen>;
  if (!state || !userId) return <Loading />;

  const { game, players, txns } = state;
  const isHost = game.host_id === userId;
  const open = game.status === 'lobby' || game.status === 'active';
  const totals = new Map(totalsByPlayer(players.map(p => p.id), txns).map(r => [r.playerId, r]));
  const totalIn = [...totals.values()].reduce((s, r) => s + r.buyInCents, 0);
  const totalOut = [...totals.values()].reduce((s, r) => s + r.cashOutCents, 0);

  const act = (fn: () => Promise<unknown>) => async () => {
    setErr(null);
    try { await fn(); await reload(); } catch (e) { setErr(errorMessage(e)); }
  };

  const copyInvite = async () => {
    const link = Linking.createURL('/join', { queryParams: { code: game.join_code } });
    await Clipboard.setStringAsync(`Join my poker game "${game.name}" on ChipBank: code ${game.join_code}\n${link}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: game.name }} />

      {/* ── header: timer, status, code ── */}
      <Card style={{ alignItems: 'center', gap: 6, paddingVertical: 20 }}>
        <Muted style={{ fontWeight: '700', letterSpacing: 1 }}>
          {game.status === 'lobby' ? 'LOBBY' : game.status === 'settled' ? 'FINAL' : game.paused_at ? 'PAUSED' : 'LIVE'}
        </Muted>
        <Text style={{ fontSize: 52, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] }}>
          {formatDuration(elapsedMs(game, now))}
        </Text>
        <Row style={{ gap: 18 }}>
          <View style={{ alignItems: 'center' }}><Muted>Bought in</Muted><Body style={{ fontWeight: '700' }}>{formatCents(totalIn)}</Body></View>
          <View style={{ alignItems: 'center' }}><Muted>On the table</Muted><Body style={{ fontWeight: '700' }}>{formatCents(Math.max(0, totalIn - totalOut))}</Body></View>
          <View style={{ alignItems: 'center' }}><Muted>Players</Muted><Body style={{ fontWeight: '700' }}>{players.length}</Body></View>
        </Row>
        {open && (
          <Pressable onPress={copyInvite} style={{ marginTop: 6, backgroundColor: t.chip, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 }}>
            <Text style={{ color: t.primary, fontWeight: '800', letterSpacing: 3, fontSize: 18, textAlign: 'center' }}>{game.join_code}</Text>
            <Text style={{ color: t.primary, fontSize: 12, textAlign: 'center' }}>{copied ? 'Copied!' : 'Tap to copy invite'}</Text>
          </Pressable>
        )}
      </Card>

      <ErrorText>{err}</ErrorText>

      {/* ── host controls ── */}
      {isHost && open && !settling && (
        <Row style={{ gap: 10, flexWrap: 'wrap' }}>
          {game.status === 'lobby' && (
            <Button title={game.default_buy_in_cents ? `Start · ${formatCents(game.default_buy_in_cents)} buy-ins` : 'Start game'} style={{ flex: 1 }}
              onPress={act(() => rpc('start_game', { p_game: game.id }))} />
          )}
          {game.status === 'active' && (
            <Button title={game.paused_at ? 'Resume' : 'Pause'} variant="secondary" style={{ flex: 1 }}
              onPress={act(() => rpc(game.paused_at ? 'resume_game' : 'pause_game', { p_game: game.id }))} />
          )}
          <Button title="Add player" variant="secondary" style={{ flex: 1 }} onPress={() => setAdding(true)} />
          {game.status === 'active' && <Button title="Settle up" style={{ flex: 1 }} onPress={() => setSettling(true)} />}
        </Row>
      )}
      {!isHost && open && <Muted>The host is the banker. Ask them to log your buy-ins and cash-out.</Muted>}

      {isHost && settling && open && (
        <SettlePanel state={state} onCancel={() => setSettling(false)} onDone={() => { setSettling(false); reload(); }} />
      )}

      {game.status === 'settled' && <SettledView state={state} userId={userId} onChange={reload} />}

      {/* ── players ── */}
      {game.status !== 'settled' && (
        <>
          <H2>Players</H2>
          {players.map(p => {
            const r = totals.get(p.id)!;
            const out = p.status === 'cashed_out';
            const time = game.started_at ? seatTime(p, game.started_at, now) : null;
            return (
              <Card key={p.id} style={out ? { opacity: 0.7 } : undefined}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Body style={{ fontWeight: '700' }}>
                      {playerName(p)}{p.user_id === game.host_id ? '  🏦' : ''}{!p.user_id ? '  (guest)' : ''}
                    </Body>
                    <Muted>
                      in {formatCents(r.buyInCents)}
                      {out ? ` · cashed out ${formatCents(r.cashOutCents)}` : ''}
                      {time ? ` · ${time}` : ''}
                    </Muted>
                  </View>
                  {out && <Money cents={r.netCents} />}
                </Row>
                {isHost && open && !settling && (
                  <Row style={{ gap: 8 }}>
                    <Button small variant="secondary" style={{ flex: 1 }}
                      title={out ? 'Rejoin' : r.buyInCents ? 'Rebuy' : 'Buy in'}
                      onPress={() => setAmount({ kind: 'buy_in', player: p })} />
                    {game.status === 'active' && !out && (
                      <Button small variant="secondary" style={{ flex: 1 }} title="Cash out" onPress={() => setAmount({ kind: 'cash_out', player: p })} />
                    )}
                    {r.buyInCents === 0 && r.cashOutCents === 0 && p.user_id !== game.host_id && (
                      <Button small variant="ghost" title="Remove" onPress={act(async () => {
                        if (await confirm('Remove player?', `Remove ${playerName(p)} from the game?`, 'Remove')) {
                          await rpc('remove_player', { p_player: p.id });
                        }
                      })} />
                    )}
                  </Row>
                )}
              </Card>
            );
          })}
        </>
      )}

      <Ledger txns={txns} players={players} canVoid={isHost && open} onChange={reload} />

      <AmountSheet
        visible={!!amount}
        title={amount?.kind === 'cash_out' ? `Cash out ${playerName(amount.player)}` : `${playerName(amount?.player)} buys in`}
        subtitle={amount?.kind === 'cash_out' ? 'Count their chips and enter the dollar value.' : undefined}
        initialCents={amount?.kind === 'buy_in' ? game.default_buy_in_cents : undefined}
        allowZero={amount?.kind === 'cash_out'}
        submitLabel={amount?.kind === 'cash_out' ? 'Cash out' : 'Add'}
        onClose={() => setAmount(null)}
        onSubmit={async cents => {
          if (!amount) return;
          await rpc(amount.kind === 'cash_out' ? 'cash_out' : 'record_buy_in', { p_player: amount.player.id, p_amount_cents: cents });
          await reload();
        }}
      />

      <AddPlayerSheet
        visible={adding} onClose={() => setAdding(false)} friends={friends}
        seatedUserIds={new Set(players.map(p => p.user_id).filter((x): x is string => !!x))}
        defaultBuyIn={game.default_buy_in_cents} gameId={game.id} started={game.status === 'active'} onDone={reload}
      />
    </Screen>
  );
}
