import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth';
import { supabase } from './supabase';
import type { Friendship, ProfileLite } from './types';

const SELECT = `requester_id, addressee_id, status,
  requester:profiles!friendships_requester_id_fkey(id, username, display_name, venmo_handle),
  addressee:profiles!friendships_addressee_id_fkey(id, username, display_name, venmo_handle)`;

export function useFriends() {
  const { userId } = useAuth();
  const [rows, setRows] = useState<Friendship[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase.from('friendships').select(SELECT).in('status', ['pending', 'accepted']);
    setRows((data ?? []) as unknown as Friendship[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => { reload(); }, [reload]);

  const other = (f: Friendship): ProfileLite => (f.requester_id === userId ? f.addressee : f.requester);
  const friends = rows.filter(f => f.status === 'accepted').map(other)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const incoming = rows.filter(f => f.status === 'pending' && f.addressee_id === userId).map(f => f.requester);
  const outgoing = rows.filter(f => f.status === 'pending' && f.requester_id === userId).map(f => f.addressee);

  return { friends, incoming, outgoing, loading, reload };
}
