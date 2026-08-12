alter function public.is_account_member(uuid) set search_path = '';
alter function public.has_required_artifacts(uuid, public.episode_stage) set search_path = '';

create or replace function public.create_episode(p_account_id uuid, p_blueprint_version_id uuid, p_title text)
returns public.episodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_episode public.episodes;
  membership_role public.member_role;
begin
  select role into membership_role from public.account_memberships
  where account_id = p_account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to create an episode' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.accounts account
    join public.account_blueprint_versions blueprint
      on blueprint.account_id = account.id
     and blueprint.id = account.current_blueprint_version_id
     and blueprint.is_active
    where account.id = p_account_id and blueprint.id = p_blueprint_version_id
  ) then
    raise exception 'Episode blueprint must be the account active blueprint' using errcode = '22023';
  end if;
  insert into public.episodes (account_id, blueprint_version_id, title)
  values (p_account_id, p_blueprint_version_id, p_title)
  returning * into created_episode;
  insert into public.tasks (episode_id, task_type, input_snapshot)
  values (created_episode.id, 'draft_brief', jsonb_build_object('account_id', p_account_id, 'blueprint_version_id', p_blueprint_version_id));
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (p_account_id, created_episode.id, 'episode_created', jsonb_build_object('blueprint_version_id', p_blueprint_version_id), auth.uid());
  return created_episode;
end;
$$;

create or replace function public.transition_episode(p_episode_id uuid, p_to_stage public.episode_stage, p_reason text)
returns public.episodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_episode public.episodes;
  previous_stage public.episode_stage;
  membership_role public.member_role;
  owner_approval_stages public.episode_stage[] := array[
    'script_approved', 'visual_approved', 'storyboard_approved', 'qc_passed', 'publish_ready', 'published'
  ]::public.episode_stage[];
  review_stages public.episode_stage[] := array[
    'script_review', 'visual_review', 'storyboard_review', 'qc_review', 'publishing_review'
  ]::public.episode_stage[];
begin
  select * into current_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  if not public.is_allowed_episode_transition(current_episode.stage, p_to_stage) then
    raise exception 'Invalid transition from % to %', current_episode.stage, p_to_stage using errcode = '22023';
  end if;
  select role into membership_role from public.account_memberships where account_id = current_episode.account_id and user_id = auth.uid();
  if membership_role is null then
    raise exception 'No membership for this account' using errcode = '42501';
  end if;
  if (p_to_stage = any(owner_approval_stages) or current_episode.stage = any(review_stages)) and membership_role <> 'owner' then
    raise exception 'Owner approval is required for this review decision' using errcode = '42501';
  end if;
  if not public.has_required_artifacts(p_episode_id, p_to_stage) then
    raise exception 'Required artifacts are missing for %', p_to_stage using errcode = '22023';
  end if;
  previous_stage := current_episode.stage;
  update public.episodes set stage = p_to_stage, updated_at = now() where id = p_episode_id returning * into current_episode;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (p_episode_id, previous_stage, p_to_stage, p_reason, auth.uid());
  if p_to_stage = any(owner_approval_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id)
    values (p_episode_id, p_to_stage, 'approved', p_reason, auth.uid());
  elsif previous_stage = any(review_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id)
    values (p_episode_id, previous_stage, 'changes_requested', p_reason, auth.uid());
  end if;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (current_episode.account_id, p_episode_id, 'stage_transition', jsonb_build_object('to_stage', p_to_stage, 'reason', p_reason), auth.uid());
  return current_episode;
end;
$$;

