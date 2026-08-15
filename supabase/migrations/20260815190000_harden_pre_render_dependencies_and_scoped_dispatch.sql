-- Keep the deployed zero-argument package builder correct, then expose the same
-- builder for an explicitly scoped Episode without letting a local dispatch touch
-- another Episode.  This migration intentionally derives the scoped definition
-- from the immediately preceding, deployed function so both entry points retain
-- the same frozen-package contract.
do $$
declare
  definition text;
  scoped_definition text;
begin
  select pg_get_functiondef('public.create_pre_render_review_packages()'::regprocedure) into definition;

  definition := replace(
    definition,
    'and task.status = ''completed''',
    'and task.status = ''completed'' and task.invalidated_at is null'
  );
  definition := replace(
    definition,
    'select * into selected_task from public.tasks where id = selected_track.source_task_id;',
    'select * into selected_task from public.tasks where id = selected_track.source_task_id and status = ''completed'' and invalidated_at is null; if not found then continue; end if;'
  );
  definition := replace(
    definition,
    'for audio_cue in select value from jsonb_array_elements(coalesce(candidate.storyboard_context #> ''{worker_result,storyboard,audioCues}'', ''[]''::jsonb)) loop
      select track.* into selected_track',
    'for audio_cue in select value from jsonb_array_elements(coalesce(candidate.storyboard_context #> ''{worker_result,storyboard,audioCues}'', ''[]''::jsonb)) loop
      expected_member_count := expected_member_count + 1;
      select track.* into selected_track'
  );
  definition := replace(
    definition,
    'members := members || jsonb_build_array(member_evidence);
      expected_member_count := expected_member_count + 1;
    end loop;
    if jsonb_array_length(members) <> expected_member_count then
      continue;
    end if;',
    'members := members || jsonb_build_array(member_evidence);
    end loop;
    if jsonb_array_length(members) <> expected_member_count then
      continue;
    end if;'
  );
  definition := replace(
    definition,
    'join public.pre_render_review_members previous_member
        on previous_member.review_package_id = decision.review_package_id
       and previous_member.member_key = decision.member_key',
    'join public.pre_render_review_members previous_member
        on previous_member.review_package_id = decision.review_package_id
       and previous_member.member_key = decision.member_key
      join public.review_packages previous_package on previous_package.id = decision.review_package_id
      join public.tasks previous_task on previous_task.id = previous_member.source_task_id'
  );
  definition := replace(
    definition,
    'and decision.decision = ''approved''',
    'and decision.decision = ''approved''
        and previous_package.invalidated_at is null
        and previous_task.status = ''completed''
        and previous_task.invalidated_at is null'
  );

  if position('task.invalidated_at is null' in definition) = 0
    or position('expected_member_count := expected_member_count + 1;
      select track.*' in definition) = 0
    or position('previous_package.invalidated_at is null' in definition) = 0 then
    raise exception 'Unable to harden pre-render package builder: expected deployed definition changed';
  end if;
  execute definition;

  scoped_definition := replace(
    definition,
    'FUNCTION public.create_pre_render_review_packages()',
    'FUNCTION public.create_pre_render_review_packages_for_episode(p_episode_id uuid)'
  );
  scoped_definition := replace(
    scoped_definition,
    'where episode.stage = ''production_ready''',
    'where episode.stage = ''production_ready'' and episode.id = p_episode_id'
  );
  if position('create_pre_render_review_packages_for_episode(p_episode_id uuid)' in scoped_definition) = 0
    or position('episode.id = p_episode_id' in scoped_definition) = 0 then
    raise exception 'Unable to create scoped pre-render package builder';
  end if;
  execute scoped_definition;
end;
$$;

create or replace function public.record_task_production_dependencies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_input jsonb;
  material public.production_material_revisions;
  series_version_id uuid;
  storyboard_package_id uuid;
begin
  if coalesce(new.input_snapshot ->> 'storyboard_review_package_id', '') <> '' then
    storyboard_package_id := (new.input_snapshot ->> 'storyboard_review_package_id')::uuid;
    insert into public.production_dependencies (episode_id, upstream_kind, upstream_id, downstream_kind, downstream_id)
    values (new.episode_id, 'review_package', storyboard_package_id, 'task', new.id)
    on conflict do nothing;
  end if;

  for source_input in select value from jsonb_array_elements(coalesce(new.input_snapshot -> 'input_artifacts', '[]'::jsonb)) loop
    select revision.* into material
    from public.production_material_revisions revision
    where revision.episode_id = new.episode_id
      and revision.storage_path = source_input ->> 'relativePath'
      and revision.sha256 = source_input ->> 'sha256'
    limit 1;
    if found then
      insert into public.production_dependencies (episode_id, upstream_kind, upstream_id, downstream_kind, downstream_id)
      values (new.episode_id, 'material_revision', material.id, 'task', new.id)
      on conflict do nothing;
    end if;
  end loop;

  if coalesce(new.input_snapshot #>> '{series_baseline,version_id}', '') <> '' then
    series_version_id := (new.input_snapshot #>> '{series_baseline,version_id}')::uuid;
    insert into public.production_dependencies (episode_id, upstream_kind, upstream_id, downstream_kind, downstream_id)
    values (new.episode_id, 'series_version', series_version_id, 'task', new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger record_task_production_dependencies_after_insert
after insert on public.tasks
for each row execute function public.record_task_production_dependencies();

insert into public.production_dependencies (episode_id, upstream_kind, upstream_id, downstream_kind, downstream_id)
select task.episode_id, 'review_package', (task.input_snapshot ->> 'storyboard_review_package_id')::uuid, 'task', task.id
from public.tasks task
where task.input_snapshot ->> 'storyboard_review_package_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict do nothing;

insert into public.production_dependencies (episode_id, upstream_kind, upstream_id, downstream_kind, downstream_id)
select task.episode_id, 'material_revision', material.id, 'task', task.id
from public.tasks task
cross join lateral jsonb_array_elements(coalesce(task.input_snapshot -> 'input_artifacts', '[]'::jsonb)) source_input
join public.production_material_revisions material
  on material.episode_id = task.episode_id
 and material.storage_path = source_input.value ->> 'relativePath'
 and material.sha256 = source_input.value ->> 'sha256'
on conflict do nothing;

insert into public.production_dependencies (episode_id, upstream_kind, upstream_id, downstream_kind, downstream_id)
select task.episode_id, 'series_version', (task.input_snapshot #>> '{series_baseline,version_id}')::uuid, 'task', task.id
from public.tasks task
where task.input_snapshot #>> '{series_baseline,version_id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict do nothing;

create or replace function public.has_required_artifacts(p_episode_id uuid, p_to_stage public.episode_stage)
returns boolean
language sql
stable
set search_path = public
as $$
  select case p_to_stage
    when 'script_approved'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'script')
    when 'visual_approved'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'visual_brief')
    when 'storyboard_approved'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'storyboard')
    when 'render_ready'::public.episode_stage then exists (
      select 1
      from public.review_packages package
      where package.episode_id = p_episode_id
        and package.stage = 'production_ready'
        and package.invalidated_at is null
        and not exists (
          select 1
          from public.pre_render_review_members member
          join public.tasks source_task on source_task.id = member.source_task_id
          where member.review_package_id = package.id
            and (source_task.status <> 'completed' or source_task.invalidated_at is not null or not exists (
              select 1 from public.pre_render_review_member_decisions decision
              where decision.review_package_id = member.review_package_id
                and decision.member_key = member.member_key
                and decision.decision = 'approved'
            ))
        )
    )
    when 'qc_passed'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'render')
    else true
  end;
$$;

drop function public.claim_next_worker_task();

create function public.claim_next_worker_task(p_task_id uuid default null)
returns table (task_id uuid, task_type text, attempt integer, budget_limit_cents integer, max_attempts integer, provider text, model text, prompt_version text, episode_id uuid, account_id uuid, blueprint_version_id uuid, title text, allowed_asset_root text, input_snapshot jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  reclaimed_task public.tasks;
  selected_task public.tasks;
begin
  if p_task_id is null then
    for reclaimed_task in select * from public.tasks where status = 'running' and claimed_at < now() - interval '30 minutes' for update skip locked
    loop
      update public.task_runs task_run set status = 'failed', result = jsonb_build_object('version','worker-result/v1','taskId',reclaimed_task.id,'status','failed','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array(jsonb_build_object('name','worker_lease','passed',false,'detail','Worker lease expired before it reported a result.'))),'actualCostCents',0,'blockers',jsonb_build_array(),'retry',jsonb_build_object('shouldRetry',reclaimed_task.attempt < reclaimed_task.max_attempts,'reason','Worker lease expired.'),'nextStep','Retry the task only after the worker is available.'), completed_at = now() where task_run.task_id = reclaimed_task.id and task_run.status = 'running';
      update public.tasks task set status = case when reclaimed_task.attempt < reclaimed_task.max_attempts then 'ready'::public.task_status else 'failed'::public.task_status end, claimed_at = null, completed_at = case when reclaimed_task.attempt < reclaimed_task.max_attempts then null else now() end, last_result = jsonb_build_object('version','worker-result/v1','taskId',reclaimed_task.id,'status','failed','artifacts',jsonb_build_array(),'validation',jsonb_build_object('passed',false,'checks',jsonb_build_array(jsonb_build_object('name','worker_lease','passed',false,'detail','Worker lease expired before it reported a result.'))),'actualCostCents',0,'blockers',jsonb_build_array(),'retry',jsonb_build_object('shouldRetry',reclaimed_task.attempt < reclaimed_task.max_attempts,'reason','Worker lease expired.'),'nextStep','Retry the task only after the worker is available.') where task.id = reclaimed_task.id;
      insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id) select episode.account_id,episode.id,'worker_lease_expired',jsonb_build_object('task_id',reclaimed_task.id,'attempt',reclaimed_task.attempt - 1),null from public.episodes episode where episode.id = reclaimed_task.episode_id;
    end loop;
  end if;
  select * into selected_task from public.tasks task
  where task.status = 'ready'
    and task.provider in ('codex', 'google_tts', 'pexels', 'ffmpeg', 'freesound')
    and task.attempt < task.max_attempts
    and (p_task_id is null or task.id = p_task_id)
  order by task.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.tasks task set status = 'running', claimed_at = now(), attempt = task.attempt + 1 where task.id = selected_task.id;
  insert into public.task_runs (task_id, attempt, task_package)
  select selected_task.id, selected_task.attempt, jsonb_build_object('version', 'worker-task/v1', 'task_id', selected_task.id, 'task_type', selected_task.task_type, 'attempt', selected_task.attempt, 'budget_limit_cents', selected_task.budget_limit_cents, 'max_attempts', selected_task.max_attempts, 'provider', selected_task.provider, 'model', selected_task.model, 'prompt_version', selected_task.prompt_version, 'episode_id', episode.id, 'account_id', account.id, 'blueprint_version_id', episode.blueprint_version_id, 'allowed_asset_root', coalesce(blueprint.policy ->> 'asset_root', ''), 'input_snapshot', selected_task.input_snapshot)
  from public.episodes episode join public.accounts account on account.id = episode.account_id join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id where episode.id = selected_task.episode_id;
  return query select selected_task.id, selected_task.task_type, selected_task.attempt, selected_task.budget_limit_cents, selected_task.max_attempts, selected_task.provider, selected_task.model, selected_task.prompt_version, episode.id, account.id, episode.blueprint_version_id, episode.title, coalesce(blueprint.policy ->> 'asset_root', ''), selected_task.input_snapshot from public.episodes episode join public.accounts account on account.id = episode.account_id join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id where episode.id = selected_task.episode_id;
end;
$$;

revoke all on function public.create_pre_render_review_packages_for_episode(uuid) from public, anon, authenticated;
grant execute on function public.create_pre_render_review_packages_for_episode(uuid) to service_role;
revoke all on function public.record_task_production_dependencies() from public, anon, authenticated;
revoke all on function public.claim_next_worker_task(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_worker_task(uuid) to service_role;
