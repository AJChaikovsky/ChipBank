import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { useTheme } from '@/components/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];
const icon = (name: IconName) => ({ color, size }: { color: unknown; size: number }) =>
  <Ionicons name={name} color={color as string} size={size} />;

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.text,
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Games', tabBarIcon: icon('albums') }} />
      <Tabs.Screen name="friends" options={{ title: 'Friends', tabBarIcon: icon('people') }} />
      <Tabs.Screen name="groups" options={{ title: 'Crews', tabBarIcon: icon('beer') }} />
      <Tabs.Screen name="profile" options={{ title: 'Me', tabBarIcon: icon('person-circle') }} />
    </Tabs>
  );
}