create or replace function public.bootstrap_platform(
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
  if auth.uid() is null then
    raise exception 'An authenticated user is required to bootstrap the platform' using errcode = '42501';
  end if;
  if char_length(trim(p_account_name)) = 0 or char_length(trim(p_account_slug)) = 0 then
    raise exception 'Account name and slug are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_policy) <> 'object' then
    raise exception 'Blueprint policy must be a JSON object' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('loop-control-platform-bootstrap', 0));
  if exists (select 1 from public.account_memberships) then
    raise exception 'The platform has already been bootstrapped' using errcode = '42501';
  end if;
  insert into public.accounts (name, slug, timezone)
  values (trim(p_account_name), trim(p_account_slug), p_timezone)
  returning * into created_account;
  insert into public.account_blueprint_versions (account_id, version, policy, is_active)
  values (created_account.id, 1, p_policy, true)
  returning * into created_blueprint;
  update public.accounts set current_blueprint_version_id = created_blueprint.id where id = created_account.id returning * into created_account;
  insert into public.account_memberships (account_id, user_id, role) values (created_account.id, auth.uid(), 'owner');
  insert into public.audit_events (account_id, event_type, payload, actor_id)
  values (created_account.id, 'platform_bootstrapped', jsonb_build_object('blueprint_version_id', created_blueprint.id), auth.uid());
  return created_account;
end;
$$;

create or replace function public.create_blueprint_version(p_account_id uuid, p_policy jsonb)
returns public.account_blueprint_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  membership_role public.member_role;
  created_blueprint public.account_blueprint_versions;
  next_version integer;
begin
  if jsonb_typeof(p_policy) <> 'object' then
    raise exception 'Blueprint policy must be a JSON object' using errcode = '22023';
  end if;
  select role into membership_role from public.account_memberships where account_id = p_account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to create a blueprint version' using errcode = '42501';
  end if;
  select coalesce(max(version), 0) + 1 into next_version from public.account_blueprint_versions where account_id = p_account_id;
  insert into public.account_blueprint_versions (account_id, version, policy)
  values (p_account_id, next_version, p_policy)
  returning * into created_blueprint;
  insert into public.audit_events (account_id, event_type, payload, actor_id)
  values (p_account_id, 'blueprint_version_created', jsonb_build_object('blueprint_version_id', created_blueprint.id, 'version', next_version), auth.uid());
  return created_blueprint;
end;
$$;

create or replace function public.activate_blueprint_version(p_account_id uuid, p_blueprint_version_id uuid)
returns public.account_blueprint_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  membership_role public.member_role;
  activated_blueprint public.account_blueprint_versions;
begin
  select role into membership_role from public.account_memberships where account_id = p_account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to activate a blueprint version' using errcode = '42501';
  end if;
  update public.account_blueprint_versions set is_active = false where account_id = p_account_id and is_active;
  update public.account_blueprint_versions set is_active = true where account_id = p_account_id and id = p_blueprint_version_id returning * into activated_blueprint;
  if not found then
    raise exception 'Blueprint version does not belong to this account' using errcode = '22023';
  end if;
  update public.accounts set current_blueprint_version_id = p_blueprint_version_id where id = p_account_id;
  insert into public.audit_events (account_id, event_type, payload, actor_id)
  values (p_account_id, 'blueprint_version_activated', jsonb_build_object('blueprint_version_id', p_blueprint_version_id, 'version', activated_blueprint.version), auth.uid());
  return activated_blueprint;
end;
$$;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.accounts, public.account_blueprint_versions, public.account_memberships, public.episodes,
  public.tasks, public.artifacts, public.approvals, public.state_transitions, public.audit_events,
  public.experiments, public.metric_snapshots, public.asset_locks to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_account_member(uuid) to authenticated;
grant execute on function public.bootstrap_platform(text, text, text, jsonb) to authenticated;
grant execute on function public.create_account(text, text, text, jsonb) to authenticated;
grant execute on function public.create_blueprint_version(uuid, jsonb) to authenticated;
grant execute on function public.activate_blueprint_version(uuid, uuid) to authenticated;
grant execute on function public.create_episode(uuid, uuid, text) to authenticated;
grant execute on function public.transition_episode(uuid, public.episode_stage, text) to authenticated;

alter default privileges in schema public revoke execute on functions from public;
