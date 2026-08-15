alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
check (task_type in ('draft_brief', 'draft_script', 'prepare_visual_brief', 'draft_storyboard'));

create unique index tasks_one_active_storyboard_draft_idx
on public.tasks (episode_id)
where task_type = 'draft_storyboard' and status in ('ready', 'running');

alter table public.review_packages drop constraint review_packages_stage_check;
alter table public.review_packages add constraint review_packages_stage_check
check (stage in ('script_review', 'visual_review', 'storyboard_review'));

update public.account_blueprint_versions
set policy = policy || jsonb_build_object(
  'budgets', case
    when jsonb_typeof(policy -> 'budgets') = 'object' then
      (policy -> 'budgets') || case
        when policy #> '{budgets,storyboard_planning_cents}' is null then jsonb_build_object('storyboard_planning_cents', 0)
        else '{}'::jsonb
      end
    when policy ? 'budgets' then policy -> 'budgets'
    else jsonb_build_object('storyboard_planning_cents', 0)
  end,
  'executors', case
    when jsonb_typeof(policy -> 'executors') = 'object' then
      (policy -> 'executors') || case
        when policy #> '{executors,storyboard_planning}' is null then jsonb_build_object(
          'storyboard_planning', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.6-luna', 'prompt_version', 'storyboard-planning-v1')
        )
        else '{}'::jsonb
      end
    when policy ? 'executors' then policy -> 'executors'
    else jsonb_build_object(
      'storyboard_planning', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.6-luna', 'prompt_version', 'storyboard-planning-v1')
    )
  end
);

