drop index public.tasks_one_a_roll_per_storyboard_shot_idx;
create unique index tasks_one_a_roll_per_storyboard_shot_configuration_idx
on public.tasks (
  episode_id,
  (input_snapshot ->> 'storyboard_review_package_id'),
  (input_snapshot #>> '{shot,id}'),
  (input_snapshot ->> 'configuration_hash')
)
where task_type = 'generate_a_roll';

update public.task_runs task_run
set status = 'failed',
    result = jsonb_build_object(
      'version', 'worker-result/v1',
      'taskId', task_run.task_id,
      'status', 'failed',
      'artifacts', jsonb_build_array(),
      'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array(jsonb_build_object('name', 'a_roll_adapter', 'passed', false, 'detail', 'A-roll 视频适配器未注册。'))),
      'actualCostCents', 0,
      'blockers', jsonb_build_array(),
      'retry', jsonb_build_object('shouldRetry', false, 'reason', 'A-roll 视频适配器未注册。'),
      'nextStep', '注册可验证视频输出的 A-roll 适配器后创建新的冻结任务。'
    ),
    completed_at = now()
where task_run.status = 'running'
  and exists (
    select 1 from public.tasks task
    where task.id = task_run.task_id
      and task.task_type = 'generate_a_roll'
  );

with blocked_task as (
  update public.tasks task
  set status = 'blocked',
      completed_at = now(),
      last_result = jsonb_build_object(
        'version', 'worker-result/v1',
        'taskId', task.id,
        'status', 'blocked',
        'artifacts', jsonb_build_array(),
        'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array()),
        'actualCostCents', coalesce(task.actual_cost_cents, 0),
        'blockers', jsonb_build_array(jsonb_build_object('code', 'a_roll_executor_unavailable', 'detail', '尚未注册可生成并验证视频输出的 A-roll 适配器。')),
        'retry', jsonb_build_object('shouldRetry', false, 'reason', 'A-roll 视频适配器未注册。'),
        'nextStep', '注册可验证视频输出的 A-roll 适配器后创建新的冻结任务。'
      )
  where task.task_type = 'generate_a_roll'
    and task.status in ('ready', 'running')
  returning task.id, task.episode_id
)
insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
select episode.account_id, blocked_task.episode_id, 'a_roll_task_blocked', jsonb_build_object(
  'task_id', blocked_task.id,
  'code', 'a_roll_executor_unavailable',
  'detail', '尚未注册可生成并验证视频输出的 A-roll 适配器。'
), null
from blocked_task
join public.episodes episode on episode.id = blocked_task.episode_id;

create or replace function public.orchestrate_a_roll_tasks()
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
  max_attempts integer;
  blocker_code text;
  blocker_detail text;
  configuration_blocker_code text;
  configuration_blocker_detail text;
  created_task public.tasks;
begin
  for candidate in
    select
      episode.*,
      blueprint.policy as blueprint_policy,
      series_version.rules as series_rules,
      review_package.id as storyboard_review_package_id,
      review_package.context_snapshot as storyboard_context
    from public.episodes episode
    join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join lateral (
      select package.*
      from public.review_packages package
      join public.approvals approval
        on approval.review_package_id = package.id
       and approval.stage = 'storyboard_approved'
       and approval.decision = 'approved'
      where package.episode_id = episode.id
        and package.stage = 'storyboard_review'
      order by package.revision_number desc
      limit 1
    ) review_package on true
    left join public.series_versions series_version
      on series_version.id = episode.series_version_id
     and series_version.account_id = episode.account_id
    where episode.stage = 'storyboard_approved'
    order by episode.updated_at, episode.id
    for update of episode skip locked
  loop
    selected_config := coalesce(candidate.series_rules -> 'a_roll', candidate.blueprint_policy -> 'a_roll');
    configuration_hash := md5(coalesce(selected_config::text, 'null'));
    blocker_code := null;
    blocker_detail := null;
    if jsonb_typeof(selected_config) <> 'object' then
      blocker_code := 'a_roll_executor_missing';
      blocker_detail := '蓝图或系列规则未声明 a_roll 执行器配置。';
    elsif jsonb_typeof(selected_config -> 'executor') <> 'object'
      or coalesce(btrim(selected_config #>> '{executor,provider}'), '') = ''
      or coalesce(btrim(selected_config #>> '{executor,model}'), '') = ''
      or coalesce(btrim(selected_config #>> '{executor,prompt_version}'), '') = ''
      or coalesce(btrim(selected_config #>> '{executor,adapter}'), '') = '' then
      blocker_code := 'a_roll_executor_invalid';
      blocker_detail := 'a_roll 执行器必须冻结 provider、model、prompt_version 与 adapter。';
    elsif jsonb_typeof(selected_config -> 'allowed_tools') <> 'array'
      or jsonb_array_length(selected_config -> 'allowed_tools') = 0
      or exists (
        select 1 from jsonb_array_elements(selected_config -> 'allowed_tools') tool
        where jsonb_typeof(tool) <> 'string' or coalesce(btrim(tool #>> '{}'), '') = ''
      ) then
      blocker_code := 'a_roll_allowed_tools_invalid';
      blocker_detail := 'a_roll 配置必须声明非空的允许工具或适配器清单。';
    elsif jsonb_typeof(selected_config -> 'budget_cents') <> 'number'
      or selected_config ->> 'budget_cents' !~ '^[1-9][0-9]*$' then
      blocker_code := 'a_roll_budget_unavailable';
      blocker_detail := 'a_roll 配置必须提供正整数预算。';
    elsif jsonb_typeof(selected_config -> 'max_attempts') <> 'number'
      or selected_config ->> 'max_attempts' !~ '^[1-9][0-9]*$' then
      blocker_code := 'a_roll_retry_policy_invalid';
      blocker_detail := 'a_roll 配置必须提供正整数最大尝试次数。';
    elsif selected_config ? 'fallback_executor'
      and selected_config -> 'fallback_executor' <> selected_config -> 'executor' then
      blocker_code := 'a_roll_fallback_not_equivalent';
      blocker_detail := '非等价备用执行器不能替换冻结的 A-roll 执行器。';
    else
      blocker_code := 'a_roll_executor_unavailable';
      blocker_detail := '尚未注册可生成并验证视频输出的 A-roll 适配器；任务不会由通用 Codex Worker 代替执行。';
    end if;

    configuration_blocker_code := blocker_code;
    configuration_blocker_detail := blocker_detail;
    executor := selected_config -> 'executor';
    allowed_tools := selected_config -> 'allowed_tools';
    budget_limit := case when jsonb_typeof(selected_config -> 'budget_cents') = 'number' and selected_config ->> 'budget_cents' ~ '^[1-9][0-9]*$' then (selected_config ->> 'budget_cents')::integer else 0 end;
    max_attempts := case when jsonb_typeof(selected_config -> 'max_attempts') = 'number' and selected_config ->> 'max_attempts' ~ '^[1-9][0-9]*$' then (selected_config ->> 'max_attempts')::integer else 1 end;

    for storyboard_shot in
      select value
      from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}')
      where value ->> 'shotType' = 'a_roll'
    loop
      if exists (
        select 1 from public.tasks task
        where task.episode_id = candidate.id
          and task.task_type = 'generate_a_roll'
          and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text
          and task.input_snapshot #>> '{shot,id}' = storyboard_shot ->> 'id'
          and task.input_snapshot ->> 'configuration_hash' = configuration_hash
      ) then
        continue;
      end if;

      blocker_code := configuration_blocker_code;
      blocker_detail := configuration_blocker_detail;
      select coalesce(jsonb_agg(frozen_input), '[]'::jsonb) into frozen_inputs
      from jsonb_array_elements(candidate.storyboard_context -> 'input_artifacts') frozen_input
      join jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis
        on frozen_input ->> 'relativePath' = input_basis ->> 'relativePath'
       and frozen_input ->> 'sha256' = input_basis ->> 'sha256';
      if jsonb_array_length(frozen_inputs) <> jsonb_array_length(storyboard_shot -> 'inputBasis') then
        blocker_code := 'a_roll_input_basis_invalid';
        blocker_detail := 'A-roll 镜头引用的冻结输入不完整。';
      end if;

      insert into public.tasks (
        episode_id, task_type, status, input_snapshot, budget_limit_cents,
        max_attempts, provider, model, prompt_version, last_result, completed_at
      ) values (
        candidate.id,
        'generate_a_roll',
        'blocked'::public.task_status,
        jsonb_strip_nulls(jsonb_build_object(
          'capability', 'a_roll_generation',
          'storyboard_review_package_id', candidate.storyboard_review_package_id,
          'configuration_hash', configuration_hash,
          'shot', storyboard_shot,
          'executor', executor,
          'budget', jsonb_build_object('limit_cents', budget_limit, 'max_attempts', max_attempts),
          'allowed_tools', allowed_tools,
          'output', jsonb_build_object(
            'required_artifact_types', jsonb_build_array('a_roll_video'),
            'content_type', 'video/mp4',
            'relative_path', format('episodes/%s/a-roll/%s.mp4', candidate.id, storyboard_shot ->> 'id'),
            'review_stage', 'production_ready'
          ),
          'input_artifacts', frozen_inputs
        )),
        budget_limit,
        max_attempts,
        coalesce(executor ->> 'provider', 'unconfigured'),
        coalesce(executor ->> 'model', 'unconfigured'),
        coalesce(executor ->> 'prompt_version', 'unconfigured'),
        jsonb_build_object(
          'version', 'worker-result/v1',
          'taskId', '',
          'status', 'blocked',
          'artifacts', jsonb_build_array(),
          'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array()),
          'actualCostCents', 0,
          'blockers', jsonb_build_array(jsonb_build_object('code', blocker_code, 'detail', blocker_detail)),
          'retry', jsonb_build_object('shouldRetry', false, 'reason', blocker_detail),
          'nextStep', '注册可验证视频输出的 A-roll 适配器后，使用新的冻结配置创建任务。'
        ),
        now()
      ) returning * into created_task;

      update public.tasks
      set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text))
      where id = created_task.id
      returning * into created_task;
      insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
      values (
        candidate.account_id,
        candidate.id,
        'a_roll_task_blocked',
        jsonb_build_object('task_id', created_task.id, 'shot_id', storyboard_shot ->> 'id', 'code', blocker_code, 'detail', blocker_detail),
        null
      );
      return next created_task;
    end loop;
  end loop;
end;
$$;

alter function public.report_worker_result(uuid, integer, jsonb) rename to report_worker_result_base;
revoke all on function public.report_worker_result_base(uuid, integer, jsonb) from public, anon, authenticated, service_role;

create function public.report_worker_result(p_task_id uuid, p_attempt integer, p_result jsonb)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_task public.tasks;
  reported_task public.tasks;
  actual_cost integer;
  normalized_result jsonb;
begin
  select * into selected_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = 'P0002';
  end if;
  if selected_task.task_type <> 'generate_a_roll'
    or jsonb_typeof(p_result) <> 'object'
    or jsonb_typeof(p_result -> 'actualCostCents') <> 'number'
    or p_result ->> 'actualCostCents' !~ '^[0-9]+$'
    or (p_result ->> 'actualCostCents')::integer <= selected_task.budget_limit_cents then
    return public.report_worker_result_base(p_task_id, p_attempt, p_result);
  end if;

  actual_cost := (p_result ->> 'actualCostCents')::integer;
  normalized_result := jsonb_set(p_result, '{actualCostCents}', to_jsonb(selected_task.budget_limit_cents)) || jsonb_build_object(
    'status', 'blocked',
    'blockers', jsonb_build_array(jsonb_build_object('code', 'a_roll_budget_exceeded', 'detail', format('实际成本 %s 分超过冻结预算 %s 分。', actual_cost, selected_task.budget_limit_cents))),
    'retry', jsonb_build_object('shouldRetry', false, 'reason', '实际成本超过冻结预算。'),
    'nextStep', '由 Owner 调整预算或创建新的冻结任务。'
  );
  reported_task := public.report_worker_result_base(p_task_id, p_attempt, normalized_result);
  update public.task_runs
  set actual_cost_cents = actual_cost,
      result = jsonb_set(result, '{actualCostCents}', to_jsonb(actual_cost))
  where task_id = p_task_id and attempt = p_attempt;
  update public.tasks
  set actual_cost_cents = actual_cost,
      last_result = jsonb_set(last_result, '{actualCostCents}', to_jsonb(actual_cost))
  where id = p_task_id
  returning * into reported_task;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  select episode.account_id, episode.id, 'a_roll_task_blocked', jsonb_build_object(
    'task_id', p_task_id,
    'shot_id', selected_task.input_snapshot #>> '{shot,id}',
    'code', 'a_roll_budget_exceeded',
    'detail', format('实际成本 %s 分超过冻结预算 %s 分。', actual_cost, selected_task.budget_limit_cents)
  ), null
  from public.episodes episode where episode.id = selected_task.episode_id;
  return reported_task;
end;
$$;

revoke all on function public.report_worker_result(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.report_worker_result(uuid, integer, jsonb) to service_role;
