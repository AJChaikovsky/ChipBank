-- In-app account deletion (required by App Store guideline 5.1.1(v)).
--
-- What happens to a deleted user's data:
--   • profile, friendships, crew memberships → deleted
--   • crews they own → deleted (games from those crews are kept)
--   • their seats in past games → kept as guests under their display name, so
--     friends' ledgers and results still add up
--   • games they hosted → kept, with no host
-- They can't delete while they're the banker of a game that is still open.

alter table public.games alter column host_id drop not null;
alter table public.games drop constraint games_host_id_fkey;
alter table public.games add constraint games_host_id_fkey
  foreign key (host_id) references public.profiles (id) on delete set null;

create function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := auth.uid();
  v_name text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.games where host_id = me and status <> 'settled') then
    raise exception 'You are the banker of a game that is still open. Settle it before deleting your account.';
  end if;

  select display_name into v_name from public.profiles where id = me;
  update public.game_players
  set guest_name = coalesce(guest_name, v_name, 'Former player'), user_id = null
  where user_id = me;

  delete from auth.users where id = me;  -- cascades to profiles and everything above
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
