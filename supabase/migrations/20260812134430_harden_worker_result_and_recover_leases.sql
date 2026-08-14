create or replace function public.claim_next_worker_task()
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
  reclaimed_task public.tasks;
  selected_task public.tasks;
begin
  for reclaimed_task in
    select *
    from public.tasks
    where status = 'running'
      and claimed_at < now() - interval '30 minutes'
    for update skip locked
  loop
    update public.task_runs task_run
    set status = 'failed',
        result = jsonb_build_object(
          'version', 'worker-result/v1',
          'taskId', reclaimed_task.id,
          'status', 'failed',
          'artifacts', jsonb_build_array(),
          'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array(jsonb_build_object('name', 'worker_lease', 'passed', false, 'detail', 'Worker lease expired before it reported a result.'))),
          'actualCostCents', 0,
          'blockers', jsonb_build_array(),
          'retry', jsonb_build_object('shouldRetry', reclaimed_task.attempt < reclaimed_task.max_attempts, 'reason', 'Worker lease expired.'),
          'nextStep', 'Retry the task only after the worker is available.'
        ),
        completed_at = now()
    where task_run.task_id = reclaimed_task.id
      and task_run.status = 'running';

    update public.tasks task
    set status = case when reclaimed_task.attempt < reclaimed_task.max_attempts then 'ready'::public.task_status else 'failed'::public.task_status end,
        claimed_at = null,
        completed_at = case when reclaimed_task.attempt < reclaimed_task.max_attempts then null else now() end,
        last_result = jsonb_build_object(
          'version', 'worker-result/v1',
          'taskId', reclaimed_task.id,
          'status', 'failed',
          'artifacts', jsonb_build_array(),
          'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array(jsonb_build_object('name', 'worker_lease', 'passed', false, 'detail', 'Worker lease expired before it reported a result.'))),
          'actualCostCents', 0,
          'blockers', jsonb_build_array(),
          'retry', jsonb_build_object('shouldRetry', reclaimed_task.attempt < reclaimed_task.max_attempts, 'reason', 'Worker lease expired.'),
          'nextStep', 'Retry the task only after the worker is available.'
        )
    where task.id = reclaimed_task.id;

    insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
    select episode.account_id, episode.id, 'worker_lease_expired', jsonb_build_object('task_id', reclaimed_task.id, 'attempt', reclaimed_task.attempt - 1), null
    from public.episodes episode
    where episode.id = reclaimed_task.episode_id;
  end loop;

  select * into selected_task
  from public.tasks task
  where task.status = 'ready'
    and task.provider = 'codex'
    and task.attempt < task.max_attempts
  order by task.created_at
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;

  update public.tasks task
  set status = 'running',
      claimed_at = now(),
      attempt = task.attempt + 1
  where task.id = selected_task.id;

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

create or replace function public.report_worker_result(p_task_id uuid, p_attempt integer, p_result jsonb)
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
  artifact jsonb;
  validation_check jsonb;
  blocker jsonb;
  required_artifact_type text;
  normalized_path text;
