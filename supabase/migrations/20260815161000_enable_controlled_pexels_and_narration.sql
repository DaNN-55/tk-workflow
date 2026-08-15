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
  if selected_task.task_type not in ('draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll', 'generate_b_roll', 'generate_narration', 'extract_embedded_audio', 'generate_soundtrack') then return new; end if;
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
    'media', selected_task.input_snapshot -> 'media',
    'audio_track', selected_task.input_snapshot -> 'audio_track',
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

create or replace function public.claim_next_worker_task()
returns table (task_id uuid, task_type text, attempt integer, budget_limit_cents integer, max_attempts integer, provider text, model text, prompt_version text, episode_id uuid, account_id uuid, blueprint_version_id uuid, title text, allowed_asset_root text, input_snapshot jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  reclaimed_task public.tasks; selected_task public.tasks;
begin
  for reclaimed_task in select * from public.tasks where status = 'running' and claimed_at < now() - interval '30 minutes' for update skip locked
  loop
    update public.task_runs task_run set status = 'failed', result = jsonb_build_object('version','worker-result/v1','taskId',reclaimed_task.id,'status','failed','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array(jsonb_build_object('name','worker_lease','passed',false,'detail','Worker lease expired before it reported a result.'))),'actualCostCents',0,'blockers',jsonb_build_array(),'retry',jsonb_build_object('shouldRetry',reclaimed_task.attempt < reclaimed_task.max_attempts,'reason','Worker lease expired.'),'nextStep','Retry the task only after the worker is available.'), completed_at = now() where task_run.task_id = reclaimed_task.id and task_run.status = 'running';
    update public.tasks task set status = case when reclaimed_task.attempt < reclaimed_task.max_attempts then 'ready'::public.task_status else 'failed'::public.task_status end, claimed_at = null, completed_at = case when reclaimed_task.attempt < reclaimed_task.max_attempts then null else now() end, last_result = jsonb_build_object('version','worker-result/v1','taskId',reclaimed_task.id,'status','failed','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array(jsonb_build_object('name','worker_lease','passed',false,'detail','Worker lease expired before it reported a result.'))),'actualCostCents',0,'blockers',jsonb_build_array(),'retry',jsonb_build_object('shouldRetry',reclaimed_task.attempt < reclaimed_task.max_attempts,'reason','Worker lease expired.'),'nextStep','Retry the task only after the worker is available.') where task.id = reclaimed_task.id;
    insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id) select episode.account_id,episode.id,'worker_lease_expired',jsonb_build_object('task_id',reclaimed_task.id,'attempt',reclaimed_task.attempt - 1),null from public.episodes episode where episode.id = reclaimed_task.episode_id;
  end loop;
  select * into selected_task from public.tasks task
  where task.status = 'ready' and task.provider in ('codex', 'google_tts', 'pexels') and task.attempt < task.max_attempts
  order by task.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.tasks task set status = 'running', claimed_at = now(), attempt = task.attempt + 1 where task.id = selected_task.id;
  insert into public.task_runs (task_id, attempt, task_package)
  select selected_task.id, selected_task.attempt, jsonb_build_object(
    'version', 'worker-task/v1', 'task_id', selected_task.id, 'task_type', selected_task.task_type, 'attempt', selected_task.attempt,
    'budget_limit_cents', selected_task.budget_limit_cents, 'max_attempts', selected_task.max_attempts, 'provider', selected_task.provider,
    'model', selected_task.model, 'prompt_version', selected_task.prompt_version, 'episode_id', episode.id, 'account_id', account.id,
    'blueprint_version_id', episode.blueprint_version_id, 'allowed_asset_root', coalesce(blueprint.policy ->> 'asset_root', ''), 'input_snapshot', selected_task.input_snapshot)
  from public.episodes episode join public.accounts account on account.id = episode.account_id join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id where episode.id = selected_task.episode_id;
  return query
  select selected_task.id, selected_task.task_type, selected_task.attempt, selected_task.budget_limit_cents, selected_task.max_attempts, selected_task.provider, selected_task.model, selected_task.prompt_version, episode.id, account.id, episode.blueprint_version_id, episode.title, coalesce(blueprint.policy ->> 'asset_root', ''), selected_task.input_snapshot
  from public.episodes episode join public.accounts account on account.id = episode.account_id join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id where episode.id = selected_task.episode_id;
end;
$$;

create or replace function public.orchestrate_b_roll_tasks()
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare
  candidate record; storyboard_shot jsonb; selected_config jsonb; executor jsonb; allowed_tools jsonb; frozen_inputs jsonb;
  configuration_hash text; budget_limit integer; total_budget integer; max_attempts integer; max_concurrency integer; provider_max_concurrency integer; committed_budget integer;
  blocker_code text; blocker_detail text; created_task public.tasks; frozen_query text;
begin
  for candidate in
    select episode.*, blueprint.policy as blueprint_policy, series_version.rules as series_rules, review_package.id as storyboard_review_package_id, review_package.context_snapshot as storyboard_context
    from public.episodes episode join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join lateral (select package.* from public.review_packages package join public.approvals approval on approval.review_package_id = package.id and approval.stage = 'storyboard_approved' and approval.decision = 'approved' where package.episode_id = episode.id and package.stage = 'storyboard_review' order by package.revision_number desc limit 1) review_package on true
    left join public.series_versions series_version on series_version.id = episode.series_version_id and series_version.account_id = episode.account_id
    where episode.stage = 'storyboard_approved' order by episode.updated_at, episode.id for update of episode skip locked
  loop
    selected_config := coalesce(candidate.series_rules -> 'b_roll', candidate.blueprint_policy -> 'b_roll');
    configuration_hash := md5(coalesce(selected_config::text, 'null'));
    blocker_code := null; blocker_detail := null;
    if jsonb_typeof(selected_config) <> 'object' then blocker_code := 'b_roll_executor_missing'; blocker_detail := '蓝图或系列规则未声明 b_roll 执行器配置。';
    elsif jsonb_typeof(selected_config -> 'executor') <> 'object' or coalesce(btrim(selected_config #>> '{executor,provider}'), '') = '' or coalesce(btrim(selected_config #>> '{executor,model}'), '') = '' or coalesce(btrim(selected_config #>> '{executor,prompt_version}'), '') = '' or coalesce(btrim(selected_config #>> '{executor,adapter}'), '') = '' then blocker_code := 'b_roll_executor_invalid'; blocker_detail := 'b_roll 执行器必须冻结 provider、model、prompt_version 与 adapter。';
    elsif selected_config #>> '{executor,provider}' <> 'pexels' or selected_config #>> '{executor,adapter}' <> 'pexels_video' or selected_config #>> '{executor,model}' <> 'pexels-video-v1' then blocker_code := 'b_roll_executor_unavailable'; blocker_detail := '当前仅注册 Pexels 视频适配器；配置必须精确声明 pexels/pexels_video/pexels-video-v1。';
    elsif jsonb_typeof(selected_config -> 'allowed_tools') <> 'array' or jsonb_array_length(selected_config -> 'allowed_tools') = 0 then blocker_code := 'b_roll_allowed_tools_invalid'; blocker_detail := 'b_roll 配置必须声明非空的允许工具清单。';
    elsif jsonb_typeof(selected_config -> 'per_shot_budget_cents') <> 'number' or selected_config ->> 'per_shot_budget_cents' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'per_shot_budget_cents') > 10 or (length(selected_config ->> 'per_shot_budget_cents') = 10 and selected_config ->> 'per_shot_budget_cents' > '2147483647') then blocker_code := 'b_roll_budget_unavailable'; blocker_detail := 'b_roll 配置必须提供有效的单镜头预算。';
    elsif jsonb_typeof(selected_config -> 'total_budget_cents') <> 'number' or selected_config ->> 'total_budget_cents' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'total_budget_cents') > 10 or (length(selected_config ->> 'total_budget_cents') = 10 and selected_config ->> 'total_budget_cents' > '2147483647') then blocker_code := 'b_roll_total_budget_unavailable'; blocker_detail := 'b_roll 配置必须提供有效的总预算。';
    elsif jsonb_typeof(selected_config -> 'max_attempts') <> 'number' or selected_config ->> 'max_attempts' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_attempts') > 9 or jsonb_typeof(selected_config -> 'max_concurrency') <> 'number' or selected_config ->> 'max_concurrency' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_concurrency') > 9 or jsonb_typeof(selected_config -> 'provider_max_concurrency') <> 'number' or selected_config ->> 'provider_max_concurrency' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'provider_max_concurrency') > 9 then blocker_code := 'b_roll_scheduling_invalid'; blocker_detail := 'b_roll 配置必须冻结重试、能力并发与供应商并发上限。';
    elsif selected_config ? 'fallback_executor' and selected_config -> 'fallback_executor' <> selected_config -> 'executor' then blocker_code := 'b_roll_fallback_not_equivalent'; blocker_detail := '非等价备用执行器不能替换冻结的 B-roll 执行器。'; end if;
    executor := selected_config -> 'executor'; allowed_tools := selected_config -> 'allowed_tools';
    budget_limit := case when jsonb_typeof(selected_config -> 'per_shot_budget_cents') = 'number' and selected_config ->> 'per_shot_budget_cents' ~ '^[1-9][0-9]*$' and (length(selected_config ->> 'per_shot_budget_cents') < 10 or (length(selected_config ->> 'per_shot_budget_cents') = 10 and selected_config ->> 'per_shot_budget_cents' <= '2147483647')) then (selected_config ->> 'per_shot_budget_cents')::integer else 0 end;
    total_budget := case when jsonb_typeof(selected_config -> 'total_budget_cents') = 'number' and selected_config ->> 'total_budget_cents' ~ '^[1-9][0-9]*$' and (length(selected_config ->> 'total_budget_cents') < 10 or (length(selected_config ->> 'total_budget_cents') = 10 and selected_config ->> 'total_budget_cents' <= '2147483647')) then (selected_config ->> 'total_budget_cents')::integer else 0 end;
    max_attempts := case when jsonb_typeof(selected_config -> 'max_attempts') = 'number' and selected_config ->> 'max_attempts' ~ '^[1-9][0-9]*$' and length(selected_config ->> 'max_attempts') < 10 then (selected_config ->> 'max_attempts')::integer else 1 end;
    max_concurrency := case when jsonb_typeof(selected_config -> 'max_concurrency') = 'number' and selected_config ->> 'max_concurrency' ~ '^[1-9][0-9]*$' and length(selected_config ->> 'max_concurrency') < 10 then (selected_config ->> 'max_concurrency')::integer else 1 end;
    provider_max_concurrency := case when jsonb_typeof(selected_config -> 'provider_max_concurrency') = 'number' and selected_config ->> 'provider_max_concurrency' ~ '^[1-9][0-9]*$' and length(selected_config ->> 'provider_max_concurrency') < 10 then (selected_config ->> 'provider_max_concurrency')::integer else 1 end;
    for storyboard_shot in select value from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}') where value ->> 'shotType' = 'b_roll'
    loop
      if exists (select 1 from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_b_roll' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text and task.input_snapshot #>> '{shot,id}' = storyboard_shot ->> 'id' and task.input_snapshot ->> 'configuration_hash' = configuration_hash) then continue; end if;
      select coalesce(jsonb_agg(frozen_input), '[]'::jsonb) into frozen_inputs from jsonb_array_elements(candidate.storyboard_context -> 'input_artifacts') frozen_input join jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis on frozen_input ->> 'relativePath' = input_basis ->> 'relativePath' and frozen_input ->> 'sha256' = input_basis ->> 'sha256';
      if jsonb_array_length(frozen_inputs) <> jsonb_array_length(storyboard_shot -> 'inputBasis') then blocker_code := 'b_roll_input_basis_invalid'; blocker_detail := 'B-roll 镜头引用的冻结输入不完整。'; end if;
      select coalesce(sum(task.budget_limit_cents), 0) into committed_budget from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_b_roll' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text and task.status <> 'blocked';
      if blocker_code is null and committed_budget + budget_limit > total_budget then blocker_code := 'b_roll_budget_exhausted'; blocker_detail := '剩余 B-roll 总预算不足以创建该冻结镜头任务。'; end if;
      frozen_query := left(btrim(concat_ws(' ', storyboard_shot ->> 'productionMethod', storyboard_shot ->> 'scriptSegment')), 400);
      if frozen_query = '' then blocker_code := 'b_roll_query_invalid'; blocker_detail := 'B-roll 镜头缺少可冻结的检索词。'; end if;
      insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version, last_result, completed_at)
      values (candidate.id, 'generate_b_roll', case when blocker_code is null then 'ready'::public.task_status else 'blocked'::public.task_status end,
        jsonb_strip_nulls(jsonb_build_object('capability', 'b_roll_generation', 'storyboard_review_package_id', candidate.storyboard_review_package_id, 'configuration_hash', configuration_hash, 'shot', storyboard_shot, 'executor', executor, 'media', jsonb_build_object('adapter','pexels_video','b_roll',jsonb_build_object('query', frozen_query, 'target_duration_seconds', (storyboard_shot ->> 'durationSeconds')::numeric, 'shot', storyboard_shot)), 'scheduling', jsonb_build_object('max_concurrency', max_concurrency, 'provider_max_concurrency', provider_max_concurrency), 'budget', jsonb_build_object('limit_cents', budget_limit, 'total_limit_cents', total_budget, 'max_attempts', max_attempts), 'allowed_tools', allowed_tools, 'output', jsonb_build_object('required_artifact_types', jsonb_build_array('b_roll_asset'), 'content_type', 'video/mp4', 'relative_path', format('episodes/%s/b-roll/%s.mp4', candidate.id, storyboard_shot ->> 'id'), 'review_stage', 'production_ready'), 'input_artifacts', frozen_inputs)), budget_limit, max_attempts, coalesce(executor ->> 'provider', 'unconfigured'), coalesce(executor ->> 'model', 'unconfigured'), coalesce(executor ->> 'prompt_version', 'unconfigured'),
        case when blocker_code is null then null else jsonb_build_object('version','worker-result/v1','taskId','','status','blocked','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array()),'actualCostCents',0,'blockers',jsonb_build_array(jsonb_build_object('code',blocker_code,'detail',blocker_detail)),'retry',jsonb_build_object('shouldRetry',false,'reason',blocker_detail),'nextStep','修正冻结的 B-roll 配置后，使用新的配置创建任务。') end,
        case when blocker_code is null then null else now() end) returning * into created_task;
      if blocker_code is not null then update public.tasks set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text)) where id = created_task.id returning * into created_task; insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (candidate.account_id, candidate.id, 'b_roll_task_blocked', jsonb_build_object('task_id',created_task.id,'shot_id',storyboard_shot ->> 'id','code',blocker_code,'detail',blocker_detail), null); end if;
      return next created_task;
    end loop;
  end loop;
