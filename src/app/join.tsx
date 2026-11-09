import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorText, Field, Muted, Screen } from '@/components/ui';
import { errorMessage, rpc } from '@/lib/supabase';

// Reachable as /join or /join?code=ABC123 (chipbank://join?code=ABC123 on iOS).
export default function Join() {
  const params = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState((params.code ?? '').toUpperCase());
  const [err, setErr] = useState<string | null>(null);
  const tried = useRef(false);

  const join = async (c: string) => {
    setErr(null);
    try {
      const id = await rpc<string>('join_game', { p_code: c.trim() });
      router.replace(`/game/${id}`);
    } catch (e) { setErr(errorMessage(e)); }
  };

  useEffect(() => {
    if (params.code && !tried.current) { tried.current = true; join(params.code); }
  }, [params.code]);

  return (
    <Screen>
      <Card>
        <Field
          label="Game code" value={code} onChangeText={t => setCode(t.toUpperCase())}
          autoCapitalize="characters" autoCorrect={false} maxLength={6} placeholder="ABC123"
          style={{ fontSize: 28, letterSpacing: 6, fontWeight: '700', textAlign: 'center' }}
          onSubmitEditing={() => join(code)}
        />
        <ErrorText>{err}</ErrorText>
        <Button title="Join" disabled={code.trim().length !== 6} onPress={() => join(code)} />
        <Muted>Ask the host for the 6-letter code on their game screen.</Muted>
      </Card>
    </Screen>
  );
}
