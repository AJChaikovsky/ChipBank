import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Body, Button, Card, ErrorText, Field, H2, Money, Muted, Row, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { errorMessage, supabase } from '@/lib/supabase';
import type { PlayerResult } from '@/lib/types';

export default function ProfileScreen() {
  const { profile, userId, refreshProfile } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [venmo, setVenmo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<PlayerResult[]>([]);

  useEffect(() => {
    setDisplayName(profile?.display_name ?? '');
    setVenmo(profile?.venmo_handle ?? '');
  }, [profile]);

  useFocusEffect(useCallback(() => {
    if (!userId) return;
    supabase.from('player_results').select('*').eq('user_id', userId)
      .then(({ data }) => setResults((data ?? []) as PlayerResult[]));
  }, [userId]));

  const save = async () => {
    setErr(null); setMsg(null);
    try {
      const { error } = await supabase.from('profiles').update({
        display_name: displayName.trim(),
        venmo_handle: venmo.trim().replace(/^@/, '') || null,
      }).eq('id', userId!);
      if (error) throw error;
      await refreshProfile();
      setMsg('Saved');
    } catch (e) { setErr(errorMessage(e)); }
  };

  const nets = results.map(r => r.net_cents);
  const stats = {
    games: results.length,
    net: nets.reduce((s, n) => s + n, 0),
    wins: nets.filter(n => n > 0).length,
    best: nets.length ? Math.max(...nets) : 0,
    worst: nets.length ? Math.min(...nets) : 0,
  };

  return (
    <Screen>
      <Card>
        <Body style={{ fontWeight: '700' }}>@{profile?.username}</Body>
        <Field label="Display name" value={displayName} onChangeText={setDisplayName} />
        <Field label="Venmo username (so friends can pay you)" value={venmo} onChangeText={setVenmo}
          autoCapitalize="none" autoCorrect={false} placeholder="your-venmo" />
        <ErrorText>{err}</ErrorText>
        {msg ? <Muted>{msg}</Muted> : null}
        <Button title="Save" onPress={save} disabled={!displayName.trim()} />
      </Card>

      <H2>Stats</H2>
      <Card>
        <Stat label="Games played" value={<Body style={{ fontWeight: '700' }}>{stats.games}</Body>} />
        <Stat label="Winning sessions" value={<Body style={{ fontWeight: '700' }}>{stats.games ? `${Math.round((stats.wins / stats.games) * 100)}%` : '–'}</Body>} />
        <Stat label="Lifetime net" value={<Money cents={stats.net} />} />
        <Stat label="Best night" value={<Money cents={stats.best} />} />
        <Stat label="Worst night" value={<Money cents={stats.worst} />} />
      </Card>

      <Button title="Sign out" variant="secondary" onPress={async () => { await supabase.auth.signOut(); }} />
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Muted>{label}</Muted>
      {value}
    </Row>
  );
}
