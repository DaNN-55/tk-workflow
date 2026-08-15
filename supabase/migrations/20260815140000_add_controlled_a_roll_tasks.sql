alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
check (task_type in ('draft_brief', 'draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll'));

create unique index tasks_one_a_roll_per_storyboard_shot_idx
on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot #>> '{shot,id}'))
where task_type = 'generate_a_roll';

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
  if selected_task.task_type not in ('draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll') then
    return new;
  end if;
  select * into selected_episode from public.episodes where id = selected_task.episode_id;
  new.task_package := jsonb_strip_nulls(jsonb_build_object(
    'version', 'worker-task/v1',
    'task', jsonb_build_object('id', selected_task.id, 'type', selected_task.task_type, 'attempt', new.attempt),
    'episode', jsonb_build_object(
      'id', selected_episode.id,
      'account_id', selected_episode.account_id,
      'blueprint_version_id', selected_episode.blueprint_version_id,
      'title', selected_episode.title
    ),
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
    'budget', (selected_task.input_snapshot -> 'budget') || jsonb_build_object('attempt', new.attempt),
    'allowed_tools', selected_task.input_snapshot -> 'allowed_tools',
    'output', selected_task.input_snapshot -> 'output',
    'input_artifacts', selected_task.input_snapshot -> 'input_artifacts',
    'forbidden_actions', jsonb_build_array('approve', 'publish', 'change_blueprint', 'change_episode_stage')
  ));
  return new;
end;
$$;

create function public.orchestrate_a_roll_tasks()
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
  budget_limit integer;
  max_attempts integer;
  blocker_code text;
  blocker_detail text;
  configuration_blocker_code text;
  configuration_blocker_detail text;
  created_task public.tasks;
  created_ready boolean;
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
    elsif selected_config #>> '{executor,provider}' <> 'codex'
      or selected_config #>> '{executor,adapter}' <> 'codex' then
      blocker_code := 'a_roll_executor_unavailable';
      blocker_detail := '当前 Worker 仅注册 codex A-roll 适配器；不会替换为其他执行器。';
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
    end if;

    configuration_blocker_code := blocker_code;
    configuration_blocker_detail := blocker_detail;

    executor := selected_config -> 'executor';
    allowed_tools := selected_config -> 'allowed_tools';
    budget_limit := case when blocker_code is null then (selected_config ->> 'budget_cents')::integer else 0 end;
    max_attempts := case when blocker_code is null then (selected_config ->> 'max_attempts')::integer else 1 end;
    created_ready := false;

    for storyboard_shot in
      select value
      from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}')
      where value ->> 'shotType' = 'a_roll'
    loop
      blocker_code := configuration_blocker_code;
      blocker_detail := configuration_blocker_detail;
      if exists (
        select 1 from public.tasks task
        where task.episode_id = candidate.id
          and task.task_type = 'generate_a_roll'
          and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text
          and task.input_snapshot #>> '{shot,id}' = storyboard_shot ->> 'id'
      ) then
        continue;
      end if;

      select coalesce(jsonb_agg(frozen_input), '[]'::jsonb) into frozen_inputs
      from jsonb_array_elements(candidate.storyboard_context -> 'input_artifacts') frozen_input
      join jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis
        on frozen_input ->> 'relativePath' = input_basis ->> 'relativePath'
       and frozen_input ->> 'sha256' = input_basis ->> 'sha256';
      if blocker_code is null and jsonb_array_length(frozen_inputs) <> jsonb_array_length(storyboard_shot -> 'inputBasis') then
        blocker_code := 'a_roll_input_basis_invalid';
        blocker_detail := 'A-roll 镜头引用的冻结输入不完整。';
      end if;

      insert into public.tasks (
        episode_id, task_type, status, input_snapshot, budget_limit_cents,
        max_attempts, provider, model, prompt_version, last_result, completed_at
      ) values (
        candidate.id,
        'generate_a_roll',
        case when blocker_code is null then 'ready'::public.task_status else 'blocked'::public.task_status end,
        jsonb_strip_nulls(jsonb_build_object(
          'capability', 'a_roll_generation',
          'storyboard_review_package_id', candidate.storyboard_review_package_id,
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
        case when blocker_code is null then null else jsonb_build_object(
          'version', 'worker-result/v1',
          'taskId', '',
          'status', 'blocked',
          'artifacts', jsonb_build_array(),
          'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array()),
          'actualCostCents', 0,
          'blockers', jsonb_build_array(jsonb_build_object('code', blocker_code, 'detail', blocker_detail)),
          'retry', jsonb_build_object('shouldRetry', false, 'reason', blocker_detail),
          'nextStep', '修复 A-roll 配置后创建新的冻结任务。'
        ) end,
        case when blocker_code is null then null else now() end
      ) returning * into created_task;

      if blocker_code is not null then
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
      else
        insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
        values (
          candidate.account_id,
          candidate.id,
          'a_roll_task_created',
          jsonb_build_object('task_id', created_task.id, 'shot_id', storyboard_shot ->> 'id', 'storyboard_review_package_id', candidate.storyboard_review_package_id),
          null
        );
      end if;
      created_ready := created_ready or blocker_code is null;
      return next created_task;
    end loop;

    if created_ready then
      update public.episodes set stage = 'production_ready', updated_at = now() where id = candidate.id;
      insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
      values (candidate.id, 'storyboard_approved', 'production_ready', 'Orchestrator created frozen A-roll tasks from the approved storyboard.', null);
      insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
      values (candidate.account_id, candidate.id, 'stage_transition', jsonb_build_object('to_stage', 'production_ready', 'reason', 'Orchestrator created frozen A-roll tasks from the approved storyboard.'), null);
    end if;
  end loop;
end;
$$;

create function public.block_exhausted_a_roll_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  blocker_detail text;
begin
  if new.task_type <> 'generate_a_roll'
    or new.status <> 'failed'
    or new.attempt < new.max_attempts then
    return new;
  end if;

  blocker_detail := coalesce(nullif(btrim(new.last_result #>> '{retry,reason}'), ''), 'A-roll Worker 在所有冻结尝试中均失败。');
  update public.tasks
  set status = 'blocked',
      last_result = coalesce(new.last_result, '{}'::jsonb) || jsonb_build_object(
        'status', 'blocked',
        'blockers', jsonb_build_array(jsonb_build_object('code', 'a_roll_retries_exhausted', 'detail', blocker_detail)),
        'retry', jsonb_build_object('shouldRetry', false, 'reason', blocker_detail),
        'nextStep', '由 Owner 检查冻结执行器或配置后创建新的任务。'
      )
  where id = new.id;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  select episode.account_id, episode.id, 'a_roll_task_blocked', jsonb_build_object('task_id', new.id, 'shot_id', new.input_snapshot #>> '{shot,id}', 'code', 'a_roll_retries_exhausted', 'detail', blocker_detail), null
  from public.episodes episode where episode.id = new.episode_id;
  return new;
end;
$$;

create trigger block_exhausted_a_roll_task_after_failure
after update of status on public.tasks
for each row execute function public.block_exhausted_a_roll_task();

revoke execute on function public.freeze_worker_task_run() from public, anon, authenticated;
revoke execute on function public.orchestrate_a_roll_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_a_roll_tasks() to service_role;
revoke execute on function public.block_exhausted_a_roll_task() from public, anon, authenticated;
