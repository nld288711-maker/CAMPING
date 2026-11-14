-- CAMPING — correctif : suppression des campings + erreur « game_saves_pkey / duplicate key » en multijoueur
-- À coller dans Supabase > SQL Editor > New query > Run. Peut être relancé sans risque, ne supprime aucune sauvegarde.

-- 1) Droit de supprimer son propre camping (sans lui, la suppression « réussit » mais ne supprime rien -> le camping revient)
alter table public.game_saves enable row level security;
drop policy if exists "saves_delete_own" on public.game_saves;
create policy "saves_delete_own" on public.game_saves for delete to authenticated using (auth.uid() = user_id);

-- 2) Retire toute contrainte / index UNIQUE restant sur user_id seul (ancien schéma) : il empêche d'avoir plusieurs campings
do $$
declare r record;
begin
  for r in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.game_saves'::regclass and c.contype = 'u' and array_length(c.conkey, 1) = 1
      and (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) = 'user_id'
  loop execute format('alter table public.game_saves drop constraint %I', r.conname); end loop;

  for r in
    select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.game_saves'::regclass and x.indisunique and not x.indisprimary and x.indnatts = 1
      and (select a.attname from pg_attribute a where a.attrelid = x.indrelid and a.attnum = x.indkey[0]) = 'user_id'
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid)
  loop execute format('drop index public.%I', r.relname); end loop;
end $$;

-- 3) La clé primaire doit être (user_id, slot)
do $$
declare nm text; n int;
begin
  select c.conname, array_length(c.conkey, 1) into nm, n from pg_constraint c where c.conrelid = 'public.game_saves'::regclass and c.contype = 'p';
  if nm is not null and n = 1 then
    execute format('alter table public.game_saves drop constraint %I', nm);
    alter table public.game_saves add primary key (user_id, slot);
  elsif nm is null then
    alter table public.game_saves add primary key (user_id, slot);
  end if;
end $$;

-- 4) Quitter / supprimer un camping multijoueur
create or replace function public.leave_shared(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.shared_campings;
begin
  select * into r from public.shared_campings where id = p_id and auth.uid() = any(members);
  if not found then return; end if;
  if cardinality(r.members) <= 1 then delete from public.shared_campings where id = p_id;
  else update public.shared_campings set members = array_remove(r.members, auth.uid()) where id = p_id; end if;
end $$;
grant execute on function public.leave_shared(uuid) to authenticated;

notify pgrst, 'reload schema';
