import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Button, Card, ErrorText, Field, Muted, Screen } from '@/components/ui';
import { parseDollars } from '@/lib/settle';
import { errorMessage, rpc } from '@/lib/supabase';

export default function NewGame() {
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const [name, setName] = useState(params.name ? `${params.name} game` : 'Home game');
  const [buyIn, setBuyIn] = useState('20');
  const [err, setErr] = useState<string | null>(null);
  const cents = buyIn.trim() === '' ? 0 : parseDollars(buyIn);

  return (
    <Screen>
      <Card>
        <Field label="Game name" value={name} onChangeText={setName} />
        <Field label="Default buy-in ($)" value={buyIn} onChangeText={setBuyIn} keyboardType="decimal-pad" inputMode="decimal" />
        <Muted>
          {params.groupId
            ? 'Everyone in the crew is seated. When you start the game, each player is bought in at the default amount. Remove anyone who doesn\'t show.'
            : 'Add players in the lobby. When you start the game, everyone without a buy-in is bought in at the default amount.'}
        </Muted>
        <ErrorText>{err}</ErrorText>
        <Button
          title="Create game"
          disabled={!name.trim() || cents === null}
          onPress={async () => {
            setErr(null);
            try {
              const id = await rpc<string>('create_game', {
                p_name: name.trim(),
                p_group_id: params.groupId ?? null,
                p_default_buy_in_cents: cents ?? 0,
              });
              router.replace(`/game/${id}`);
            } catch (e) { setErr(errorMessage(e)); }
          }}
        />
      </Card>
    </Screen>
  );
}
