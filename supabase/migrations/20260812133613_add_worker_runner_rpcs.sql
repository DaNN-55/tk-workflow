update public.tasks
set input_snapshot = input_snapshot || jsonb_build_object(
  'output', jsonb_build_object('required_artifact_types', jsonb_build_array('brief'))
)
where task_type = 'draft_brief'
  and not (input_snapshot ? 'output');

create table public.task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  attempt integer not null check (attempt >= 0),
  task_package jsonb not null,
  result jsonb,
  status public.task_status not null default 'running',
  actual_cost_cents integer not null default 0 check (actual_cost_cents >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (task_id, attempt)
);

create index task_runs_task_started_idx on public.task_runs(task_id, started_at desc);

alter table public.task_runs enable row level security;
create policy "members can read worker runs" on public.task_runs for select
using (
  exists (
    select 1
    from public.tasks task
    join public.episodes episode on episode.id = task.episode_id
    where task.id = task_runs.task_id
      and public.is_account_member(episode.account_id)
  )
);
grant select on public.task_runs to authenticated;

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
  values (
    created_episode.id,
    'draft_brief',
    jsonb_build_object(
      'account_id', p_account_id,
      'blueprint_version_id', p_blueprint_version_id,
      'input_artifacts', jsonb_build_array(),
      'output', jsonb_build_object('required_artifact_types', jsonb_build_array('brief'))
    )
  );
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (p_account_id, created_episode.id, 'episode_created', jsonb_build_object('blueprint_version_id', p_blueprint_version_id), auth.uid());
  return created_episode;
end;
$$;

create function public.claim_next_worker_task()
returns table (
  task_id uuid,
  task_type text,
  attempt integer,
  budget_limit_cents integer,
  max_attempts integer,
  provider text,
  model text,
  prompt_version text,
  episode_id uuid,
  account_id uuid,
  blueprint_version_id uuid,
  title text,
  allowed_asset_root text,
  input_snapshot jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_task public.tasks;
begin
  select * into selected_task
  from public.tasks
  where status = 'ready'
    and provider = 'codex'
    and attempt < max_attempts
  order by created_at
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;

  update public.tasks
  set status = 'running',
      claimed_at = now(),
      attempt = attempt + 1
  where id = selected_task.id;

  insert into public.task_runs (task_id, attempt, task_package)
  select
    selected_task.id,
    selected_task.attempt,
    jsonb_build_object(
      'version', 'worker-task/v1',
      'task_id', selected_task.id,
      'task_type', selected_task.task_type,
      'attempt', selected_task.attempt,
      'budget_limit_cents', selected_task.budget_limit_cents,
      'max_attempts', selected_task.max_attempts,
      'provider', selected_task.provider,
      'model', selected_task.model,
      'prompt_version', selected_task.prompt_version,
      'episode_id', episode.id,
      'account_id', account.id,
      'blueprint_version_id', episode.blueprint_version_id,
      'allowed_asset_root', coalesce(blueprint.policy ->> 'asset_root', ''),
      'input_snapshot', selected_task.input_snapshot
    )
  from public.episodes episode
  join public.accounts account on account.id = episode.account_id
  join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
  where episode.id = selected_task.episode_id;

  return query
  select
    selected_task.id,
    selected_task.task_type,
    selected_task.attempt,
    selected_task.budget_limit_cents,
    selected_task.max_attempts,
    selected_task.provider,
    selected_task.model,
    selected_task.prompt_version,
    episode.id,
    account.id,
    episode.blueprint_version_id,
    episode.title,
    coalesce(blueprint.policy ->> 'asset_root', ''),
    selected_task.input_snapshot
  from public.episodes episode
  join public.accounts account on account.id = episode.account_id
  join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
  where episode.id = selected_task.episode_id;
end;
$$;

create function public.report_worker_result(p_task_id uuid, p_attempt integer, p_result jsonb)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_task public.tasks;
  result_status public.task_status;
  actual_cost integer;
  should_retry boolean;
begin
  if jsonb_typeof(p_result) <> 'object'
    or p_result ->> 'taskId' <> p_task_id::text
    or jsonb_typeof(p_result -> 'actualCostCents') <> 'number'
    or jsonb_typeof(p_result -> 'retry') <> 'object'
    or jsonb_typeof(p_result -> 'artifacts') <> 'array'
    or jsonb_typeof(p_result -> 'validation') <> 'object'
    or jsonb_typeof(p_result -> 'blockers') <> 'array' then
    raise exception 'Worker result has an invalid schema' using errcode = '22023';
  end if;

  result_status := (p_result ->> 'status')::public.task_status;
  if result_status not in ('completed', 'blocked', 'failed') then
    raise exception 'Worker result status is invalid' using errcode = '22023';
  end if;
  actual_cost := (p_result ->> 'actualCostCents')::integer;
  if actual_cost < 0 then
    raise exception 'Worker result cost must be non-negative' using errcode = '22023';
  end if;

  select * into selected_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = 'P0002';
  end if;
  if selected_task.status <> 'running' or selected_task.attempt <> p_attempt + 1 then
    raise exception 'Task is not running for this attempt' using errcode = '42501';
  end if;
  if actual_cost > selected_task.budget_limit_cents then
    raise exception 'Worker result cost exceeds task budget' using errcode = '22023';
  end if;
  if not exists (select 1 from public.task_runs where task_id = p_task_id and attempt = p_attempt and status = 'running' for update) then
    raise exception 'Task run does not exist or is already reported' using errcode = '42501';
  end if;
  if result_status = 'completed' and (p_result -> 'validation' ->> 'passed')::boolean is not true then
    raise exception 'Completed worker result must pass validation' using errcode = '22023';
  end if;
  if result_status = 'blocked' and jsonb_array_length(p_result -> 'blockers') = 0 then
    raise exception 'Blocked worker result must include blockers' using errcode = '22023';
  end if;

  if result_status = 'completed' then
    insert into public.artifacts (episode_id, artifact_type, relative_path, sha256, file_size, producer_task_id)
    select
      selected_task.episode_id,
      artifact ->> 'artifactType',
      artifact ->> 'relativePath',
      artifact ->> 'sha256',
      (artifact ->> 'fileSize')::bigint,
      selected_task.id
    from jsonb_array_elements(p_result -> 'artifacts') artifact;
  end if;

  should_retry := coalesce((p_result -> 'retry' ->> 'shouldRetry')::boolean, false)
    and selected_task.attempt < selected_task.max_attempts;

  update public.task_runs
  set result = p_result,
      status = result_status,
      actual_cost_cents = actual_cost,
      completed_at = now()
  where task_id = p_task_id and attempt = p_attempt;

  update public.tasks
  set status = case
        when result_status = 'failed' and should_retry then 'ready'::public.task_status
        else result_status
      end,
      claimed_at = case when result_status = 'failed' and should_retry then null else claimed_at end,
      completed_at = case when result_status = 'failed' and should_retry then null else now() end,
      actual_cost_cents = actual_cost,
      last_result = p_result
  where id = p_task_id
  returning * into selected_task;

  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  select
    episode.account_id,
    episode.id,
    'worker_result_reported',
    jsonb_build_object('task_id', p_task_id, 'attempt', p_attempt, 'status', result_status, 'actual_cost_cents', actual_cost),
    null
  from public.episodes episode
  where episode.id = selected_task.episode_id;

  return selected_task;
end;
$$;

revoke all on function public.claim_next_worker_task() from public, anon, authenticated;
revoke all on function public.report_worker_result(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_next_worker_task() to service_role;
grant execute on function public.report_worker_result(uuid, integer, jsonb) to service_role;
