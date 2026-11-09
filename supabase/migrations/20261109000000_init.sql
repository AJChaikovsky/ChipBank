-- ChipBank schema: a ledger for home poker games. The app never holds money.
-- Money is always stored as integer cents. The ledger is append-only: rows in
-- `transactions` are never edited, only voided.
--
-- Clients can READ through RLS-protected tables, but every WRITE goes through a
-- SECURITY DEFINER function below, which enforces "host is the banker".

-- ─────────────────────────────────────────────────────────────── tables ──

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name  text not null check (length(display_name) between 1 and 40),
  avatar_url    text,
  venmo_handle  text check (venmo_handle is null or venmo_handle ~ '^[A-Za-z0-9_-]{1,30}$'),
  created_at    timestamptz not null default now()
);

create table public.friendships (
  requester_id  uuid not null references public.profiles (id) on delete cascade,
  addressee_id  uuid not null references public.profiles (id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'declined', 'blocked')),
  created_at    timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
-- One row per pair, whichever direction it was sent.
create unique index friendships_pair_uniq
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 60),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  primary key (group_id, user_id)
);

create table public.games (
  id                    uuid primary key default gen_random_uuid(),
  group_id              uuid references public.groups (id) on delete set null,
  host_id               uuid not null references public.profiles (id),
  name                  text not null check (length(name) between 1 and 60),
  status                text not null default 'lobby'
                        check (status in ('lobby', 'active', 'settling', 'settled')),
  default_buy_in_cents  bigint not null default 0 check (default_buy_in_cents >= 0),
  join_code             text not null unique,
  started_at            timestamptz,
  ended_at              timestamptz,
  paused_at             timestamptz,
  total_paused_ms       bigint not null default 0,
  created_at            timestamptz not null default now()
);

create table public.game_players (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games (id) on delete cascade,
  user_id     uuid references public.profiles (id) on delete set null,
  guest_name  text check (guest_name is null or length(guest_name) between 1 and 40),
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  status      text not null default 'active' check (status in ('active', 'cashed_out')),
  created_at  timestamptz not null default now()
);
create unique index game_players_user_uniq on public.game_players (game_id, user_id) where user_id is not null;
create index game_players_user_idx on public.game_players (user_id);

create table public.transactions (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity unique,  -- strict ledger order
  game_id         uuid not null references public.games (id) on delete cascade,
  game_player_id  uuid not null references public.game_players (id) on delete cascade,
  type            text not null check (type in ('buy_in', 'rebuy', 'cash_out', 'adjustment')),
  amount_cents    bigint not null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default clock_timestamp(),
  voided_at       timestamptz,
  voided_by       uuid references public.profiles (id) on delete set null,
  -- only adjustments may be negative; buy-ins must be positive
  check (type = 'adjustment' or amount_cents >= 0),
  check (type not in ('buy_in', 'rebuy') or amount_cents > 0)
);
create index transactions_game_idx on public.transactions (game_id);
create index transactions_player_idx on public.transactions (game_player_id);

create table public.settlements (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid not null references public.games (id) on delete cascade,
  from_player_id  uuid not null references public.game_players (id) on delete cascade,
  to_player_id    uuid not null references public.game_players (id) on delete cascade,
  amount_cents    bigint not null check (amount_cents > 0),
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  check (from_player_id <> to_player_id)
);
create index settlements_game_idx on public.settlements (game_id);

-- ─────────────────────────────────────────────────────────────── helpers ──

create function public.is_group_member(p_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = auth.uid()
  );
$$;

create function public.is_game_member(p_game uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.games g
    where g.id = p_game
      and (
        g.host_id = auth.uid()
        or exists (select 1 from public.game_players gp where gp.game_id = g.id and gp.user_id = auth.uid())
        or (g.group_id is not null and exists (
              select 1 from public.group_members m where m.group_id = g.group_id and m.user_id = auth.uid()))
      )
  );
$$;

create function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and least(requester_id, addressee_id) = least(a, b)
      and greatest(requester_id, addressee_id) = greatest(a, b)
  );
$$;

create function public._gen_join_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O/1/I
  code  text := '';
begin
  for i in 1..6 loop
    code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return code;
end $$;

