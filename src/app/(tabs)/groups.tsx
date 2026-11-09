import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable } from 'react-native';
import { Body, Button, Card, ErrorText, Field, Muted, Row, Screen } from '@/components/ui';
import { errorMessage, rpc, supabase } from '@/lib/supabase';
import type { Group } from '@/lib/types';

type GroupRow = Group & { group_members: { count: number }[] };

export default function Groups() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from('groups').select('*, group_members(count)').order('created_at');
    setGroups((data ?? []) as GroupRow[]);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen>
      <Muted>A crew is your regular game. Start a game with the whole crew in one tap.</Muted>
      <Row style={{ gap: 8 }}>
        <Field placeholder="New crew name (e.g. Thursday Night)" value={name} onChangeText={setName} style={{ flex: 1 }} />
      </Row>
      <Button title="Create crew" disabled={!name.trim()} onPress={async () => {
        setErr(null);
        try {
          const id = await rpc<string>('create_group', { p_name: name.trim() });
          setName('');
          router.push(`/group/${id}`);
        } catch (e) { setErr(errorMessage(e)); }
      }} />
      <ErrorText>{err}</ErrorText>

      {groups.map(g => (
        <Pressable key={g.id} onPress={() => router.push(`/group/${g.id}`)}>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ fontWeight: '700' }}>{g.name}</Body>
              <Muted>{g.group_members[0]?.count ?? 0} players</Muted>
            </Row>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
