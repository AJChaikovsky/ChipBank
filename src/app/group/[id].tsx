import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Body, Button, Card, ErrorText, H2, Money, Muted, Row, Screen, confirm } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { errorMessage, rpc, supabase } from '@/lib/supabase';
import type { Group, PlayerResult, ProfileLite } from '@/lib/types';
import { useFriends } from '@/lib/useFriends';

type Member = { user_id: string; role: 'owner' | 'member'; profile: ProfileLite };

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const { friends } = useFriends();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [results, setResults] = useState<PlayerResult[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [g, m, r] = await Promise.all([
      supabase.from('groups').select('*').eq('id', id).maybeSingle(),
      supabase.from('group_members').select('user_id, role, profile:profiles(id, username, display_name, venmo_handle)').eq('group_id', id),
      supabase.from('player_results').select('*').eq('group_id', id),
    ]);
    setGroup(g.data as Group | null);
    setMembers((m.data ?? []) as unknown as Member[]);
    setResults((r.data ?? []) as PlayerResult[]);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const isOwner = group?.owner_id === userId;
  const memberIds = new Set(members.map(m => m.user_id));
  const addable = friends.filter(f => !memberIds.has(f.id));

  const act = (fn: () => Promise<unknown>) => async () => {
    setErr(null);
    try { await fn(); await load(); } catch (e) { setErr(errorMessage(e)); }
  };

  // crew leaderboard: lifetime net per user over this crew's games
  const board = new Map<string, number>();
  for (const r of results) if (r.user_id) board.set(r.user_id, (board.get(r.user_id) ?? 0) + r.net_cents);
  const gameCount = new Set(results.map(r => r.game_id)).size;

  if (!group) return <Screen><Muted>Loading…</Muted></Screen>;

  return (
    <Screen>
      <Stack.Screen options={{ title: group.name }} />
      <Button title="Start game with this crew" onPress={() => router.push({ pathname: '/new-game', params: { groupId: group.id, name: group.name } })} />
      <ErrorText>{err}</ErrorText>

      <H2>Players ({members.length})</H2>
      {members.map(m => (
        <Card key={m.user_id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Row style={{ flex: 1 }}>
              <Body style={{ fontWeight: '600' }}>{m.profile.display_name}</Body>
              {m.role === 'owner' && <Muted>owner</Muted>}
            </Row>
            {board.has(m.user_id) && <Money cents={board.get(m.user_id)!} />}
            {isOwner && m.role !== 'owner' && (
              <Button small variant="ghost" title="Remove" onPress={act(() => rpc('remove_group_member', { p_group: id, p_user: m.user_id }))} />
            )}
          </Row>
        </Card>
      ))}
      {gameCount > 0 && <Muted>Totals across {gameCount} crew game{gameCount === 1 ? '' : 's'}.</Muted>}

      {isOwner && (
        <>
          <H2>Add friends</H2>
          {addable.length === 0 && <Muted>All your friends are in this crew. Add more friends from the Friends tab.</Muted>}
          {addable.map(f => (
            <Card key={f.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Body>{f.display_name} <Muted>@{f.username}</Muted></Body>
                <Button small title="Add" onPress={act(() => rpc('add_group_member', { p_group: id, p_user: f.id }))} />
              </Row>
            </Card>
          ))}
          <Button title="Delete crew" variant="ghost" onPress={act(async () => {
            if (await confirm('Delete crew?', 'Past games are kept.', 'Delete')) {
              await rpc('delete_group', { p_group: id });
              router.back();
            }
          })} />
        </>
      )}
      {!isOwner && (
        <Button title="Leave crew" variant="ghost" onPress={act(async () => {
          if (await confirm('Leave crew?', `Leave ${group.name}?`, 'Leave')) {
            await rpc('remove_group_member', { p_group: id, p_user: userId });
            router.back();
          }
        })} />
      )}
    </Screen>
  );
}