-- Loads a game, verifies the caller is its host, and locks the row so that
-- concurrent ledger writes on the same game serialize.
create function public._host_game(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Game not found'; end if;
  if g.host_id <> auth.uid() then raise exception 'Only the host can do that'; end if;
  return g;
end $$;

create function public._assert_open(g public.games)
returns void language plpgsql set search_path = '' as $$
begin
  if g.status not in ('lobby', 'active') then
    raise exception 'This game is already settled';
  end if;
end $$;

-- A player counts as cashed out when their most recent live money movement
-- is a cash-out. A rebuy after cashing out puts them back in the game.
create function public._refresh_player_status(p_player uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare last_t public.transactions;
begin
  select * into last_t from public.transactions
  where game_player_id = p_player and voided_at is null and type <> 'adjustment'
  order by seq desc limit 1;

  if found and last_t.type = 'cash_out' then
    update public.game_players set status = 'cashed_out', left_at = last_t.created_at where id = p_player;
  else
    update public.game_players set status = 'active', left_at = null where id = p_player;
  end if;
end $$;

create function public._add_player(p_game uuid, p_user uuid, p_guest text, p_buy_in bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_player uuid;
begin
  insert into public.game_players (game_id, user_id, guest_name)
  values (p_game, p_user, nullif(trim(p_guest), ''))
  returning id into v_player;

  if coalesce(p_buy_in, 0) > 0 then
    insert into public.transactions (game_id, game_player_id, type, amount_cents, created_by)
    values (p_game, v_player, 'buy_in', p_buy_in, auth.uid());
  end if;
  return v_player;
end $$;

-- ───────────────────────────────────────────────────── profile & signup ──

create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_username text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  v_display  text := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), v_username);
begin
  if v_username !~ '^[a-z0-9_]{3,20}$'
     or exists (select 1 from public.profiles where username = v_username) then
    v_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);
  end if;
  if v_display = '' then v_display := v_username; end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, left(v_display, 40));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = '' as $$
  select lower(p_username) ~ '^[a-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles where username = lower(p_username));
$$;

-- ─────────────────────────────────────────────────────────────── friends ──

