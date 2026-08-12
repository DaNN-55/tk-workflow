create function public.create_account(
  p_account_name text,
  p_account_slug text,
  p_timezone text,
  p_policy jsonb
)
returns public.accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_account public.accounts;
  created_blueprint public.account_blueprint_versions;
begin
  if not exists (
    select 1 from public.account_memberships
    where user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'An existing owner membership is required to create an account' using errcode = '42501';
  end if;
  if char_length(trim(p_account_name)) = 0 or char_length(trim(p_account_slug)) = 0 then
    raise exception 'Account name and slug are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_policy) <> 'object' then
    raise exception 'Blueprint policy must be a JSON object' using errcode = '22023';
  end if;

  insert into public.accounts (name, slug, timezone)
  values (trim(p_account_name), trim(p_account_slug), p_timezone)
  returning * into created_account;
  insert into public.account_blueprint_versions (account_id, version, policy, is_active)
  values (created_account.id, 1, p_policy, true)
  returning * into created_blueprint;
  update public.accounts
  set current_blueprint_version_id = created_blueprint.id
  where id = created_account.id
  returning * into created_account;
  insert into public.account_memberships (account_id, user_id, role)
  values (created_account.id, auth.uid(), 'owner');
  insert into public.audit_events (account_id, event_type, payload, actor_id)
  values (created_account.id, 'account_created', jsonb_build_object('blueprint_version_id', created_blueprint.id), auth.uid());
  return created_account;
end;
$$;

revoke execute on function public.create_account(text, text, text, jsonb) from public, anon;
grant execute on function public.create_account(text, text, text, jsonb) to authenticated;
