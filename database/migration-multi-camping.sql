-- =====================================================================
-- CAMPING v1.1.0 — plusieurs campings par compte (4 maximum)
-- À coller dans Supabase > SQL Editor > New query > Run, AVANT de publier la version 1.1.0.
-- Tu peux le relancer sans risque : rien n'est perdu, les parties existantes deviennent le « camping n°1 ».
-- =====================================================================

-- 1. Un numéro d'emplacement (1 à 4) par camping
alter table public.game_saves add column if not exists slot smallint not null default 1;

-- 2. Clé primaire = (joueur, emplacement) au lieu de « joueur » seul
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.game_saves'::regclass and contype = 'p' and conname = 'game_saves_pkey'
      and array_length(conkey, 1) = 1
  ) then
    alter table public.game_saves drop constraint game_saves_pkey;
    alter table public.game_saves add constraint game_saves_pkey primary key (user_id, slot);
  end if;
end $$;

-- 3. Maximum 4 campings, imposé par la base elle-même (impossible à contourner depuis le jeu)
alter table public.game_saves drop constraint if exists game_saves_slot_range;
alter table public.game_saves add constraint game_saves_slot_range check (slot between 1 and 4);

-- 4. Protection des anciennes versions du jeu (< 1.1.0) : elles ne savent pas qu'il y a plusieurs campings
--    et pourraient écraser les autres. On leur interdit de modifier les campings n°2 à 4.
create or replace function public.guard_old_clients() returns trigger
language plpgsql as $$
begin
  if old.slot <> 1 and (
       new.game_version is null
    or new.game_version !~ '^[0-9]+\.[0-9]+'
    or split_part(new.game_version, '.', 1)::int * 1000 + split_part(new.game_version, '.', 2)::int < 1001
  ) then
    raise exception 'Mets le jeu à jour (version 1.1.0 ou plus) pour utiliser plusieurs campings.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists game_saves_guard_old on public.game_saves;
create trigger game_saves_guard_old before update on public.game_saves for each row execute function public.guard_old_clients();
