-- Permet de quitter / supprimer un camping multijoueur depuis le salon (à exécuter une fois dans Supabase > SQL Editor)
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