create table public.review_annotations (
  id uuid primary key default gen_random_uuid(),
  review_package_id uuid not null references public.review_packages(id) on delete cascade,
  shot_id text not null check (char_length(btrim(shot_id)) > 0),
  reason text not null check (char_length(btrim(reason)) > 0),
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index review_annotations_package_created_idx
on public.review_annotations (review_package_id, created_at, id);

alter table public.review_annotations enable row level security;
create policy "members can read review annotations" on public.review_annotations
for select to authenticated
using (
  exists (
    select 1
    from public.review_packages review_package
    join public.episodes episode on episode.id = review_package.episode_id
    where review_package.id = review_annotations.review_package_id
      and public.is_account_member(episode.account_id)
  )
);

revoke all on public.review_annotations from anon, authenticated;
grant select on public.review_annotations to authenticated;

create function public.create_storyboard_annotation(
  p_review_package_id uuid,
  p_shot_id text,
  p_reason text
)
returns public.review_annotations
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_package public.review_packages;
  selected_episode public.episodes;
  created_annotation public.review_annotations;
begin
  if coalesce(btrim(p_shot_id), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'Storyboard annotation requires a shot and reason' using errcode = '22023';
  end if;

  select review_package.* into selected_package
  from public.review_packages review_package
  join public.episodes episode on episode.id = review_package.episode_id
  join public.account_memberships membership on membership.account_id = episode.account_id
  where review_package.id = p_review_package_id
    and membership.user_id = auth.uid()
    and membership.role = 'owner'
  for update of review_package;
  if not found then
    raise exception 'Owner membership is required to annotate a storyboard review package' using errcode = '42501';
  end if;
  select * into selected_episode from public.episodes where id = selected_package.episode_id for update;
  if selected_package.stage <> 'storyboard_review' or selected_episode.stage <> 'storyboard_review' then
    raise exception 'Storyboard annotations are only allowed while the matching revision is under review' using errcode = '22023';
  end if;

  insert into public.review_annotations (review_package_id, shot_id, reason, actor_id)
  values (p_review_package_id, btrim(p_shot_id), btrim(p_reason), auth.uid())
  returning * into created_annotation;

  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    selected_episode.account_id,
    selected_episode.id,
    'storyboard_annotation_created',
    jsonb_build_object('review_package_id', p_review_package_id, 'shot_id', btrim(p_shot_id), 'annotation_id', created_annotation.id),
    auth.uid()
  );
  return created_annotation;
end;
$$;

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
  if selected_task.task_type not in ('draft_script', 'prepare_visual_brief', 'draft_storyboard') then
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

create function public.orchestrate_storyboard_tasks()
returns setof public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  created_task public.tasks;
  allowed_tools jsonb;
  budget_limit integer;
  executor_model text;
  prompt_version text;
begin
  for candidate in
    select
      episode.*,
      blueprint.policy,
      script_revision.id as script_revision_id,
      script_revision.storage_path as script_storage_path,
      script_revision.sha256 as script_sha256,
      script_revision.file_size as script_file_size,
      script_revision.mime_type as script_mime_type,
      visual_package.id as visual_review_package_id,
      visual_package.revision_number as visual_review_revision_number,
      visual_package.task_id as visual_task_id,
      visual_package.context_snapshot -> 'series_baseline' as frozen_series_baseline
    from public.episodes episode
    join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join public.production_material_revisions script_revision
      on script_revision.id = episode.main_script_revision_id
     and script_revision.episode_id = episode.id
     and script_revision.is_main_script
    join lateral (
      select review_package.*
      from public.review_packages review_package
      join public.approvals approval
        on approval.review_package_id = review_package.id
       and approval.stage = 'visual_approved'
       and approval.decision = 'approved'
      where review_package.episode_id = episode.id
        and review_package.stage = 'visual_review'
      order by review_package.revision_number desc
      limit 1
    ) visual_package on true
    where episode.stage = 'visual_approved'
      and not exists (
        select 1 from public.tasks task
        where task.episode_id = episode.id and task.task_type = 'draft_storyboard'
      )
    order by episode.updated_at, episode.id
    for update of episode skip locked
  loop
    if jsonb_typeof(candidate.policy -> 'allowed_tools') <> 'array'
      or jsonb_array_length(candidate.policy -> 'allowed_tools') = 0
      or exists (
        select 1 from jsonb_array_elements(candidate.policy -> 'allowed_tools') tool
        where jsonb_typeof(tool) <> 'string' or coalesce(btrim(tool #>> '{}'), '') = ''
      ) then
      raise exception 'Blueprint % has invalid allowed_tools', candidate.blueprint_version_id using errcode = '22023';
    end if;
    if jsonb_typeof(candidate.policy #> '{budgets,storyboard_planning_cents}') <> 'number'
      or candidate.policy #>> '{budgets,storyboard_planning_cents}' !~ '^[0-9]+$' then
      raise exception 'Blueprint % has invalid storyboard planning budget', candidate.blueprint_version_id using errcode = '22023';
    end if;
    if candidate.policy #>> '{executors,storyboard_planning,provider}' <> 'codex'
      or coalesce(btrim(candidate.policy #>> '{executors,storyboard_planning,model}'), '') = ''
      or coalesce(btrim(candidate.policy #>> '{executors,storyboard_planning,prompt_version}'), '') = '' then
      raise exception 'Blueprint % has invalid storyboard planning executor', candidate.blueprint_version_id using errcode = '22023';
    end if;

    allowed_tools := candidate.policy -> 'allowed_tools';
    budget_limit := (candidate.policy #>> '{budgets,storyboard_planning_cents}')::integer;
    executor_model := candidate.policy #>> '{executors,storyboard_planning,model}';
    prompt_version := candidate.policy #>> '{executors,storyboard_planning,prompt_version}';

    insert into public.tasks (
      episode_id, task_type, status, input_snapshot, budget_limit_cents,
      max_attempts, provider, model, prompt_version
    ) values (
      candidate.id,
      'draft_storyboard',
      'ready',
      jsonb_strip_nulls(jsonb_build_object(
        'capability', 'storyboard_planning',
        'script_revision', jsonb_build_object(
          'id', candidate.script_revision_id,
          'storage_path', candidate.script_storage_path,
          'sha256', candidate.script_sha256,
          'file_size', candidate.script_file_size,
          'mime_type', candidate.script_mime_type
        ),
        'series_baseline', candidate.frozen_series_baseline,
        'visual_review_package', jsonb_build_object(
          'id', candidate.visual_review_package_id,
          'revision_number', candidate.visual_review_revision_number
        ),
        'executor', jsonb_build_object(
          'provider', 'codex',
          'model', executor_model,
          'prompt_version', prompt_version
        ),
        'budget', jsonb_build_object('limit_cents', budget_limit, 'max_attempts', 2),
        'allowed_tools', allowed_tools,
        'output', jsonb_build_object(
          'required_artifact_types', jsonb_build_array('storyboard'),
          'content_type', 'application/json',
          'relative_path', format('episodes/%s/storyboard-v1.json', candidate.id),
          'review_stage', 'storyboard_review'
        ),
        'input_artifacts', jsonb_build_array(jsonb_build_object(
          'artifactType', 'main_script',
          'relativePath', candidate.script_storage_path,
          'sha256', candidate.script_sha256,
          'fileSize', candidate.script_file_size
        )) || coalesce((
          select jsonb_agg(jsonb_build_object(
            'artifactType', artifact.artifact_type,
            'relativePath', artifact.relative_path,
            'sha256', artifact.sha256,
            'fileSize', artifact.file_size
          ) order by artifact.created_at, artifact.id)
          from public.artifacts artifact
          where artifact.producer_task_id = candidate.visual_task_id
        ), '[]'::jsonb)
      )),
      budget_limit,
      2,
      'codex',
      executor_model,
      prompt_version
    ) returning * into created_task;

    update public.episodes set stage = 'storyboard_draft', updated_at = now() where id = candidate.id;
    insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
    values (candidate.id, 'visual_approved', 'storyboard_draft', 'Orchestrator froze the first storyboard task from approved script and visual revisions.', null);
    insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
    values (
      candidate.account_id,
      candidate.id,
      'storyboard_task_created',
      jsonb_build_object('task_id', created_task.id, 'visual_review_package_id', candidate.visual_review_package_id, 'script_revision_id', candidate.script_revision_id),
      null
    );
    return next created_task;
  end loop;
end;
$$;

create function public.create_storyboard_review_package()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_episode public.episodes;
  produced_artifact public.artifacts;
  completed_run public.task_runs;
  next_revision integer;
  created_package public.review_packages;
begin
  if new.task_type <> 'draft_storyboard' or new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select * into current_episode from public.episodes where id = new.episode_id for update;
  if current_episode.stage <> 'storyboard_draft' then
    raise exception 'Storyboard planning task can only complete from storyboard_draft' using errcode = '22023';
  end if;
  select * into completed_run
  from public.task_runs
  where task_id = new.id and attempt = new.attempt - 1 and status = 'completed';
  if not found then
    raise exception 'Completed storyboard planning task run is missing' using errcode = '22023';
  end if;
  select * into produced_artifact
  from public.artifacts
  where producer_task_id = new.id
    and artifact_type = 'storyboard'
    and relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then
    raise exception 'Storyboard planning task is missing its frozen storyboard artifact revision' using errcode = '22023';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(completed_run.result -> 'artifacts') result_artifact
    where result_artifact ->> 'artifactType' = produced_artifact.artifact_type
      and result_artifact ->> 'relativePath' = produced_artifact.relative_path
      and result_artifact ->> 'sha256' = produced_artifact.sha256
      and (result_artifact ->> 'fileSize')::bigint = produced_artifact.file_size
  ) then
    raise exception 'Storyboard artifact revision does not match the frozen worker result' using errcode = '22023';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_revision
  from public.review_packages
  where episode_id = new.episode_id and stage = 'storyboard_review';

  insert into public.review_packages (
    episode_id, task_id, task_run_id, artifact_id, stage, revision_number, context_snapshot
  ) values (
    new.episode_id,
    new.id,
    completed_run.id,
    produced_artifact.id,
    'storyboard_review',
    next_revision,
    new.input_snapshot || jsonb_build_object(
      'task_package', completed_run.task_package,
      'worker_result', completed_run.result,
      'artifact', jsonb_build_object(
        'id', produced_artifact.id,
        'relative_path', produced_artifact.relative_path,
        'sha256', produced_artifact.sha256,
        'file_size', produced_artifact.file_size
      )
    )
  ) returning * into created_package;

  update public.episodes set stage = 'storyboard_review', updated_at = now() where id = new.episode_id;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (new.episode_id, 'storyboard_draft', 'storyboard_review', 'Worker submitted a frozen storyboard review package.', null);
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    new.episode_id,
    'storyboard_review_package_created',
    jsonb_build_object('review_package_id', created_package.id, 'task_id', new.id, 'artifact_id', produced_artifact.id, 'revision_number', next_revision),
    null
  );
  return new;
end;
$$;

create trigger create_storyboard_review_package_after_task_completion
after update of status on public.tasks
for each row execute function public.create_storyboard_review_package();

create function public.create_storyboard_revision_task_after_changes_requested()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_package public.review_packages;
  previous_task public.tasks;
  created_task public.tasks;
  annotations jsonb;
begin
  if new.stage <> 'storyboard_review' or new.decision <> 'changes_requested' then
    return new;
  end if;
  select * into previous_package
  from public.review_packages
  where id = new.review_package_id and episode_id = new.episode_id and stage = 'storyboard_review';
  if not found then
    raise exception 'Storyboard review package is required before requesting changes' using errcode = '22023';
  end if;
  select * into previous_task from public.tasks where id = previous_package.task_id;
  select coalesce(jsonb_agg(jsonb_build_object('shot_id', annotation.shot_id, 'reason', annotation.reason) order by annotation.created_at, annotation.id), '[]'::jsonb)
  into annotations
  from public.review_annotations annotation
  where annotation.review_package_id = previous_package.id;

  insert into public.tasks (
    episode_id, task_type, status, input_snapshot, budget_limit_cents,
    max_attempts, provider, model, prompt_version
  ) values (
    previous_task.episode_id,
    'draft_storyboard',
    'ready',
    jsonb_set(
      previous_task.input_snapshot || jsonb_build_object(
        'review_feedback', jsonb_build_object(
          'review_package_id', previous_package.id,
          'reason', new.reason,
          'actor_id', new.actor_id
        ),
        'review_annotations', annotations
      ),
      '{output,relative_path}',
      to_jsonb(format('episodes/%s/storyboard-v%s.json', new.episode_id, previous_package.revision_number + 1))
    ),
    previous_task.budget_limit_cents,
    previous_task.max_attempts,
    previous_task.provider,
    previous_task.model,
    previous_task.prompt_version
  ) returning * into created_task;

  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  select
    episode.account_id,
    episode.id,
    'storyboard_revision_task_created',
    jsonb_build_object('task_id', created_task.id, 'review_package_id', previous_package.id, 'reason', new.reason, 'annotation_count', jsonb_array_length(annotations)),
    new.actor_id
  from public.episodes episode where episode.id = new.episode_id;
  return new;
end;
$$;

create trigger create_storyboard_revision_task_after_changes_requested
after insert on public.approvals
for each row execute function public.create_storyboard_revision_task_after_changes_requested();

create or replace function public.link_review_package_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  review_stage public.episode_stage;
begin
  review_stage := case
    when new.stage in ('script_review', 'script_approved') then 'script_review'::public.episode_stage
    when new.stage in ('visual_review', 'visual_approved') then 'visual_review'::public.episode_stage
    when new.stage in ('storyboard_review', 'storyboard_approved') then 'storyboard_review'::public.episode_stage
    else null
  end;
  if review_stage is null then
    return new;
  end if;
  select review_package.id into new.review_package_id
  from public.review_packages review_package
  where review_package.episode_id = new.episode_id and review_package.stage = review_stage
  order by review_package.revision_number desc
  limit 1;
  if new.review_package_id is null then
    raise exception 'Review approval requires a review package' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke execute on function public.create_storyboard_annotation(uuid, text, text) from public, anon;
grant execute on function public.create_storyboard_annotation(uuid, text, text) to authenticated;
revoke execute on function public.freeze_worker_task_run() from public, anon, authenticated;
revoke execute on function public.orchestrate_storyboard_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_storyboard_tasks() to service_role;
revoke execute on function public.create_storyboard_review_package() from public, anon, authenticated;
revoke execute on function public.create_storyboard_revision_task_after_changes_requested() from public, anon, authenticated;
revoke execute on function public.link_review_package_approval() from public, anon, authenticated;