end;
$$;

create unique index tasks_one_narration_per_storyboard_configuration_idx on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot ->> 'configuration_hash')) where task_type = 'generate_narration';

create function public.orchestrate_narration_tasks()
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare
  candidate record; selected_config jsonb; executor jsonb; configuration_hash text; narration_text text; narration_duration numeric; budget_limit integer; max_attempts integer; blocker_code text; blocker_detail text; created_task public.tasks;
begin
  for candidate in
    select episode.*, blueprint.policy as blueprint_policy, series_version.rules as series_rules, review_package.id as storyboard_review_package_id, review_package.context_snapshot as storyboard_context
    from public.episodes episode join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join lateral (select package.* from public.review_packages package join public.approvals approval on approval.review_package_id = package.id and approval.stage = 'storyboard_approved' and approval.decision = 'approved' where package.episode_id = episode.id and package.stage = 'storyboard_review' order by package.revision_number desc limit 1) review_package on true
    left join public.series_versions series_version on series_version.id = episode.series_version_id and series_version.account_id = episode.account_id
    where episode.stage = 'storyboard_approved' order by episode.updated_at, episode.id for update of episode skip locked
  loop
    selected_config := coalesce(candidate.series_rules -> 'narration', candidate.blueprint_policy -> 'narration'); configuration_hash := md5(coalesce(selected_config::text, 'null'));
    if exists (select 1 from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_narration' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text and task.input_snapshot ->> 'configuration_hash' = configuration_hash) then continue; end if;
    select string_agg(btrim(value ->> 'scriptSegment'), ' ' order by ordinality), sum((value ->> 'durationSeconds')::numeric) into narration_text, narration_duration from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}') with ordinality;
    executor := selected_config -> 'executor'; blocker_code := null; blocker_detail := null;
    if jsonb_typeof(selected_config) <> 'object' then blocker_code := 'narration_executor_missing'; blocker_detail := '蓝图或系列规则未声明 narration 执行器配置。';
    elsif jsonb_typeof(executor) <> 'object' or executor ->> 'provider' <> 'google_tts' or executor ->> 'adapter' <> 'google_tts' or coalesce(btrim(executor ->> 'model'), '') = '' or coalesce(btrim(executor ->> 'prompt_version'), '') = '' then blocker_code := 'narration_executor_invalid'; blocker_detail := '旁白配置必须精确声明 google_tts 适配器、模型与提示版本。';
    elsif jsonb_typeof(selected_config -> 'allowed_tools') <> 'array' or jsonb_array_length(selected_config -> 'allowed_tools') = 0 then blocker_code := 'narration_allowed_tools_invalid'; blocker_detail := '旁白配置必须声明非空的允许工具清单。';
    elsif jsonb_typeof(selected_config -> 'budget_cents') <> 'number' or selected_config ->> 'budget_cents' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'budget_cents') > 10 or (length(selected_config ->> 'budget_cents') = 10 and selected_config ->> 'budget_cents' > '2147483647') then blocker_code := 'narration_budget_invalid'; blocker_detail := '旁白配置必须提供有效预算。';
    elsif jsonb_typeof(selected_config -> 'max_attempts') <> 'number' or selected_config ->> 'max_attempts' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_attempts') > 9 then blocker_code := 'narration_scheduling_invalid'; blocker_detail := '旁白配置必须提供有效最大尝试次数。';
    elsif jsonb_typeof(selected_config -> 'voice') <> 'object' or coalesce(btrim(selected_config #>> '{voice,language_code}'), '') = '' or coalesce(btrim(selected_config #>> '{voice,name}'), '') = '' or jsonb_typeof(selected_config #> '{voice,speaking_rate}') <> 'number' or (selected_config #>> '{voice,speaking_rate}')::numeric <= 0 then blocker_code := 'narration_voice_invalid'; blocker_detail := '旁白配置必须冻结有效语言、声音与语速。';
    elsif coalesce(btrim(narration_text), '') = '' or narration_duration is null or narration_duration <= 0 then blocker_code := 'narration_storyboard_invalid'; blocker_detail := '已批准分镜缺少可生成的旁白文本或时长。'; end if;
    budget_limit := case when blocker_code is null then (selected_config ->> 'budget_cents')::integer else 0 end; max_attempts := case when blocker_code is null then (selected_config ->> 'max_attempts')::integer else 1 end;
    insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version, last_result, completed_at)
    values (candidate.id, 'generate_narration', case when blocker_code is null then 'ready'::public.task_status else 'blocked'::public.task_status end,
      jsonb_strip_nulls(jsonb_build_object('capability','narration_generation','storyboard_review_package_id',candidate.storyboard_review_package_id,'configuration_hash',configuration_hash,'executor',executor,'media',jsonb_build_object('adapter','google_tts','narration',jsonb_build_object('text',narration_text,'voice',selected_config -> 'voice')),'audio_track',jsonb_build_object('kind','narration','cue_id','episode_narration','source_review_package_id',candidate.storyboard_review_package_id,'start_seconds',0,'duration_seconds',narration_duration),'budget',jsonb_build_object('limit_cents',budget_limit,'max_attempts',max_attempts),'allowed_tools',selected_config -> 'allowed_tools','output',jsonb_build_object('required_artifact_types',jsonb_build_array('narration_audio'),'content_type','audio/mpeg','relative_path',format('episodes/%s/audio/narration-%s.mp3',candidate.id,candidate.storyboard_review_package_id),'review_stage','production_ready'),'input_artifacts',candidate.storyboard_context -> 'input_artifacts')), budget_limit, max_attempts, coalesce(executor ->> 'provider','unconfigured'), coalesce(executor ->> 'model','unconfigured'), coalesce(executor ->> 'prompt_version','unconfigured'),
      case when blocker_code is null then null else jsonb_build_object('version','worker-result/v1','taskId','','status','blocked','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array()),'actualCostCents',0,'blockers',jsonb_build_array(jsonb_build_object('code',blocker_code,'detail',blocker_detail)),'retry',jsonb_build_object('shouldRetry',false,'reason',blocker_detail),'nextStep','修正冻结的旁白配置后，使用新的配置创建任务。') end, case when blocker_code is null then null else now() end) returning * into created_task;
    if blocker_code is not null then update public.tasks set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text)) where id = created_task.id returning * into created_task; insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (candidate.account_id,candidate.id,'narration_task_blocked',jsonb_build_object('task_id',created_task.id,'code',blocker_code,'detail',blocker_detail),null); end if;
    return next created_task;
  end loop;
end;
$$;

create or replace function public.register_completed_audio_track()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare selected_artifact public.artifacts; track_snapshot jsonb; source_package public.review_packages;
begin
  if new.status <> 'completed' or new.task_type not in ('generate_narration', 'extract_embedded_audio', 'generate_soundtrack') then return new; end if;
  track_snapshot := new.input_snapshot -> 'audio_track';
  if jsonb_typeof(track_snapshot) <> 'object' or track_snapshot ->> 'kind' not in ('narration','derived','bgm','sfx') or coalesce(btrim(track_snapshot ->> 'cue_id'),'') = '' or jsonb_typeof(track_snapshot -> 'duration_seconds') <> 'number' or (track_snapshot ->> 'duration_seconds')::numeric <= 0 then raise exception 'Completed audio task has an invalid frozen audio track snapshot' using errcode = '22023'; end if;
  if track_snapshot ? 'source_review_package_id' then select * into source_package from public.review_packages where id = (track_snapshot ->> 'source_review_package_id')::uuid and episode_id = new.episode_id; if not found then raise exception 'Audio track source review package is invalid' using errcode = '22023'; end if; end if;
  select * into selected_artifact from public.artifacts artifact where artifact.producer_task_id = new.id and artifact.relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then raise exception 'Completed audio task is missing its frozen output artifact' using errcode = '22023'; end if;
  insert into public.audio_tracks (episode_id,source_task_id,source_artifact_id,source_review_package_id,track_kind,cue_id,relative_path,sha256,file_size,start_seconds,duration_seconds)
  values (new.episode_id,new.id,selected_artifact.id,nullif(track_snapshot ->> 'source_review_package_id','')::uuid,track_snapshot ->> 'kind',track_snapshot ->> 'cue_id',selected_artifact.relative_path,selected_artifact.sha256,selected_artifact.file_size,coalesce((track_snapshot ->> 'start_seconds')::numeric,0),(track_snapshot ->> 'duration_seconds')::numeric);
  return new;
end;
$$;

create or replace function public.create_audio_track_annotation(p_audio_track_id uuid, p_at_seconds numeric, p_reason text)
returns public.audio_track_annotations language plpgsql security definer set search_path = ''
as $$
declare track public.audio_tracks; membership_role public.member_role; created_annotation public.audio_track_annotations;
begin
  if p_at_seconds < 0 or p_at_seconds > 86400 or btrim(coalesce(p_reason,'')) = '' then raise exception 'Audio annotation is invalid' using errcode = '22023'; end if;
  select * into track from public.audio_tracks where id = p_audio_track_id; if not found then raise exception 'Audio track does not exist' using errcode = 'P0002'; end if;
  if p_at_seconds > track.duration_seconds then raise exception 'Audio annotation must be within the audio duration' using errcode = '22023'; end if;
  select membership.role into membership_role from public.account_memberships membership join public.episodes episode on episode.account_id = membership.account_id where episode.id = track.episode_id and membership.user_id = auth.uid();
  if membership_role is distinct from 'owner' then raise exception 'Owner membership is required to annotate an audio track' using errcode = '42501'; end if;
  insert into public.audio_track_annotations (audio_track_id,author_id,at_seconds,reason) values (track.id,auth.uid(),p_at_seconds,btrim(p_reason)) returning * into created_annotation; return created_annotation;
end;
$$;

revoke all on function public.freeze_worker_task_run() from public, anon, authenticated;
revoke all on function public.claim_next_worker_task() from public, anon, authenticated;
grant execute on function public.claim_next_worker_task() to service_role;
revoke all on function public.orchestrate_b_roll_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_b_roll_tasks() to service_role;
revoke all on function public.orchestrate_narration_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_narration_tasks() to service_role;
revoke all on function public.register_completed_audio_track() from public, anon, authenticated;
revoke all on function public.create_audio_track_annotation(uuid,numeric,text) from public, anon;
grant execute on function public.create_audio_track_annotation(uuid,numeric,text) to authenticated;
