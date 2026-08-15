-- Operations may dispatch media work for one explicit production order without
-- creating tasks for every episode currently waiting at the storyboard stage.
alter function public.orchestrate_b_roll_tasks() rename to orchestrate_b_roll_tasks_all;
alter function public.orchestrate_b_roll_tasks_legacy() rename to orchestrate_b_roll_tasks_legacy_all;

create function public.orchestrate_b_roll_tasks_legacy(p_episode_id uuid default null)
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
    where episode.stage = 'storyboard_approved' and (p_episode_id is null or episode.id = p_episode_id)
    order by episode.updated_at, episode.id for update of episode skip locked
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

create function public.orchestrate_b_roll_tasks(p_episode_id uuid default null)
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare created_task public.tasks; corrected_query text;
begin
  for created_task in select * from public.orchestrate_b_roll_tasks_legacy(p_episode_id)
  loop
    if created_task.status = 'ready' then
      corrected_query := left(btrim(created_task.input_snapshot #>> '{shot,scriptSegment}'), 100);
      if corrected_query = '' then raise exception 'B-roll task is missing a frozen search query basis' using errcode = '22023'; end if;
      update public.tasks set input_snapshot = jsonb_set(input_snapshot, '{media,b_roll,query}', to_jsonb(corrected_query)) where id = created_task.id returning * into created_task;
    end if;
    return next created_task;
  end loop;
end;
$$;

alter function public.orchestrate_narration_tasks() rename to orchestrate_narration_tasks_all;

create function public.orchestrate_narration_tasks(p_episode_id uuid default null)
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare candidate record; selected_config jsonb; executor jsonb; configuration_hash text; shot jsonb; shot_duration numeric; start_seconds numeric; budget_limit integer; max_attempts integer; blocker_code text; blocker_detail text; created_task public.tasks;
begin
  for candidate in
    select episode.*, blueprint.policy as blueprint_policy, series_version.rules as series_rules, review_package.id as storyboard_review_package_id, review_package.context_snapshot as storyboard_context
    from public.episodes episode join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join lateral (select package.* from public.review_packages package join public.approvals approval on approval.review_package_id = package.id and approval.stage = 'storyboard_approved' and approval.decision = 'approved' where package.episode_id = episode.id and package.stage = 'storyboard_review' order by package.revision_number desc limit 1) review_package on true
    left join public.series_versions series_version on series_version.id = episode.series_version_id and series_version.account_id = episode.account_id
    where episode.stage = 'storyboard_approved' and (p_episode_id is null or episode.id = p_episode_id)
      and not exists (select 1 from public.production_material_revisions material join public.material_revision_approvals approval on approval.material_revision_id = material.id where material.episode_id = episode.id and material.material_type = 'video' and material.storage_path ~* '[.](mp4|mov|webm)$')
    order by episode.updated_at, episode.id for update of episode skip locked
  loop
    selected_config := coalesce(candidate.series_rules -> 'narration', candidate.blueprint_policy -> 'narration'); configuration_hash := md5(coalesce(selected_config::text, 'null')); executor := selected_config -> 'executor'; start_seconds := 0;
    for shot in select value from jsonb_array_elements(coalesce(candidate.storyboard_context #> '{worker_result,storyboard,shots}', '[]'::jsonb))
    loop
      if coalesce(btrim(shot ->> 'id'), '') = '' or coalesce(btrim(shot ->> 'scriptSegment'), '') = '' or coalesce(shot ->> 'durationSeconds', '') !~ '^[0-9]+([.][0-9]+)?$' or (shot ->> 'durationSeconds')::numeric <= 0 then raise exception 'Approved storyboard shot is invalid' using errcode = '22023'; end if;
      shot_duration := (shot ->> 'durationSeconds')::numeric;
      if exists (select 1 from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_narration' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text and task.input_snapshot #>> '{audio_track,cue_id}' = shot ->> 'id' and task.input_snapshot ->> 'configuration_hash' = configuration_hash) then start_seconds := start_seconds + shot_duration; continue; end if;
      blocker_code := null; blocker_detail := null;
      if jsonb_typeof(selected_config) <> 'object' then blocker_code := 'narration_executor_missing'; blocker_detail := '蓝图或系列规则未声明 narration 执行器配置。';
      elsif jsonb_typeof(executor) <> 'object' or executor ->> 'provider' <> 'google_tts' or executor ->> 'adapter' <> 'google_tts' or coalesce(btrim(executor ->> 'model'), '') = '' or coalesce(btrim(executor ->> 'prompt_version'), '') = '' then blocker_code := 'narration_executor_invalid'; blocker_detail := '旁白配置必须精确声明 google_tts 适配器、模型与提示版本。';
      elsif jsonb_typeof(selected_config -> 'allowed_tools') <> 'array' or jsonb_array_length(selected_config -> 'allowed_tools') = 0 then blocker_code := 'narration_allowed_tools_invalid'; blocker_detail := '旁白配置必须声明非空的允许工具清单。';
      elsif jsonb_typeof(selected_config -> 'budget_cents') <> 'number' or selected_config ->> 'budget_cents' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'budget_cents') > 10 or (length(selected_config ->> 'budget_cents') = 10 and selected_config ->> 'budget_cents' > '2147483647') then blocker_code := 'narration_budget_invalid'; blocker_detail := '旁白配置必须提供有效预算。';
      elsif jsonb_typeof(selected_config -> 'max_attempts') <> 'number' or selected_config ->> 'max_attempts' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_attempts') > 10 or (length(selected_config ->> 'max_attempts') = 10 and selected_config ->> 'max_attempts' > '2147483647') then blocker_code := 'narration_scheduling_invalid'; blocker_detail := '旁白配置必须提供有效最大尝试次数。';
      elsif jsonb_typeof(selected_config -> 'voice') <> 'object' or coalesce(btrim(selected_config #>> '{voice,language_code}'), '') = '' or coalesce(btrim(selected_config #>> '{voice,name}'), '') = '' or jsonb_typeof(selected_config #> '{voice,speaking_rate}') <> 'number' or (selected_config #>> '{voice,speaking_rate}')::numeric <= 0 then blocker_code := 'narration_voice_invalid'; blocker_detail := '旁白配置必须冻结有效语言、声音与语速。'; end if;
      budget_limit := case when blocker_code is null then (selected_config ->> 'budget_cents')::integer else 0 end; max_attempts := case when blocker_code is null then (selected_config ->> 'max_attempts')::integer else 1 end;
      insert into public.tasks (episode_id,task_type,status,input_snapshot,budget_limit_cents,max_attempts,provider,model,prompt_version,last_result,completed_at)
      values (candidate.id,'generate_narration',case when blocker_code is null then 'ready'::public.task_status else 'blocked'::public.task_status end,
        jsonb_strip_nulls(jsonb_build_object('capability','narration_generation','storyboard_review_package_id',candidate.storyboard_review_package_id,'configuration_hash',configuration_hash,'executor',executor,'media',jsonb_build_object('adapter','google_tts','narration',jsonb_build_object('text',btrim(shot ->> 'scriptSegment'),'voice',selected_config -> 'voice')),'audio_track',jsonb_build_object('kind','narration','cue_id',shot ->> 'id','source_review_package_id',candidate.storyboard_review_package_id,'start_seconds',start_seconds,'duration_seconds',shot_duration),'budget',jsonb_build_object('limit_cents',budget_limit,'max_attempts',max_attempts),'allowed_tools',selected_config -> 'allowed_tools','output',jsonb_build_object('required_artifact_types',jsonb_build_array('narration_audio'),'content_type','audio/mpeg','relative_path',format('episodes/%s/audio/narration-%s-%s.mp3',candidate.id,candidate.storyboard_review_package_id,shot ->> 'id'),'review_stage','production_ready'),'input_artifacts',candidate.storyboard_context -> 'input_artifacts')),
        budget_limit,max_attempts,coalesce(executor ->> 'provider','unconfigured'),coalesce(executor ->> 'model','unconfigured'),coalesce(executor ->> 'prompt_version','unconfigured'),case when blocker_code is null then null else jsonb_build_object('version','worker-result/v1','taskId','','status','blocked','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array()),'actualCostCents',0,'blockers',jsonb_build_array(jsonb_build_object('code',blocker_code,'detail',blocker_detail)),'retry',jsonb_build_object('shouldRetry',false,'reason',blocker_detail),'nextStep','修正冻结的旁白配置后，使用新的配置创建任务。') end,case when blocker_code is null then null else now() end) returning * into created_task;
      if blocker_code is not null then update public.tasks set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text)) where id = created_task.id returning * into created_task; insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id) values (candidate.account_id,candidate.id,'narration_task_blocked',jsonb_build_object('task_id',created_task.id,'cue_id',shot ->> 'id','code',blocker_code,'detail',blocker_detail),null); end if;
      return next created_task; start_seconds := start_seconds + shot_duration;
    end loop;
  end loop;
end;
$$;

revoke all on function public.orchestrate_b_roll_tasks(uuid) from public, anon, authenticated;
grant execute on function public.orchestrate_b_roll_tasks(uuid) to service_role;
revoke all on function public.orchestrate_narration_tasks(uuid) from public, anon, authenticated;
grant execute on function public.orchestrate_narration_tasks(uuid) to service_role;
