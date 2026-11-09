import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable } from 'react-native';
import { Body, Button, Card, H2, Money, Muted, Row, Screen, useTheme } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Game, PlayerResult } from '@/lib/types';

export default function Home() {
  const { userId } = useAuth();
  const t = useTheme();
  const [live, setLive] = useState<Game[]>([]);
  const [results, setResults] = useState<PlayerResult[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const [g, r] = await Promise.all([
      supabase.from('games').select('*').neq('status', 'settled').order('created_at', { ascending: false }),
      supabase.from('player_results').select('*').eq('user_id', userId).order('ended_at', { ascending: false }).limit(25),
    ]);
    setLive((g.data ?? []) as Game[]);
    setResults((r.data ?? []) as PlayerResult[]);
  }, [userId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const lifetime = results.reduce((s, r) => s + r.net_cents, 0);

  return (
    <Screen refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}>
      <Card style={{ alignItems: 'center', paddingVertical: 22 }}>
        <Muted>Lifetime net ({results.length} game{results.length === 1 ? '' : 's'})</Muted>
        <Money cents={lifetime} style={{ fontSize: 40 }} />
      </Card>

      <Row style={{ gap: 10 }}>
        <Button title="New game" onPress={() => router.push('/new-game')} style={{ flex: 1 }} />
        <Button title="Join with code" variant="secondary" onPress={() => router.push('/join')} style={{ flex: 1 }} />
      </Row>

      <H2>Live games</H2>
      {live.length === 0 && <Muted>No games running. Start one or join with a code.</Muted>}
      {live.map(g => (
        <Pressable key={g.id} onPress={() => router.push(`/game/${g.id}`)}>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ fontWeight: '700' }}>{g.name}</Body>
              <Muted style={{ color: g.status === 'active' ? t.primary : t.muted, fontWeight: '700' }}>
                {g.status === 'lobby' ? 'In lobby' : g.paused_at ? 'Paused' : 'Live'}
              </Muted>
            </Row>
            <Muted>Code {g.join_code}{g.host_id === userId ? ' · you\'re the banker' : ''}</Muted>
          </Card>
        </Pressable>
      ))}

      <H2>Recent results</H2>
      {results.length === 0 && <Muted>Finished games show up here.</Muted>}
      {results.map(r => (
        <Pressable key={r.game_player_id} onPress={() => router.push(`/game/${r.game_id}`)}>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>{r.game_name}</Body>
              <Money cents={r.net_cents} />
            </Row>
            <Muted>{new Date(r.ended_at).toLocaleDateString()}</Muted>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
