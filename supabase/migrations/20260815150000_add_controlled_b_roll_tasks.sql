alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
check (task_type in ('draft_brief', 'draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll', 'generate_b_roll'));

create unique index tasks_one_b_roll_per_storyboard_shot_configuration_idx
on public.tasks (
  episode_id,
  (input_snapshot ->> 'storyboard_review_package_id'),
  (input_snapshot #>> '{shot,id}'),
  (input_snapshot ->> 'configuration_hash')
)
where task_type = 'generate_b_roll';

create or replace function public.freeze_worker_task_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_task public.tasks;
  selected_episode public.episodes;
begin
  select * into selected_task from public.tasks where id = new.task_id;
  if selected_task.task_type not in ('draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll', 'generate_b_roll') then
    return new;
  end if;
  select * into selected_episode from public.episodes where id = selected_task.episode_id;
  new.task_package := jsonb_strip_nulls(jsonb_build_object(
    'version', 'worker-task/v1',
    'task', jsonb_build_object('id', selected_task.id, 'type', selected_task.task_type, 'attempt', new.attempt),
    'episode', jsonb_build_object('id', selected_episode.id, 'account_id', selected_episode.account_id, 'blueprint_version_id', selected_episode.blueprint_version_id, 'title', selected_episode.title),
    'capability', selected_task.input_snapshot -> 'capability',
    'commission', selected_task.input_snapshot -> 'commission',
    'review_feedback', selected_task.input_snapshot -> 'review_feedback',
    'review_annotations', selected_task.input_snapshot -> 'review_annotations',
    'script_revision', selected_task.input_snapshot -> 'script_revision',
    'series_baseline', selected_task.input_snapshot -> 'series_baseline',
    'visual_review_package', selected_task.input_snapshot -> 'visual_review_package',
    'storyboard_review_package_id', selected_task.input_snapshot -> 'storyboard_review_package_id',
    'shot', selected_task.input_snapshot -> 'shot',
    'executor', selected_task.input_snapshot -> 'executor',
    'scheduling', selected_task.input_snapshot -> 'scheduling',
    'budget', (selected_task.input_snapshot -> 'budget') || jsonb_build_object('attempt', new.attempt),
    'allowed_tools', selected_task.input_snapshot -> 'allowed_tools',
    'output', selected_task.input_snapshot -> 'output',
    'input_artifacts', selected_task.input_snapshot -> 'input_artifacts',
    'forbidden_actions', jsonb_build_array('approve', 'publish', 'change_blueprint', 'change_episode_stage')
  ));
  return new;
end;
$$;

create function public.guard_b_roll_task_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  capability_limit integer;
  provider_limit integer;
begin
  if new.task_type <> 'generate_b_roll' or old.status <> 'ready' or new.status <> 'running' then return new; end if;
  capability_limit := (new.input_snapshot #>> '{scheduling,max_concurrency}')::integer;
  provider_limit := (new.input_snapshot #>> '{scheduling,provider_max_concurrency}')::integer;
  perform pg_advisory_xact_lock(hashtext('b-roll:' || new.provider));
  if (select count(*) from public.tasks task where task.task_type = 'generate_b_roll' and task.episode_id = new.episode_id and task.status = 'running') >= capability_limit then
    raise exception 'B-roll capability concurrency limit reached' using errcode = '55000';
  end if;
  if (select count(*) from public.tasks task where task.task_type = 'generate_b_roll' and task.provider = new.provider and task.status = 'running') >= provider_limit then
    raise exception 'B-roll provider concurrency limit reached' using errcode = '55000';
  end if;
  insert into public.asset_locks (resource_key, episode_id, expires_at)
  values (format('b-roll-task:%s', new.id), new.episode_id, now() + interval '30 minutes')
  on conflict (resource_key) do update set expires_at = excluded.expires_at;
  return new;
end;
$$;

create function public.release_b_roll_task_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.task_type = 'generate_b_roll' and old.status = 'running' and new.status <> 'running' then
    delete from public.asset_locks where resource_key = format('b-roll-task:%s', new.id);
  end if;
  return new;
end;
$$;

create trigger guard_b_roll_task_claim_before_running before update of status on public.tasks for each row execute function public.guard_b_roll_task_claim();
create trigger release_b_roll_task_lock_after_running after update of status on public.tasks for each row execute function public.release_b_roll_task_lock();

create function public.orchestrate_b_roll_tasks()
returns setof public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  storyboard_shot jsonb;
  selected_config jsonb;
  executor jsonb;
  allowed_tools jsonb;
  frozen_inputs jsonb;
  configuration_hash text;
  budget_limit integer;
  total_budget integer;
  max_attempts integer;
  max_concurrency integer;
  provider_max_concurrency integer;
  committed_budget integer;
  blocker_code text;
  blocker_detail text;
  configuration_blocker_code text;
  configuration_blocker_detail text;
  created_task public.tasks;
begin
  for candidate in
    select episode.*, blueprint.policy as blueprint_policy, series_version.rules as series_rules,
      review_package.id as storyboard_review_package_id, review_package.context_snapshot as storyboard_context
    from public.episodes episode
    join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join lateral (
      select package.* from public.review_packages package
      join public.approvals approval on approval.review_package_id = package.id and approval.stage = 'storyboard_approved' and approval.decision = 'approved'
      where package.episode_id = episode.id and package.stage = 'storyboard_review'
      order by package.revision_number desc limit 1
    ) review_package on true
    left join public.series_versions series_version on series_version.id = episode.series_version_id and series_version.account_id = episode.account_id
    where episode.stage = 'storyboard_approved'
    order by episode.updated_at, episode.id
    for update of episode skip locked
  loop
    selected_config := coalesce(candidate.series_rules -> 'b_roll', candidate.blueprint_policy -> 'b_roll');
    configuration_hash := md5(coalesce(selected_config::text, 'null'));
    blocker_code := null;
    blocker_detail := null;
    if jsonb_typeof(selected_config) <> 'object' then
      blocker_code := 'b_roll_executor_missing';
      blocker_detail := '蓝图或系列规则未声明 b_roll 执行器配置。';
    elsif jsonb_typeof(selected_config -> 'executor') <> 'object'
      or coalesce(btrim(selected_config #>> '{executor,provider}'), '') = ''
      or coalesce(btrim(selected_config #>> '{executor,model}'), '') = ''
      or coalesce(btrim(selected_config #>> '{executor,prompt_version}'), '') = ''
      or coalesce(btrim(selected_config #>> '{executor,adapter}'), '') = '' then
      blocker_code := 'b_roll_executor_invalid';
      blocker_detail := 'b_roll 执行器必须冻结 provider、model、prompt_version 与 adapter。';
    elsif jsonb_typeof(selected_config -> 'allowed_tools') <> 'array' or jsonb_array_length(selected_config -> 'allowed_tools') = 0 then
      blocker_code := 'b_roll_allowed_tools_invalid';
      blocker_detail := 'b_roll 配置必须声明非空的允许工具清单。';
    elsif jsonb_typeof(selected_config -> 'per_shot_budget_cents') <> 'number' or selected_config ->> 'per_shot_budget_cents' !~ '^[1-9][0-9]*$'
      or length(selected_config ->> 'per_shot_budget_cents') > 10 or (length(selected_config ->> 'per_shot_budget_cents') = 10 and selected_config ->> 'per_shot_budget_cents' > '2147483647') then
      blocker_code := 'b_roll_budget_unavailable';
      blocker_detail := 'b_roll 配置必须提供有效的单镜头预算。';
    elsif jsonb_typeof(selected_config -> 'total_budget_cents') <> 'number' or selected_config ->> 'total_budget_cents' !~ '^[1-9][0-9]*$'
      or length(selected_config ->> 'total_budget_cents') > 10 or (length(selected_config ->> 'total_budget_cents') = 10 and selected_config ->> 'total_budget_cents' > '2147483647') then
      blocker_code := 'b_roll_total_budget_unavailable';
      blocker_detail := 'b_roll 配置必须提供有效的总预算。';
    elsif jsonb_typeof(selected_config -> 'max_attempts') <> 'number' or selected_config ->> 'max_attempts' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_attempts') > 9
      or jsonb_typeof(selected_config -> 'max_concurrency') <> 'number' or selected_config ->> 'max_concurrency' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_concurrency') > 9
      or jsonb_typeof(selected_config -> 'provider_max_concurrency') <> 'number' or selected_config ->> 'provider_max_concurrency' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'provider_max_concurrency') > 9 then
      blocker_code := 'b_roll_scheduling_invalid';
      blocker_detail := 'b_roll 配置必须冻结重试、能力并发与供应商并发上限。';
    elsif selected_config ? 'fallback_executor' and selected_config -> 'fallback_executor' <> selected_config -> 'executor' then
      blocker_code := 'b_roll_fallback_not_equivalent';
      blocker_detail := '非等价备用执行器不能替换冻结的 B-roll 执行器。';
    else
      blocker_code := 'b_roll_executor_unavailable';
      blocker_detail := '尚未注册与分镜制作方式兼容的 B-roll 适配器；任务不会由 Worker 自行替换执行器。';
    end if;

    executor := selected_config -> 'executor';
    allowed_tools := selected_config -> 'allowed_tools';
    budget_limit := case when jsonb_typeof(selected_config -> 'per_shot_budget_cents') = 'number' and selected_config ->> 'per_shot_budget_cents' ~ '^[1-9][0-9]*$' and (length(selected_config ->> 'per_shot_budget_cents') < 10 or (length(selected_config ->> 'per_shot_budget_cents') = 10 and selected_config ->> 'per_shot_budget_cents' <= '2147483647')) then (selected_config ->> 'per_shot_budget_cents')::integer else 0 end;
    total_budget := case when jsonb_typeof(selected_config -> 'total_budget_cents') = 'number' and selected_config ->> 'total_budget_cents' ~ '^[1-9][0-9]*$' and (length(selected_config ->> 'total_budget_cents') < 10 or (length(selected_config ->> 'total_budget_cents') = 10 and selected_config ->> 'total_budget_cents' <= '2147483647')) then (selected_config ->> 'total_budget_cents')::integer else 0 end;
    max_attempts := case when jsonb_typeof(selected_config -> 'max_attempts') = 'number' and selected_config ->> 'max_attempts' ~ '^[1-9][0-9]*$' and length(selected_config ->> 'max_attempts') < 10 then (selected_config ->> 'max_attempts')::integer else 1 end;
    max_concurrency := case when jsonb_typeof(selected_config -> 'max_concurrency') = 'number' and selected_config ->> 'max_concurrency' ~ '^[1-9][0-9]*$' and length(selected_config ->> 'max_concurrency') < 10 then (selected_config ->> 'max_concurrency')::integer else 1 end;
    provider_max_concurrency := case when jsonb_typeof(selected_config -> 'provider_max_concurrency') = 'number' and selected_config ->> 'provider_max_concurrency' ~ '^[1-9][0-9]*$' and length(selected_config ->> 'provider_max_concurrency') < 10 then (selected_config ->> 'provider_max_concurrency')::integer else 1 end;
    configuration_blocker_code := blocker_code;
    configuration_blocker_detail := blocker_detail;

    for storyboard_shot in select value from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}') where value ->> 'shotType' = 'b_roll'
    loop
      if exists (select 1 from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_b_roll' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text and task.input_snapshot #>> '{shot,id}' = storyboard_shot ->> 'id' and task.input_snapshot ->> 'configuration_hash' = configuration_hash) then continue; end if;
      blocker_code := configuration_blocker_code;
      blocker_detail := configuration_blocker_detail;
      select coalesce(jsonb_agg(frozen_input), '[]'::jsonb) into frozen_inputs from jsonb_array_elements(candidate.storyboard_context -> 'input_artifacts') frozen_input join jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis on frozen_input ->> 'relativePath' = input_basis ->> 'relativePath' and frozen_input ->> 'sha256' = input_basis ->> 'sha256';
      if jsonb_array_length(frozen_inputs) <> jsonb_array_length(storyboard_shot -> 'inputBasis') then blocker_code := 'b_roll_input_basis_invalid'; blocker_detail := 'B-roll 镜头引用的冻结输入不完整。'; end if;
      select coalesce(sum(task.budget_limit_cents), 0) into committed_budget from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_b_roll' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text and task.status <> 'blocked';
      if blocker_code is null and committed_budget + budget_limit > total_budget then blocker_code := 'b_roll_budget_exhausted'; blocker_detail := '剩余 B-roll 总预算不足以创建该冻结镜头任务。'; end if;
      insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version, last_result, completed_at)
      values (candidate.id, 'generate_b_roll', 'blocked'::public.task_status,
        jsonb_strip_nulls(jsonb_build_object('capability', 'b_roll_generation', 'storyboard_review_package_id', candidate.storyboard_review_package_id, 'configuration_hash', configuration_hash, 'shot', storyboard_shot, 'executor', executor, 'scheduling', jsonb_build_object('max_concurrency', max_concurrency, 'provider_max_concurrency', provider_max_concurrency), 'budget', jsonb_build_object('limit_cents', budget_limit, 'total_limit_cents', total_budget, 'max_attempts', max_attempts), 'allowed_tools', allowed_tools, 'output', jsonb_build_object('required_artifact_types', jsonb_build_array('b_roll_asset'), 'relative_path', format('episodes/%s/b-roll/%s', candidate.id, storyboard_shot ->> 'id'), 'review_stage', 'production_ready'), 'input_artifacts', frozen_inputs)),
        budget_limit, max_attempts, coalesce(executor ->> 'provider', 'unconfigured'), coalesce(executor ->> 'model', 'unconfigured'), coalesce(executor ->> 'prompt_version', 'unconfigured'),
        jsonb_build_object('version','worker-result/v1','taskId','','status','blocked','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array()),'actualCostCents',0,'blockers',jsonb_build_array(jsonb_build_object('code',blocker_code,'detail',blocker_detail)),'retry',jsonb_build_object('shouldRetry',false,'reason',blocker_detail),'nextStep','注册兼容的 B-roll 适配器后，使用新的冻结配置创建任务。'), now()) returning * into created_task;
      update public.tasks set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text)) where id = created_task.id returning * into created_task;
      insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (candidate.account_id, candidate.id, 'b_roll_task_blocked', jsonb_build_object('task_id',created_task.id,'shot_id',storyboard_shot ->> 'id','code',blocker_code,'detail',blocker_detail), null);
      return next created_task;
    end loop;
  end loop;
end;
$$;

revoke execute on function public.orchestrate_b_roll_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_b_roll_tasks() to service_role;