create function public.send_friend_request(p_username text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  f       public.friendships;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select id into v_other from public.profiles where username = lower(trim(p_username));
  if v_other is null then raise exception 'No user with that username'; end if;
  if v_other = me then raise exception 'You cannot friend yourself'; end if;

  select * into f from public.friendships
  where least(requester_id, addressee_id) = least(me, v_other)
    and greatest(requester_id, addressee_id) = greatest(me, v_other);

  if not found then
    insert into public.friendships (requester_id, addressee_id) values (me, v_other);
    return 'requested';
  elsif f.status = 'accepted' then
    return 'already_friends';
  elsif f.status = 'blocked' then
    raise exception 'Cannot send a request to this user';
  elsif f.status = 'pending' and f.addressee_id = me then
    -- they already asked us: accept
    update public.friendships set status = 'accepted'
    where requester_id = f.requester_id and addressee_id = f.addressee_id;
    return 'accepted';
  elsif f.status = 'pending' then
    return 'requested';
  else -- declined: start over with us as requester
    delete from public.friendships where requester_id = f.requester_id and addressee_id = f.addressee_id;
    insert into public.friendships (requester_id, addressee_id) values (me, v_other);
    return 'requested';
  end if;
end $$;

create function public.respond_friend_request(p_requester uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.friendships
  set status = case when p_accept then 'accepted' else 'declined' end
  where requester_id = p_requester and addressee_id = auth.uid() and status = 'pending';
  if not found then raise exception 'No pending request from that user'; end if;
end $$;

-- Unfriend, or cancel a request you sent.
create function public.remove_friend(p_other uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.friendships
  where least(requester_id, addressee_id) = least(auth.uid(), p_other)
    and greatest(requester_id, addressee_id) = greatest(auth.uid(), p_other)
    and status in ('accepted', 'pending');
end $$;

-- ──────────────────────────────────────────────────────────────── groups ──

create function public.create_group(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.groups (name, owner_id) values (trim(p_name), auth.uid()) returning id into v_id;
  insert into public.group_members (group_id, user_id, role) values (v_id, auth.uid(), 'owner');
  return v_id;
end $$;

create function public.add_group_member(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.groups where id = p_group and owner_id = auth.uid()) then
    raise exception 'Only the group owner can add members';
  end if;
  if not public.are_friends(auth.uid(), p_user) then
    raise exception 'You can only add friends to a group';
  end if;
  insert into public.group_members (group_id, user_id) values (p_group, p_user)
  on conflict do nothing;
end $$;

create function public.remove_group_member(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select owner_id into v_owner from public.groups where id = p_group;
  if v_owner is null then raise exception 'Group not found'; end if;
  if p_user = v_owner then raise exception 'The owner cannot leave; delete the group instead'; end if;
  if auth.uid() <> v_owner and auth.uid() <> p_user then
    raise exception 'Only the owner can remove other members';
  end if;
  delete from public.group_members where group_id = p_group and user_id = p_user;
end $$;

create function public.delete_group(p_group uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.groups where id = p_group and owner_id = auth.uid();
  if not found then raise exception 'Only the group owner can delete it'; end if;
end $$;

-- ───────────────────────────────────────────────────────── game lifecycle ──

create function public.create_game(
  p_name text,
  p_group_id uuid default null,
  p_default_buy_in_cents bigint default 0
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := auth.uid();
  v_game uuid;
  v_code text;
  v_member uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if p_group_id is not null and not public.is_group_member(p_group_id) then
    raise exception 'You are not in that group';
  end if;
  if coalesce(p_default_buy_in_cents, 0) < 0 then raise exception 'Buy-in cannot be negative'; end if;

  loop
    v_code := public._gen_join_code();
    exit when not exists (select 1 from public.games where join_code = v_code);
  end loop;

  insert into public.games (name, group_id, host_id, default_buy_in_cents, join_code)
  values (coalesce(nullif(trim(p_name), ''), 'Home game'), p_group_id, me, coalesce(p_default_buy_in_cents, 0), v_code)
  returning id into v_game;

  -- Host and (optionally) the whole crew are seated; buy-ins are logged when
  -- the game starts so nobody is charged for a seat they never took.
  perform public._add_player(v_game, me, null, 0);
  if p_group_id is not null then
    for v_member in
      select user_id from public.group_members where group_id = p_group_id and user_id <> me
    loop
      perform public._add_player(v_game, v_member, null, 0);
    end loop;
  end if;
  return v_game;
end $$;

-- Join with a code (players without an invite). Money is still logged by the host.
create function public.join_game(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into g from public.games where join_code = upper(trim(p_code));
  if not found then raise exception 'No game with that code'; end if;
  if g.status not in ('lobby', 'active') then raise exception 'That game has ended'; end if;
  if not exists (select 1 from public.game_players where game_id = g.id and user_id = auth.uid()) then
    perform public._add_player(g.id, auth.uid(), null, 0);
  end if;
  return g.id;
end $$;

create function public.add_player(
  p_game uuid,
  p_user_id uuid default null,
  p_guest_name text default null,
  p_buy_in_cents bigint default 0
) returns uuid language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  g := public._host_game(p_game);
  perform public._assert_open(g);
  if (p_user_id is null) = (nullif(trim(p_guest_name), '') is null) then
    raise exception 'Provide either a friend or a guest name';
  end if;
  if p_user_id is not null then
    if exists (select 1 from public.game_players where game_id = p_game and user_id = p_user_id) then
      raise exception 'That player is already in the game';
    end if;
    if not public.are_friends(auth.uid(), p_user_id)
       and not (g.group_id is not null and exists (
         select 1 from public.group_members where group_id = g.group_id and user_id = p_user_id)) then
      raise exception 'You can only add friends or crew members';
    end if;
  end if;
  if coalesce(p_buy_in_cents, 0) < 0 then raise exception 'Buy-in cannot be negative'; end if;
  return public._add_player(p_game, p_user_id, p_guest_name, p_buy_in_cents);
end $$;

-- Remove someone who was seated but never put money in.
create function public.remove_player(p_player uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare gp public.game_players; g public.games;
begin
  select * into gp from public.game_players where id = p_player;
  if not found then raise exception 'Player not found'; end if;
  g := public._host_game(gp.game_id);
  perform public._assert_open(g);
  if gp.user_id = g.host_id then raise exception 'The host cannot be removed'; end if;
  if exists (select 1 from public.transactions where game_player_id = p_player and voided_at is null) then
    raise exception 'This player has money on the ledger. Void it first or cash them out.';
  end if;
  delete from public.game_players where id = p_player;
end $$;

create function public.start_game(p_game uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.games; v_player uuid;
begin
  g := public._host_game(p_game);
  if g.status <> 'lobby' then raise exception 'Game already started'; end if;
  update public.games set status = 'active', started_at = now() where id = p_game;
  -- seat everyone who has not bought in yet at the default buy-in
  if g.default_buy_in_cents > 0 then
    for v_player in
      select gp.id from public.game_players gp
      where gp.game_id = p_game
        and not exists (select 1 from public.transactions t where t.game_player_id = gp.id and t.voided_at is null)
    loop
      insert into public.transactions (game_id, game_player_id, type, amount_cents, created_by)
      values (p_game, v_player, 'buy_in', g.default_buy_in_cents, auth.uid());
    end loop;
  end if;
end $$;

create function public.pause_game(p_game uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  g := public._host_game(p_game);
  if g.status <> 'active' then raise exception 'Game is not running'; end if;
  if g.paused_at is not null then return; end if;
  update public.games set paused_at = now() where id = p_game;
end $$;

create function public.resume_game(p_game uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  g := public._host_game(p_game);
  if g.paused_at is null then return; end if;
  update public.games
  set total_paused_ms = total_paused_ms + floor(extract(epoch from (now() - g.paused_at)) * 1000)::bigint,
      paused_at = null
  where id = p_game;
end $$;

-- ───────────────────────────────────────────────────────────────── ledger ──

-- Buy-in or rebuy (the first live buy-in is a buy_in, later ones are rebuys).
-- Rebuying after a cash-out brings the player back into the game.
create function public.record_buy_in(p_player uuid, p_amount_cents bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare gp public.game_players; g public.games; v_type text; v_id uuid;
begin
  select * into gp from public.game_players where id = p_player;
  if not found then raise exception 'Player not found'; end if;
  g := public._host_game(gp.game_id);
  perform public._assert_open(g);
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Amount must be positive'; end if;

  v_type := case when exists (
    select 1 from public.transactions
    where game_player_id = p_player and voided_at is null and type in ('buy_in', 'rebuy')
  ) then 'rebuy' else 'buy_in' end;

  insert into public.transactions (game_id, game_player_id, type, amount_cents, created_by)
  values (gp.game_id, p_player, v_type, p_amount_cents, auth.uid())
  returning id into v_id;
  perform public._refresh_player_status(p_player);
  return v_id;
end $$;

create function public.cash_out(p_player uuid, p_amount_cents bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare gp public.game_players; g public.games; v_id uuid;
begin
  select * into gp from public.game_players where id = p_player;
  if not found then raise exception 'Player not found'; end if;
  g := public._host_game(gp.game_id);
  perform public._assert_open(g);
  if gp.status = 'cashed_out' then raise exception 'Player already cashed out'; end if;
  if p_amount_cents is null or p_amount_cents < 0 then raise exception 'Amount cannot be negative'; end if;

  insert into public.transactions (game_id, game_player_id, type, amount_cents, created_by)
  values (gp.game_id, p_player, 'cash_out', p_amount_cents, auth.uid())
  returning id into v_id;
  perform public._refresh_player_status(p_player);
  return v_id;
end $$;

create function public.void_transaction(p_txn uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.transactions; g public.games;
begin
  select * into t from public.transactions where id = p_txn;
  if not found then raise exception 'Transaction not found'; end if;
  g := public._host_game(t.game_id);
  perform public._assert_open(g);
  if t.voided_at is not null then return; end if;
  update public.transactions set voided_at = now(), voided_by = auth.uid() where id = p_txn;
  perform public._refresh_player_status(t.game_player_id);
end $$;

-- ────────────────────────────────────────────────────────────── settlement ──

-- Per-player net = cash-outs + adjustments − buy-ins, over live transactions.
create function public.game_nets(p_game uuid)
returns table (game_player_id uuid, buy_in_cents bigint, cash_out_cents bigint, adjustment_cents bigint, net_cents bigint)
language sql stable security definer set search_path = '' as $$
  select gp.id,
         coalesce(sum(t.amount_cents) filter (where t.type in ('buy_in', 'rebuy')), 0)::bigint,
         coalesce(sum(t.amount_cents) filter (where t.type = 'cash_out'), 0)::bigint,
         coalesce(sum(t.amount_cents) filter (where t.type = 'adjustment'), 0)::bigint,
         ( coalesce(sum(t.amount_cents) filter (where t.type in ('cash_out', 'adjustment')), 0)
         - coalesce(sum(t.amount_cents) filter (where t.type in ('buy_in', 'rebuy')), 0))::bigint
  from public.game_players gp
  left join public.transactions t on t.game_player_id = gp.id and t.voided_at is null
  where gp.game_id = p_game
    and public.is_game_member(p_game)
  group by gp.id;
$$;

-- Ends the game and writes who-pays-whom.
--   p_mismatch: 'strict'       → refuse if cash-outs ≠ buy-ins
--               'proportional' → spread the difference across players by buy-in
--   p_payout:   'minimize'     → biggest loser pays biggest winner (≤ n−1 payments)
--               'host'         → everyone settles with the host
create function public.finalize_game(
  p_game uuid,
  p_mismatch text default 'strict',
  p_payout text default 'minimize'
) returns void language plpgsql security definer set search_path = '' as $$
declare
  g           public.games;
  v_active    int;
  v_in        bigint;
  v_out       bigint;
  v_diff      bigint;
  v_host_gp   uuid;
  c_ids uuid[]; c_amt bigint[];
  d_ids uuid[]; d_amt bigint[];
  i int := 1; j int := 1; amt bigint;
  r record;
begin
  g := public._host_game(p_game);
  perform public._assert_open(g);
  if p_mismatch not in ('strict', 'proportional') then raise exception 'Bad mismatch mode'; end if;
  if p_payout not in ('minimize', 'host') then raise exception 'Bad payout mode'; end if;

  select count(*) into v_active from public.game_players where game_id = p_game and status = 'active';
  if v_active > 0 then
    raise exception '% player(s) still have chips. Cash everyone out first.', v_active;
  end if;

  select coalesce(sum(buy_in_cents), 0), coalesce(sum(cash_out_cents + adjustment_cents), 0)
    into v_in, v_out from public.game_nets(p_game);
  if v_in = 0 then raise exception 'Nobody bought in'; end if;
  v_diff := v_out - v_in;

  if v_diff <> 0 then
    if p_mismatch = 'strict' then
      raise exception 'Ledger is off by % cents (cash-outs minus buy-ins)', v_diff;
    end if;
    -- Largest-remainder split of −diff, proportional to each player's buy-in.
    -- Mirrors proportionalAdjustments() in src/lib/settle.ts.
    for r in
      with base as (
        select n.game_player_id,
               (-v_diff)::numeric * n.buy_in_cents / v_in as exact
        from public.game_nets(p_game) n
        where n.buy_in_cents > 0
      ), floored as (
        select game_player_id, floor(exact)::bigint as fl, exact - floor(exact) as frac from base
      ), ranked as (
        select *, row_number() over (order by frac desc, game_player_id) as rn,
               (-v_diff) - sum(fl) over () as remainder
        from floored
      )
      select game_player_id, fl + case when rn <= remainder then 1 else 0 end as adj from ranked
    loop
      if r.adj <> 0 then
        insert into public.transactions (game_id, game_player_id, type, amount_cents, created_by)
        values (p_game, r.game_player_id, 'adjustment', r.adj, auth.uid());
      end if;
    end loop;
  end if;

  delete from public.settlements where game_id = p_game;

  if p_payout = 'host' then
    select id into v_host_gp from public.game_players where game_id = p_game and user_id = g.host_id;
    for r in select * from public.game_nets(p_game) where game_player_id <> v_host_gp and net_cents <> 0 loop
      if r.net_cents < 0 then
        insert into public.settlements (game_id, from_player_id, to_player_id, amount_cents)
        values (p_game, r.game_player_id, v_host_gp, -r.net_cents);
      else
        insert into public.settlements (game_id, from_player_id, to_player_id, amount_cents)
        values (p_game, v_host_gp, r.game_player_id, r.net_cents);
      end if;
    end loop;
  else
    -- Greedy: biggest debtor pays biggest creditor. Mirrors settle() in src/lib/settle.ts,
    -- including tie-breaks (amount desc, then id asc).
    select array_agg(game_player_id order by net_cents desc, game_player_id),
           array_agg(net_cents      order by net_cents desc, game_player_id)
      into c_ids, c_amt from public.game_nets(p_game) where net_cents > 0;
    select array_agg(game_player_id order by net_cents asc, game_player_id),
           array_agg(-net_cents     order by net_cents asc, game_player_id)
      into d_ids, d_amt from public.game_nets(p_game) where net_cents < 0;

    while i <= coalesce(array_length(d_ids, 1), 0) and j <= coalesce(array_length(c_ids, 1), 0) loop
      amt := least(d_amt[i], c_amt[j]);
      insert into public.settlements (game_id, from_player_id, to_player_id, amount_cents)
      values (p_game, d_ids[i], c_ids[j], amt);
      d_amt[i] := d_amt[i] - amt;
      c_amt[j] := c_amt[j] - amt;
      if d_amt[i] = 0 then i := i + 1; end if;
      if c_amt[j] = 0 then j := j + 1; end if;
    end loop;
  end if;

  update public.games
  set status = 'settled',
      ended_at = now(),
      total_paused_ms = case when paused_at is null then total_paused_ms
                             else total_paused_ms + floor(extract(epoch from (now() - paused_at)) * 1000)::bigint end,
      paused_at = null
  where id = p_game;
end $$;

-- Payer, payee, or host can mark a payment as paid (or unpaid).
create function public.mark_settlement_paid(p_settlement uuid, p_paid boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.settlements;
begin
  select * into s from public.settlements where id = p_settlement;
  if not found then raise exception 'Payment not found'; end if;
  if not (
    exists (select 1 from public.games where id = s.game_id and host_id = auth.uid())
    or exists (select 1 from public.game_players
               where id in (s.from_player_id, s.to_player_id) and user_id = auth.uid())
  ) then
    raise exception 'Only the payer, payee, or host can update this';
  end if;
  update public.settlements set paid_at = case when p_paid then now() else null end where id = p_settlement;
end $$;

-- ────────────────────────────────────────────────────────────────── stats ──

create view public.player_results with (security_invoker = true) as
select gp.game_id,
       gp.id as game_player_id,
       gp.user_id,
       g.name as game_name,
       g.group_id,
       g.ended_at,
       coalesce(sum(t.amount_cents) filter (where t.type in ('buy_in', 'rebuy')), 0)::bigint as buy_in_cents,
       ( coalesce(sum(t.amount_cents) filter (where t.type in ('cash_out', 'adjustment')), 0)
       - coalesce(sum(t.amount_cents) filter (where t.type in ('buy_in', 'rebuy')), 0))::bigint as net_cents
from public.game_players gp
join public.games g on g.id = gp.game_id and g.status = 'settled'
left join public.transactions t on t.game_player_id = gp.id and t.voided_at is null
group by gp.game_id, gp.id, gp.user_id, g.name, g.group_id, g.ended_at;

-- ──────────────────────────────────────────────────────────────────── RLS ──

alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.games         enable row level security;
alter table public.game_players  enable row level security;
alter table public.transactions  enable row level security;
alter table public.settlements   enable row level security;

-- Profiles are public to signed-in users (needed for username search).
create policy "profiles readable" on public.profiles for select to authenticated using (true);
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "see own friendships" on public.friendships for select to authenticated
  using (auth.uid() in (requester_id, addressee_id));

create policy "see my groups" on public.groups for select to authenticated
  using (public.is_group_member(id));
create policy "see my group members" on public.group_members for select to authenticated
  using (public.is_group_member(group_id));

create policy "see my games" on public.games for select to authenticated
  using (public.is_game_member(id));
create policy "see players in my games" on public.game_players for select to authenticated
  using (public.is_game_member(game_id));
create policy "see ledger of my games" on public.transactions for select to authenticated
  using (public.is_game_member(game_id));
create policy "see settlements of my games" on public.settlements for select to authenticated
  using (public.is_game_member(game_id));

-- Profiles: users may only change cosmetic columns directly.
revoke all on all tables in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;
grant update (display_name, avatar_url, venmo_handle) on public.profiles to authenticated;

-- Functions: lock everything down, then open up the public API.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_group_member(uuid),
  public.is_game_member(uuid),
  public.are_friends(uuid, uuid),
  public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean),
  public.remove_friend(uuid),
  public.create_group(text),
  public.add_group_member(uuid, uuid),
  public.remove_group_member(uuid, uuid),
  public.delete_group(uuid),
  public.create_game(text, uuid, bigint),
  public.join_game(text),
  public.add_player(uuid, uuid, text, bigint),
  public.remove_player(uuid),
  public.start_game(uuid),
  public.pause_game(uuid),
  public.resume_game(uuid),
  public.record_buy_in(uuid, bigint),
  public.cash_out(uuid, bigint),
  public.void_transaction(uuid),
  public.game_nets(uuid),
  public.finalize_game(uuid, text, text),
  public.mark_settlement_paid(uuid, boolean),
  public.username_available(text)
to authenticated;
grant execute on function public.username_available(text) to anon;

-- ─────────────────────────────────────────────────────────────── realtime ──

alter publication supabase_realtime
  add table public.games, public.game_players, public.transactions, public.settlements;
