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
  where task.status = 'ready' and task.provider in ('codex', 'google_tts', 'pexels', 'ffmpeg', 'freesound') and task.attempt < task.max_attempts
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

create or replace function public.orchestrate_soundtrack_tasks()
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare
  candidate record; cue jsonb; selected_config jsonb; executor jsonb; configuration_hash text; created_task public.tasks; blocker_code text; blocker_detail text; budget_limit integer; max_attempts integer;
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
    executor := selected_config -> 'executor';
    for cue in select value from jsonb_array_elements(coalesce(candidate.review_context #> '{worker_result,storyboard,audioCues}', '[]'::jsonb))
    loop
      if cue ->> 'kind' not in ('bgm', 'sfx') or coalesce(btrim(cue ->> 'id'), '') = '' or coalesce(btrim(cue ->> 'description'), '') = '' or length(cue ->> 'description') > 100 or coalesce(cue ->> 'durationSeconds', '') !~ '^[0-9]+([.][0-9]+)?$' or coalesce(cue ->> 'startSeconds', '') !~ '^[0-9]+([.][0-9]+)?$' or (cue ->> 'durationSeconds')::numeric <= 0 or (cue ->> 'startSeconds')::numeric < 0 then
        raise exception 'Storyboard audio cue is invalid' using errcode = '22023';
      end if;
      if exists (select 1 from public.tasks task where task.episode_id = candidate.id and task.task_type = 'generate_soundtrack' and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.review_package_id::text and task.input_snapshot #>> '{audio_track,cue_id}' = cue ->> 'id' and task.input_snapshot ->> 'configuration_hash' = configuration_hash) then continue; end if;
      blocker_code := null; blocker_detail := null;
      if jsonb_typeof(selected_config) <> 'object' then blocker_code := 'soundtrack_executor_missing'; blocker_detail := '蓝图或系列规则未声明声轨执行器配置。';
      elsif jsonb_typeof(executor) <> 'object' or executor ->> 'provider' <> 'freesound' or executor ->> 'adapter' <> 'freesound_preview' or executor ->> 'model' <> 'freesound-preview-v1' or coalesce(btrim(executor ->> 'prompt_version'), '') = '' then blocker_code := 'soundtrack_executor_invalid'; blocker_detail := '测试声轨配置必须精确声明 freesound/freesound_preview/freesound-preview-v1。';
      elsif jsonb_typeof(selected_config -> 'allowed_tools') <> 'array' or jsonb_array_length(selected_config -> 'allowed_tools') = 0 then blocker_code := 'soundtrack_allowed_tools_invalid'; blocker_detail := '声轨配置必须声明非空的允许工具清单。';
      elsif jsonb_typeof(selected_config -> 'budget_cents') <> 'number' or selected_config ->> 'budget_cents' !~ '^[0-9]+$' or length(selected_config ->> 'budget_cents') > 10 or (length(selected_config ->> 'budget_cents') = 10 and selected_config ->> 'budget_cents' > '2147483647') then blocker_code := 'soundtrack_budget_invalid'; blocker_detail := '声轨配置必须提供有效预算。';
      elsif jsonb_typeof(selected_config -> 'max_attempts') <> 'number' or selected_config ->> 'max_attempts' !~ '^[1-9][0-9]*$' or length(selected_config ->> 'max_attempts') > 10 or (length(selected_config ->> 'max_attempts') = 10 and selected_config ->> 'max_attempts' > '2147483647') then blocker_code := 'soundtrack_scheduling_invalid'; blocker_detail := '声轨配置必须提供有效最大尝试次数。'; end if;
      budget_limit := case when blocker_code is null then (selected_config ->> 'budget_cents')::integer else 0 end;
      max_attempts := case when blocker_code is null then (selected_config ->> 'max_attempts')::integer else 1 end;
      insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version, last_result, completed_at)
      values (candidate.id, 'generate_soundtrack', case when blocker_code is null then 'ready'::public.task_status else 'blocked'::public.task_status end, jsonb_strip_nulls(jsonb_build_object(
        'capability','soundtrack_generation','storyboard_review_package_id',candidate.review_package_id,'configuration_hash',configuration_hash,'executor',executor,
        'media',jsonb_build_object('adapter','freesound_preview','soundtrack',jsonb_build_object('query',btrim(cue ->> 'description'),'target_duration_seconds',(cue ->> 'durationSeconds')::numeric,'cue',jsonb_build_object('id',cue ->> 'id','kind',cue ->> 'kind','description',cue ->> 'description','start_seconds',(cue ->> 'startSeconds')::numeric,'duration_seconds',(cue ->> 'durationSeconds')::numeric))),
        'audio_track',jsonb_build_object('kind',cue ->> 'kind','cue_id',cue ->> 'id','source_review_package_id',candidate.review_package_id,'start_seconds',(cue ->> 'startSeconds')::numeric,'duration_seconds',(cue ->> 'durationSeconds')::numeric),
        'budget',jsonb_build_object('limit_cents',budget_limit,'max_attempts',max_attempts),'allowed_tools',selected_config -> 'allowed_tools','output',jsonb_build_object('required_artifact_types',jsonb_build_array('soundtrack_audio'),'content_type','audio/mpeg','relative_path',format('episodes/%s/audio/%s-%s.mp3',candidate.id,cue ->> 'kind',cue ->> 'id'),'review_stage','production_ready'),'input_artifacts',candidate.review_context -> 'input_artifacts')),
        budget_limit,max_attempts,coalesce(executor ->> 'provider','unconfigured'),coalesce(executor ->> 'model','unconfigured'),coalesce(executor ->> 'prompt_version','unconfigured'),
        case when blocker_code is null then null else jsonb_build_object('version','worker-result/v1','taskId','','status','blocked','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array()),'actualCostCents',0,'blockers',jsonb_build_array(jsonb_build_object('code',blocker_code,'detail',blocker_detail)),'retry',jsonb_build_object('shouldRetry',false,'reason',blocker_detail),'nextStep','修正冻结的声轨配置后，使用新的配置创建任务。') end,
        case when blocker_code is null then null else now() end) returning * into created_task;
      if blocker_code is not null then
        update public.tasks set last_result = jsonb_set(last_result, '{taskId}', to_jsonb(created_task.id::text)) where id = created_task.id returning * into created_task;
        insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (candidate.account_id,candidate.id,'soundtrack_task_blocked',jsonb_build_object('task_id',created_task.id,'cue_id',cue ->> 'id','code',blocker_code,'detail',blocker_detail),null);
      end if;
      return next created_task;
    end loop;
  end loop;
end;
$$;

revoke all on function public.claim_next_worker_task() from public, anon, authenticated;
grant execute on function public.claim_next_worker_task() to service_role;
revoke all on function public.orchestrate_soundtrack_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_soundtrack_tasks() to service_role;
