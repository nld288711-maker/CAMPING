-- CAMPING — migration « multijoueur » (2 joueurs par camping)
-- À coller dans Supabase > SQL Editor > New query > Run, AVANT de publier la nouvelle version. Peut être relancé sans risque.
create table if not exists public.shared_campings (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  owner uuid not null references auth.users(id) on delete cascade,
  members uuid[] not null,
  name text not null default 'Camping',
  save_data jsonb not null,
  save_version integer not null default 1,
  revision bigint not null default 1,
  game_version text,
  client_id text,
  updated_at timestamptz not null default now(),
  constraint shared_valid check (jsonb_typeof(save_data) = 'object' and jsonb_typeof(save_data->'parcels') = 'array'
    and jsonb_array_length(save_data->'parcels') > 0 and jsonb_typeof(save_data->'buildings') = 'array'),
  constraint shared_max2 check (cardinality(members) between 1 and 2)
);
alter table public.shared_campings enable row level security;
drop policy if exists "shared_select" on public.shared_campings;
create policy "shared_select" on public.shared_campings for select to authenticated using (auth.uid() = any(members));
drop policy if exists "shared_insert" on public.shared_campings;
create policy "shared_insert" on public.shared_campings for insert to authenticated with check (owner = auth.uid() and members = array[auth.uid()]);
drop policy if exists "shared_update" on public.shared_campings;
create policy "shared_update" on public.shared_campings for update to authenticated using (auth.uid() = any(members)) with check (auth.uid() = any(members));
drop trigger if exists shared_touch on public.shared_campings;
create trigger shared_touch before update on public.shared_campings for each row execute function public.touch_updated_at();

-- Rejoindre un camping avec son code (seul moyen de devenir membre)
create or replace function public.join_shared(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.shared_campings;
begin
  select * into r from public.shared_campings where code = upper(trim(p_code));
  if not found then raise exception 'Code invalide : aucun camping ne correspond.'; end if;
  if auth.uid() = any(r.members) then return r.id; end if;
  if cardinality(r.members) >= 2 then raise exception 'Ce camping est déjà complet (2 joueurs maximum).'; end if;
  update public.shared_campings set members = r.members || auth.uid() where id = r.id;
  return r.id;
end $$;
grant execute on function public.join_shared(text) to authenticated;
