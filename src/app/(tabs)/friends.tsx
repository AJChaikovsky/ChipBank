import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Body, Button, Card, ErrorText, Field, H2, Muted, Row, Screen, confirm } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { errorMessage, rpc, supabase } from '@/lib/supabase';
import type { ProfileLite } from '@/lib/types';
import { useFriends } from '@/lib/useFriends';

export default function Friends() {
  const { userId } = useAuth();
  const { friends, incoming, outgoing, reload } = useFriends();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ProfileLite[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  useEffect(() => {
    const term = q.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (term.length < 2) { setResults([]); return; }
    const h = setTimeout(async () => {
      const { data } = await supabase.from('profiles')
        .select('id, username, display_name, venmo_handle')
        .ilike('username', `%${term}%`).neq('id', userId!).limit(10);
      setResults((data ?? []) as ProfileLite[]);
    }, 250);
    return () => clearTimeout(h);
  }, [q, userId]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setErr(null);
    try { await fn(); await reload(); } catch (e) { setErr(errorMessage(e)); }
  };

  const known = new Set([...friends, ...incoming, ...outgoing].map(p => p.id));

  return (
    <Screen>
      <Field placeholder="Search by username" value={q} onChangeText={setQ} autoCapitalize="none" autoCorrect={false} />
      <ErrorText>{err}</ErrorText>
      {results.map(p => (
        <Card key={p.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <PersonLabel p={p} />
            {known.has(p.id)
              ? <Muted>{friends.some(f => f.id === p.id) ? 'Friends' : 'Pending'}</Muted>
              : <Button small title="Add" onPress={act(() => rpc('send_friend_request', { p_username: p.username }))} />}
          </Row>
        </Card>
      ))}

      {incoming.length > 0 && <H2>Requests</H2>}
      {incoming.map(p => (
        <Card key={p.id}>
          <PersonLabel p={p} />
          <Row style={{ gap: 8 }}>
            <Button small title="Accept" style={{ flex: 1 }} onPress={act(() => rpc('respond_friend_request', { p_requester: p.id, p_accept: true }))} />
            <Button small title="Decline" variant="secondary" style={{ flex: 1 }} onPress={act(() => rpc('respond_friend_request', { p_requester: p.id, p_accept: false }))} />
          </Row>
        </Card>
      ))}

      <H2>Friends ({friends.length})</H2>
      {friends.length === 0 && <Muted>Search for your poker friends by username to add them.</Muted>}
      {friends.map(p => (
        <Card key={p.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <PersonLabel p={p} />
            <Button small variant="ghost" title="Remove" onPress={act(async () => {
              if (await confirm('Remove friend?', `Remove ${p.display_name} from your friends?`, 'Remove')) {
                await rpc('remove_friend', { p_other: p.id });
              }
            })} />
          </Row>
        </Card>
      ))}

      {outgoing.length > 0 && <H2>Sent</H2>}
      {outgoing.map(p => (
        <Card key={p.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <PersonLabel p={p} />
            <Button small variant="ghost" title="Cancel" onPress={act(() => rpc('remove_friend', { p_other: p.id }))} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}

function PersonLabel({ p }: { p: ProfileLite }) {
  return (
    <Row style={{ flex: 1, gap: 6 }}>
      <Body style={{ fontWeight: '600' }}>{p.display_name}</Body>
      <Muted>@{p.username}</Muted>
    </Row>
  );
}
