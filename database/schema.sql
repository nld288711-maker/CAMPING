-- =====================================================================
-- CAMPING — schéma Supabase (à coller dans SQL Editor > New query > Run)
-- Aucune clé secrète n'est nécessaire. Le script peut être relancé sans risque.
-- =====================================================================

-- ---------- PROFILS (pseudo) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 3 and 20),
  installed_version text,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_uniq on public.profiles (lower(username));
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Création automatique du profil à l'inscription (pseudo lu dans les métadonnées)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare u text;
begin
  u := left(coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1)), 20);
  if char_length(u) < 3 then u := rpad(u, 3, '_'); end if;
  begin
    insert into public.profiles (id, username) values (new.id, u);
  exception when unique_violation then
    insert into public.profiles (id, username) values (new.id, left(u, 14) || '_' || substr(md5(random()::text), 1, 5));
  end;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Vérification de disponibilité d'un pseudo (utilisable avant inscription)
create or replace function public.username_available(p_username text) returns boolean
language sql security definer set search_path = public stable as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(trim(p_username)));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- SAUVEGARDES DE JEU ----------
create table if not exists public.game_saves (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot smallint not null default 1 check (slot between 1 and 4),   -- emplacement du camping (4 par compte)
  meta jsonb not null default '{}'::jsonb,                          -- résumé affiché dans le salon
  save_data jsonb not null,
  save_version integer not null default 1,
  revision bigint not null default 1,          -- anti-conflit entre appareils
  game_version text,
  client_id text,
  updated_at timestamptz not null default now(),
  -- Une sauvegarde vide ou invalide est refusée par la base elle-même
  constraint save_data_valid check (
    jsonb_typeof(save_data) = 'object'
    and jsonb_typeof(save_data->'parcels') = 'array'
    and jsonb_array_length(save_data->'parcels') > 0
    and jsonb_typeof(save_data->'buildings') = 'array'
  ),
  primary key (user_id, slot)
);
-- (base déjà existante) : passage au multi-campings, sans effet sur une base neuve
alter table public.game_saves add column if not exists slot smallint not null default 1;
alter table public.game_saves add column if not exists meta jsonb not null default '{}'::jsonb;

-- La clé primaire passe de (user_id) à (user_id, slot)
do $$
declare nm text; n int;
begin
  select c.conname, array_length(c.conkey, 1) into nm, n
    from pg_constraint c where c.conrelid = 'public.game_saves'::regclass and c.contype = 'p';
  if nm is not null and n = 1 then
    execute format('alter table public.game_saves drop constraint %I', nm);
    alter table public.game_saves add primary key (user_id, slot);
  elsif nm is null then
    alter table public.game_saves add primary key (user_id, slot);
  end if;
end $$;

-- 4 emplacements maximum, imposé par la base elle-même
alter table public.game_saves drop constraint if exists game_saves_slot_range;
alter table public.game_saves add constraint game_saves_slot_range check (slot between 1 and 4);

alter table public.game_saves enable row level security;

drop policy if exists "saves_select_own" on public.game_saves;
create policy "saves_select_own" on public.game_saves for select to authenticated using (auth.uid() = user_id);
drop policy if exists "saves_insert_own" on public.game_saves;
create policy "saves_insert_own" on public.game_saves for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "saves_update_own" on public.game_saves;
create policy "saves_update_own" on public.game_saves for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "saves_delete_own" on public.game_saves;
create policy "saves_delete_own" on public.game_saves for delete to authenticated using (auth.uid() = user_id);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists game_saves_touch on public.game_saves;
create trigger game_saves_touch before update on public.game_saves for each row execute function public.touch_updated_at();

-- ---------- VERSIONS ET ACTUALITÉS (lecture publique, écriture via le tableau de bord) ----------
create table if not exists public.releases (
  version text primary key,
  notes text not null default '',
  windows_url text,
  published_at timestamptz not null default now()
);
alter table public.releases enable row level security;
drop policy if exists "releases_public_read" on public.releases;
create policy "releases_public_read" on public.releases for select to anon, authenticated using (true);

create table if not exists public.news (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null default '',
  published_at timestamptz not null default now()
);
alter table public.news enable row level security;
drop policy if exists "news_public_read" on public.news;
create policy "news_public_read" on public.news for select to anon, authenticated using (true);

-- ---------- DONNÉES D'EXEMPLE ----------
insert into public.releases (version, notes) values
  ('1.0.0', 'Première version avec comptes joueurs, sauvegardes en ligne et mises à jour automatiques.')
on conflict (version) do nothing;
insert into public.news (title, body)
select 'Bienvenue sur CAMPING', 'Crée ton compte, télécharge le jeu et retrouve ton camping sur tous tes ordinateurs.'
where not exists (select 1 from public.news);
