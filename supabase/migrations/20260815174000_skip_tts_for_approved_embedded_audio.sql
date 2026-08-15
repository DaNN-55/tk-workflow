create or replace function public.orchestrate_narration_tasks()
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
    where episode.stage = 'storyboard_approved'
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

revoke all on function public.orchestrate_narration_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_narration_tasks() to service_role;
