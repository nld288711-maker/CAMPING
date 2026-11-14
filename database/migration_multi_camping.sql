-- =====================================================================
-- CAMPING — migration « plusieurs campings par compte » (4 maximum)
-- À coller dans Supabase > SQL Editor > New query > Run, AVANT de publier la nouvelle version du jeu.
-- Sans risque : peut être relancé, ne supprime aucune sauvegarde (l'ancien camping devient le camping n°1).
-- =====================================================================
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
