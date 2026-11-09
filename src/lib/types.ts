import type { TxnType } from './settle';

export type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  venmo_handle: string | null;
};

export type ProfileLite = Pick<Profile, 'id' | 'username' | 'display_name' | 'venmo_handle'>;

export type GameStatus = 'lobby' | 'active' | 'settling' | 'settled';

export type Game = {
  id: string;
  group_id: string | null;
  host_id: string | null;
  name: string;
  status: GameStatus;
  default_buy_in_cents: number;
  join_code: string;
  started_at: string | null;
  ended_at: string | null;
  paused_at: string | null;
  total_paused_ms: number;
  created_at: string;
};

export type GamePlayer = {
  id: string;
  game_id: string;
  user_id: string | null;
  guest_name: string | null;
  joined_at: string;
  left_at: string | null;
  status: 'active' | 'cashed_out';
  profile: ProfileLite | null;
};

export type Transaction = {
  id: string;
  seq: number;
  game_id: string;
  game_player_id: string;
  type: TxnType;
  amount_cents: number;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
};

export type Settlement = {
  id: string;
  game_id: string;
  from_player_id: string;
  to_player_id: string;
  amount_cents: number;
  paid_at: string | null;
};

export type Friendship = {
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'blocked';
  requester: ProfileLite;
  addressee: ProfileLite;
};

export type Group = { id: string; name: string; owner_id: string; created_at: string };

export type PlayerResult = {
  game_id: string;
  game_player_id: string;
  user_id: string | null;
  game_name: string;
  group_id: string | null;
  ended_at: string;
  buy_in_cents: number;
  net_cents: number;
};

export const playerName = (p: Pick<GamePlayer, 'guest_name' | 'profile'> | undefined) =>
  p?.profile?.display_name ?? p?.guest_name ?? 'Guest';
