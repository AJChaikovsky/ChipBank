import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Body, H1, Loading, Muted, Screen, useTheme } from '@/components/ui';
import { AuthProvider, useAuth } from '@/lib/auth';
import { isConfigured } from '@/lib/supabase';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="auto" />
      <Navigator />
    </AuthProvider>
  );
}

function Navigator() {
  const { session, loading } = useAuth();
  const t = useTheme();
  if (!isConfigured) return <SetupNeeded />;
  if (loading) return <Loading />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="game/[id]" options={{ title: 'Game' }} />
        <Stack.Screen name="group/[id]" options={{ title: 'Crew' }} />
        <Stack.Screen name="new-game" options={{ title: 'New game', presentation: 'modal' }} />
        <Stack.Screen name="join" options={{ title: 'Join game', presentation: 'modal' }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

function SetupNeeded() {
  return (
    <Screen>
      <H1>Connect Supabase</H1>
      <Body>
        Copy .env.example to .env and fill in EXPO_PUBLIC_SUPABASE_URL and
        EXPO_PUBLIC_SUPABASE_ANON_KEY from your Supabase project (Project Settings → API).
      </Body>
      <Muted>Then restart the dev server: npx expo start --clear</Muted>
    </Screen>
  );
}
