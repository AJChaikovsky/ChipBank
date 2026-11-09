import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import type { Game, GamePlayer, Settlement, Transaction } from './types';

export type GameState = {
  game: Game;
  players: GamePlayer[];
  txns: Transaction[];
  settlements: Settlement[];
};

/**
 * Loads a game and keeps it live: any change to the game, its players, its
 * ledger, or its settlements (from any device) triggers a refetch.
 */
export function useGame(id: string) {
  const [state, setState] = useState<GameState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const [g, p, t, s] = await Promise.all([
      supabase.from('games').select('*').eq('id', id).maybeSingle(),
      supabase.from('game_players')
        .select('*, profile:profiles(id, username, display_name, venmo_handle)')
        .eq('game_id', id).order('joined_at'),
      supabase.from('transactions').select('*').eq('game_id', id).order('seq'),
      supabase.from('settlements').select('*').eq('game_id', id).order('amount_cents', { ascending: false }),
    ]);
    if (!g.data) { setNotFound(true); return; }
    setState({
      game: g.data as Game,
      players: (p.data ?? []) as GamePlayer[],
      txns: (t.data ?? []) as Transaction[],
      settlements: (s.data ?? []) as Settlement[],
    });
  }, [id]);

  useEffect(() => {
    load();
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 120);
    };
    const channel = supabase
      .channel(`game-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${id}` }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${id}` }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions', filter: `game_id=eq.${id}` }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements', filter: `game_id=eq.${id}` }, schedule)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [id, load]);

  return { state, notFound, reload: load };
}

/** Re-render every second (for timers). */
export function useNow(active = true, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [active, intervalMs]);
  return now;
}
