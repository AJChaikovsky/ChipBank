import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { isConfigured, supabase } from './supabase';
import type { Profile } from './types';

type AuthCtx = {
  session: Session | null;
  userId: string | null;
  profile: Profile | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
};

const Ctx = createContext<AuthCtx>({
  session: null, userId: null, profile: null, loading: true, refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(isConfigured);

  const userId = session?.user.id ?? null;

  const refreshProfile = useCallback(async () => {
    if (!userId) { setProfile(null); return; }
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    setProfile(data as Profile | null);
  }, [userId]);

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { refreshProfile(); }, [refreshProfile]);

  return (
    <Ctx.Provider value={{ session, userId, profile, loading, refreshProfile }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
