create unique index tasks_one_soundtrack_per_storyboard_cue_configuration_idx
on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot #>> '{audio_track,cue_id}'), (input_snapshot ->> 'configuration_hash'))
where task_type = 'generate_soundtrack';

create function public.orchestrate_soundtrack_tasks()
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare
  candidate record; cue jsonb; selected_config jsonb; configuration_hash text; created_task public.tasks; blocker_code text; blocker_detail text;
begin
  for candidate in
    select episode.*, blueprint.policy as blueprint_policy, series_version.rules as series_rules, review_package.id as review_package_id, review_package.context_snapshot as review_context
    from public.episodes episode
    join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join lateral (select package.* from public.review_packages package join public.approvals approval on approval.review_package_id = package.id and approval.stage = 'storyboard_approved' and approval.decision = 'approved' where package.episode_id = episode.id and package.stage = 'storyboard_review' order by package.revision_number desc limit 1) review_package on true
    left join public.series_versions series_version on series_version.id = episode.series_version_id and series_version.account_id = episode.account_id
    where episode.stage = 'storyboard_approved'
    order by episode.updated_at, episode.id for update of episode skip locked
  loop
    selected_config := coalesce(candidate.series_rules -> 'soundtrack', candidate.blueprint_policy -> 'soundtrack');
    configuration_hash := md5(coalesce(selected_config::text, 'null'));
    for cue in select value from jsonb_array_elements(coalesce(candidate.review_context #> '{worker_result,storyboard,audioCues}', '[]'::jsonb))
    loop
      if cue ->> 'kind' not in ('bgm', 'sfx') or coalesce(btrim(cue ->> 'id'), '') = '' or coalesce(btrim(cue ->> 'description'), '') = '' or coalesce(cue ->> 'durationSeconds', '') !~ '^[0-9]+(\.[0-9]+)?$' or coalesce(cue ->> 'startSeconds', '') !~ '^[0-9]+(\.[0-9]+)?$' or (cue ->> 'durationSeconds')::numeric <= 0 or (cue ->> 'startSeconds')::numeric < 0 then
        raise exception 'Storyboard audio cue is invalid' using errcode = '22023';
      end if;
      if exists (select 1 from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_soundtrack' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.review_package_id::text and task.input_snapshot #>> '{audio_track,cue_id}' = cue ->> 'id' and task.input_snapshot ->> 'configuration_hash' = configuration_hash) then continue; end if;
      if jsonb_typeof(selected_config) <> 'object' then blocker_code := 'soundtrack_executor_missing'; blocker_detail := '分镜已声明可选 BGM/SFX，但蓝图或系列规则尚未配置音频生成适配器。';
      else blocker_code := 'soundtrack_executor_unavailable'; blocker_detail := '可选 BGM/SFX 已冻结，但当前尚未注册能生成并验证试听音频的适配器。'; end if;
      insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version, last_result, completed_at)
      values (candidate.id, 'generate_soundtrack', 'blocked', jsonb_build_object(
        'capability','soundtrack_generation','storyboard_review_package_id',candidate.review_package_id,'configuration_hash',configuration_hash,'audio_cue',cue,
        'audio_track',jsonb_build_object('kind',cue ->> 'kind','cue_id',cue ->> 'id','source_review_package_id',candidate.review_package_id,'start_seconds',(cue ->> 'startSeconds')::numeric,'duration_seconds',(cue ->> 'durationSeconds')::numeric),
        'input_artifacts',candidate.review_context -> 'input_artifacts','output',jsonb_build_object('required_artifact_types',jsonb_build_array('soundtrack_audio'),'content_type','audio/mpeg','relative_path',format('episodes/%s/audio/%s-%s.mp3',candidate.id,cue ->> 'kind',cue ->> 'id'),'review_stage','production_ready')),
        0, 1, 'unconfigured', 'unconfigured', 'soundtrack-v1', jsonb_build_object('version','worker-result/v1','taskId','','status','blocked','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array()),'actualCostCents',0,'blockers',jsonb_build_array(jsonb_build_object('code',blocker_code,'detail',blocker_detail)),'retry',jsonb_build_object('shouldRetry',false,'reason',blocker_detail),'nextStep','Configure a registered soundtrack adapter before creating a new frozen cue task.'), now()) returning * into created_task;
      update public.tasks set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text)) where id = created_task.id returning * into created_task;
      insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (candidate.account_id,candidate.id,'soundtrack_task_blocked',jsonb_build_object('task_id',created_task.id,'cue_id',cue ->> 'id','code',blocker_code,'detail',blocker_detail),null);
      return next created_task;
    end loop;
  end loop;
end;
$$;

revoke all on function public.orchestrate_soundtrack_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_soundtrack_tasks() to service_role;
