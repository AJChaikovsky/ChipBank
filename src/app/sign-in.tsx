import { useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Card, ErrorText, Field, H1, Muted, Screen, Segmented, notify } from '@/components/ui';
import { errorMessage, rpc, supabase } from '@/lib/supabase';

export default function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    try {
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        return;
      }
      const uname = username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(uname)) throw new Error('Username: 3–20 letters, numbers, or _');
      if (!(await rpc<boolean>('username_available', { p_username: uname }))) throw new Error('That username is taken');
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { username: uname, display_name: displayName.trim() || uname } },
      });
      if (error) throw error;
      if (!data.session) notify('Check your email', 'Confirm your address, then sign in.');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Screen>
      <View style={{ height: 40 }} />
      <H1 style={{ fontSize: 40 }}>ChipBank</H1>
      <Body>Track buy-ins, cash-outs, and who owes whom at your home game.</Body>
      <Card>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'in', label: 'Sign in' }, { value: 'up', label: 'Create account' }]} />
        {mode === 'up' && (
          <>
            <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="aj_nuts" />
            <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="AJ" />
          </>
        )}
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" inputMode="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete={mode === 'in' ? 'current-password' : 'new-password'} onSubmitEditing={submit} />
        <ErrorText>{err}</ErrorText>
        <Button title={mode === 'in' ? 'Sign in' : 'Create account'} onPress={submit} disabled={!email || password.length < 6} />
      </Card>
      <Muted>ChipBank never holds or moves money. It keeps the ledger and links you to Venmo or Cash App to settle.</Muted>
    </Screen>
  );
}