begin
  if jsonb_typeof(p_result) <> 'object'
    or p_result ->> 'version' <> 'worker-result/v1'
    or p_result ->> 'taskId' <> p_task_id::text
    or jsonb_typeof(p_result -> 'status') <> 'string'
    or jsonb_typeof(p_result -> 'actualCostCents') <> 'number'
    or p_result ->> 'actualCostCents' !~ '^[0-9]+$'
    or jsonb_typeof(p_result -> 'retry') <> 'object'
    or jsonb_typeof(p_result -> 'retry' -> 'shouldRetry') <> 'boolean'
    or coalesce(btrim(p_result -> 'retry' ->> 'reason'), '') = ''
    or jsonb_typeof(p_result -> 'artifacts') <> 'array'
    or jsonb_typeof(p_result -> 'validation') <> 'object'
    or jsonb_typeof(p_result -> 'validation' -> 'passed') <> 'boolean'
    or jsonb_typeof(p_result -> 'validation' -> 'checks') <> 'array'
    or jsonb_typeof(p_result -> 'blockers') <> 'array'
    or jsonb_typeof(p_result -> 'nextStep') <> 'string'
    or coalesce(btrim(p_result ->> 'nextStep'), '') = '' then
    raise exception 'Worker result has an invalid schema' using errcode = '22023';
  end if;
  if p_result ->> 'status' not in ('completed', 'blocked', 'failed') then
    raise exception 'Worker result status is invalid' using errcode = '22023';
  end if;

  for validation_check in select value from jsonb_array_elements(p_result -> 'validation' -> 'checks') loop
    if jsonb_typeof(validation_check) <> 'object'
      or jsonb_typeof(validation_check -> 'name') <> 'string'
      or coalesce(btrim(validation_check ->> 'name'), '') = ''
      or jsonb_typeof(validation_check -> 'passed') <> 'boolean'
      or jsonb_typeof(validation_check -> 'detail') <> 'string'
      or coalesce(btrim(validation_check ->> 'detail'), '') = '' then
      raise exception 'Worker validation check has an invalid schema' using errcode = '22023';
    end if;
  end loop;

  for blocker in select value from jsonb_array_elements(p_result -> 'blockers') loop
    if jsonb_typeof(blocker) <> 'object'
      or jsonb_typeof(blocker -> 'code') <> 'string'
      or coalesce(btrim(blocker ->> 'code'), '') = ''
      or jsonb_typeof(blocker -> 'detail') <> 'string'
      or coalesce(btrim(blocker ->> 'detail'), '') = '' then
      raise exception 'Worker blocker has an invalid schema' using errcode = '22023';
    end if;
  end loop;

  for artifact in select value from jsonb_array_elements(p_result -> 'artifacts') loop
    normalized_path := replace(artifact ->> 'relativePath', E'\\', '/');
    if jsonb_typeof(artifact) <> 'object'
      or jsonb_typeof(artifact -> 'artifactType') <> 'string'
      or coalesce(btrim(artifact ->> 'artifactType'), '') = ''
      or jsonb_typeof(artifact -> 'relativePath') <> 'string'
      or normalized_path = ''
      or normalized_path ~ '(^/|^[A-Za-z]:/|(^|/)([.]|[.][.])(/|$)|//|/$)'
      or jsonb_typeof(artifact -> 'sha256') <> 'string'
      or artifact ->> 'sha256' !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(artifact -> 'fileSize') <> 'number'
      or artifact ->> 'fileSize' !~ '^[0-9]+$' then
      raise exception 'Worker artifact has an invalid schema' using errcode = '22023';
    end if;
  end loop;

  result_status := (p_result ->> 'status')::public.task_status;
  actual_cost := (p_result ->> 'actualCostCents')::integer;
  should_retry := (p_result -> 'retry' ->> 'shouldRetry')::boolean;

  select * into selected_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = 'P0002';
  end if;
  if selected_task.status <> 'running' or selected_task.attempt <> p_attempt + 1 then
    raise exception 'Task is not running for this attempt' using errcode = '42501';
  end if;
  if selected_task.claimed_at < now() - interval '30 minutes' then
    raise exception 'Worker lease has expired' using errcode = '42501';
  end if;
  if actual_cost > selected_task.budget_limit_cents then
    raise exception 'Worker result cost exceeds task budget' using errcode = '22023';
  end if;
  if not exists (select 1 from public.task_runs where task_id = p_task_id and attempt = p_attempt and status = 'running' for update) then
    raise exception 'Task run does not exist or is already reported' using errcode = '42501';
  end if;

  if result_status = 'completed' and ((p_result -> 'validation' ->> 'passed')::boolean is not true or jsonb_array_length(p_result -> 'artifacts') = 0 or jsonb_array_length(p_result -> 'blockers') > 0) then
    raise exception 'Completed worker result must contain validated artifacts without blockers' using errcode = '22023';
  end if;
  if result_status = 'blocked' and jsonb_array_length(p_result -> 'blockers') = 0 then
    raise exception 'Blocked worker result must include blockers' using errcode = '22023';
  end if;
  if result_status in ('completed', 'blocked') and should_retry then
    raise exception 'Completed or blocked worker result cannot request a retry' using errcode = '22023';
  end if;
  if result_status = 'failed' and should_retry and selected_task.attempt >= selected_task.max_attempts then
    raise exception 'Failed worker result cannot retry after the maximum attempts' using errcode = '22023';
  end if;

  if result_status = 'completed' then
    if jsonb_typeof(selected_task.input_snapshot #> '{output,required_artifact_types}') <> 'array'
      or jsonb_array_length(selected_task.input_snapshot #> '{output,required_artifact_types}') = 0 then
      raise exception 'Task has an invalid output artifact schema' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(selected_task.input_snapshot #> '{output,required_artifact_types}') required_artifact
      where jsonb_typeof(required_artifact) <> 'string'
        or coalesce(btrim(required_artifact #>> '{}'), '') = ''
    ) then
      raise exception 'Task has an invalid output artifact schema' using errcode = '22023';
    end if;
    for required_artifact_type in select value #>> '{}' from jsonb_array_elements(selected_task.input_snapshot #> '{output,required_artifact_types}') loop
      if coalesce(btrim(required_artifact_type), '') = '' then
        raise exception 'Task has an invalid output artifact schema' using errcode = '22023';
      end if;
      if not exists (
        select 1
        from jsonb_array_elements(p_result -> 'artifacts') result_artifact
        where result_artifact ->> 'artifactType' = required_artifact_type
      ) then
        raise exception 'Completed worker result is missing required artifact type %', required_artifact_type using errcode = '22023';
      end if;
    end loop;

    insert into public.artifacts (episode_id, artifact_type, relative_path, sha256, file_size, producer_task_id)
    select
      selected_task.episode_id,
      result_artifact ->> 'artifactType',
      result_artifact ->> 'relativePath',
      result_artifact ->> 'sha256',
      (result_artifact ->> 'fileSize')::bigint,
      selected_task.id
    from jsonb_array_elements(p_result -> 'artifacts') result_artifact;
  end if;

  update public.task_runs
  set result = p_result,
      status = result_status,
      actual_cost_cents = actual_cost,
      completed_at = now()
  where task_id = p_task_id and attempt = p_attempt;

  update public.tasks
  set status = case when result_status = 'failed' and should_retry then 'ready'::public.task_status else result_status end,
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
