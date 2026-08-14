alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
check (task_type in ('draft_brief', 'prepare_visual_brief'));

create unique index tasks_one_active_visual_brief_idx
on public.tasks (episode_id)
where task_type = 'prepare_visual_brief' and status in ('ready', 'running');

create table public.review_packages (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete restrict,
  task_run_id uuid not null references public.task_runs(id) on delete restrict,
  artifact_id uuid not null references public.artifacts(id) on delete restrict,
  stage public.episode_stage not null check (stage = 'visual_review'),
  revision_number integer not null check (revision_number > 0),
  context_snapshot jsonb not null check (jsonb_typeof(context_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (episode_id, stage, revision_number),
  unique (task_run_id)
);

create index review_packages_episode_created_idx on public.review_packages (episode_id, created_at desc);

alter table public.approvals
add column review_package_id uuid references public.review_packages(id) on delete restrict;

create unique index approvals_review_package_idx
on public.approvals (review_package_id)
where review_package_id is not null;

alter table public.review_packages enable row level security;
create policy "members can read review packages" on public.review_packages
for select to authenticated
using (
  exists (
    select 1 from public.episodes
    where episodes.id = review_packages.episode_id
      and public.is_account_member(episodes.account_id)
  )
);

revoke all on public.review_packages from anon, authenticated;
grant select on public.review_packages to authenticated;

update public.account_blueprint_versions
set policy = policy || jsonb_build_object(
  'allowed_tools', case
    when policy ? 'allowed_tools' then policy -> 'allowed_tools'
    else jsonb_build_array('read', 'write')
  end,
  'budgets', case
    when jsonb_typeof(policy -> 'budgets') = 'object' then
      (policy -> 'budgets') || case
        when policy #> '{budgets,visual_planning_cents}' is null then jsonb_build_object('visual_planning_cents', 0)
        else '{}'::jsonb
      end
    when policy ? 'budgets' then policy -> 'budgets'
    else jsonb_build_object('visual_planning_cents', 0)
  end,
  'executors', case
    when jsonb_typeof(policy -> 'executors') = 'object' then
      (policy -> 'executors') || case
        when policy #> '{executors,visual_planning}' is null then jsonb_build_object(
          'visual_planning', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.6-codex', 'prompt_version', 'visual-planning-v1')
        )
        else '{}'::jsonb
      end
    when policy ? 'executors' then policy -> 'executors'
    else jsonb_build_object(
      'visual_planning', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.6-codex', 'prompt_version', 'visual-planning-v1')
    )
  end
);

create function public.orchestrate_provided_script_tasks()
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
      script_revision.mime_type as script_mime_type
    from public.episodes episode
    join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id
    join public.production_material_revisions script_revision
      on script_revision.id = episode.main_script_revision_id
     and script_revision.episode_id = episode.id
     and script_revision.is_main_script
    where episode.stage = 'script_approved'
      and not exists (
        select 1 from public.tasks task
        where task.episode_id = episode.id and task.task_type = 'prepare_visual_brief'
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
    if jsonb_typeof(candidate.policy #> '{budgets,visual_planning_cents}') <> 'number'
      or candidate.policy #>> '{budgets,visual_planning_cents}' !~ '^[0-9]+$' then
      raise exception 'Blueprint % has invalid visual planning budget', candidate.blueprint_version_id using errcode = '22023';
    end if;
    if candidate.policy #>> '{executors,visual_planning,provider}' <> 'codex'
      or coalesce(btrim(candidate.policy #>> '{executors,visual_planning,model}'), '') = ''
      or coalesce(btrim(candidate.policy #>> '{executors,visual_planning,prompt_version}'), '') = '' then
      raise exception 'Blueprint % has invalid visual planning executor', candidate.blueprint_version_id using errcode = '22023';
    end if;

    allowed_tools := candidate.policy -> 'allowed_tools';
    budget_limit := (candidate.policy #>> '{budgets,visual_planning_cents}')::integer;
    executor_model := candidate.policy #>> '{executors,visual_planning,model}';
    prompt_version := candidate.policy #>> '{executors,visual_planning,prompt_version}';

    insert into public.tasks (
      episode_id, task_type, status, input_snapshot, budget_limit_cents,
      max_attempts, provider, model, prompt_version
    ) values (
      candidate.id,
      'prepare_visual_brief',
      'ready',
      jsonb_build_object(
        'capability', 'visual_planning',
        'script_revision', jsonb_build_object(
          'id', candidate.script_revision_id,
          'storage_path', candidate.script_storage_path,
          'sha256', candidate.script_sha256,
          'file_size', candidate.script_file_size,
          'mime_type', candidate.script_mime_type
        ),
        'executor', jsonb_build_object(
          'provider', 'codex',
          'model', executor_model,
          'prompt_version', prompt_version
        ),
        'budget', jsonb_build_object('limit_cents', budget_limit, 'max_attempts', 2),
        'allowed_tools', allowed_tools,
        'output', jsonb_build_object(
          'required_artifact_types', jsonb_build_array('visual_brief'),
          'content_type', 'text/markdown',
          'relative_path', format('episodes/%s/visual-brief-v1.md', candidate.id),
          'review_stage', 'visual_review'
        ),
        'input_artifacts', jsonb_build_array(jsonb_build_object(
          'artifactType', 'main_script',
          'relativePath', candidate.script_storage_path,
          'sha256', candidate.script_sha256,
          'fileSize', candidate.script_file_size
        ))
      ),
      budget_limit,
      2,
      'codex',
      executor_model,
      prompt_version
    ) returning * into created_task;

    update public.episodes set stage = 'visual_draft', updated_at = now() where id = candidate.id;
    insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
    values (candidate.id, 'script_approved', 'visual_draft', 'Orchestrator froze the first visual planning task from the confirmed main script.', null);
    insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
    values (
      candidate.account_id,
      candidate.id,
      'provided_script_task_created',
      jsonb_build_object('task_id', created_task.id, 'script_revision_id', candidate.script_revision_id),
      null
    );
    return next created_task;
  end loop;
end;
$$;

create function public.freeze_provided_script_task_run()
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
  if selected_task.task_type <> 'prepare_visual_brief' then
    return new;
  end if;
  select * into selected_episode from public.episodes where id = selected_task.episode_id;
  new.task_package := jsonb_build_object(
    'version', 'worker-task/v1',
    'task', jsonb_build_object('id', selected_task.id, 'type', selected_task.task_type, 'attempt', new.attempt),
    'episode', jsonb_build_object(
      'id', selected_episode.id,
      'account_id', selected_episode.account_id,
      'blueprint_version_id', selected_episode.blueprint_version_id,
      'title', selected_episode.title
    ),
    'capability', selected_task.input_snapshot -> 'capability',
    'script_revision', selected_task.input_snapshot -> 'script_revision',
    'executor', selected_task.input_snapshot -> 'executor',
    'budget', (selected_task.input_snapshot -> 'budget') || jsonb_build_object('attempt', new.attempt),
    'allowed_tools', selected_task.input_snapshot -> 'allowed_tools',
    'output', selected_task.input_snapshot -> 'output',
    'input_artifacts', selected_task.input_snapshot -> 'input_artifacts',
    'forbidden_actions', jsonb_build_array('approve', 'publish', 'change_blueprint', 'change_episode_stage')
  );
  return new;
end;
$$;

create trigger freeze_provided_script_task_run_before_insert
before insert on public.task_runs
for each row execute function public.freeze_provided_script_task_run();

create function public.create_visual_review_package()
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
  if new.task_type <> 'prepare_visual_brief' or new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select * into current_episode from public.episodes where id = new.episode_id for update;
  if current_episode.stage <> 'visual_draft' then
    raise exception 'Visual planning task can only complete from visual_draft' using errcode = '22023';
  end if;
  select * into completed_run
  from public.task_runs
  where task_id = new.id and attempt = new.attempt - 1 and status = 'completed';
  if not found then
    raise exception 'Completed visual planning task run is missing' using errcode = '22023';
  end if;
  select * into produced_artifact
  from public.artifacts
  where producer_task_id = new.id
    and artifact_type = 'visual_brief'
    and relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then
    raise exception 'Visual planning task is missing its frozen visual_brief artifact revision' using errcode = '22023';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(completed_run.result -> 'artifacts') result_artifact
    where result_artifact ->> 'artifactType' = produced_artifact.artifact_type
      and result_artifact ->> 'relativePath' = produced_artifact.relative_path
      and result_artifact ->> 'sha256' = produced_artifact.sha256
      and (result_artifact ->> 'fileSize')::bigint = produced_artifact.file_size
  ) then
    raise exception 'Visual planning artifact revision does not match the frozen worker result' using errcode = '22023';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_revision
  from public.review_packages
  where episode_id = new.episode_id and stage = 'visual_review';

  insert into public.review_packages (
    episode_id, task_id, task_run_id, artifact_id, stage, revision_number, context_snapshot
  ) values (
    new.episode_id,
    new.id,
    completed_run.id,
    produced_artifact.id,
    'visual_review',
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

  update public.episodes set stage = 'visual_review', updated_at = now() where id = new.episode_id;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (new.episode_id, 'visual_draft', 'visual_review', 'Worker submitted a frozen visual planning review package.', null);
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    new.episode_id,
    'visual_review_package_created',
    jsonb_build_object(
      'review_package_id', created_package.id,
      'task_id', new.id,
      'artifact_id', produced_artifact.id,
      'revision_number', next_revision
    ),
    null
  );
  return new;
end;
$$;

create trigger create_visual_review_package_after_task_completion
after update of status on public.tasks
for each row execute function public.create_visual_review_package();

create function public.create_visual_revision_task_after_changes_requested()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_package public.review_packages;
  previous_task public.tasks;
  created_task public.tasks;
begin
  if new.stage <> 'visual_review' or new.decision <> 'changes_requested' then
    return new;
  end if;
  select * into previous_package
  from public.review_packages
  where episode_id = new.episode_id and stage = 'visual_review'
  order by revision_number desc
  limit 1;
  if not found then
    raise exception 'Visual review package is required before requesting changes' using errcode = '22023';
  end if;
  select * into previous_task from public.tasks where id = previous_package.task_id;

  insert into public.tasks (
    episode_id, task_type, status, input_snapshot, budget_limit_cents,
    max_attempts, provider, model, prompt_version
  ) values (
    previous_task.episode_id,
    previous_task.task_type,
    'ready',
    jsonb_set(
      previous_task.input_snapshot || jsonb_build_object(
        'review_feedback', jsonb_build_object(
          'review_package_id', previous_package.id,
          'reason', new.reason,
          'actor_id', new.actor_id
        )
      ),
      '{output,relative_path}',
      to_jsonb(format('episodes/%s/visual-brief-v%s.md', new.episode_id, previous_package.revision_number + 1))
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
    'visual_revision_task_created',
    jsonb_build_object('task_id', created_task.id, 'review_package_id', previous_package.id, 'reason', new.reason),
    new.actor_id
  from public.episodes episode where episode.id = new.episode_id;
  return new;
end;
$$;

create trigger create_visual_revision_task_after_changes_requested
after insert on public.approvals
for each row execute function public.create_visual_revision_task_after_changes_requested();

create function public.link_visual_review_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage not in ('visual_review', 'visual_approved') then
    return new;
  end if;
  select review_package.id into new.review_package_id
  from public.review_packages review_package
  where review_package.episode_id = new.episode_id and review_package.stage = 'visual_review'
  order by review_package.revision_number desc
  limit 1;
  if new.review_package_id is null then
    raise exception 'Visual review approval requires a review package' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger link_visual_review_approval_before_insert
before insert on public.approvals
for each row execute function public.link_visual_review_approval();

revoke execute on function public.orchestrate_provided_script_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_provided_script_tasks() to service_role;
revoke execute on function public.freeze_provided_script_task_run() from public, anon, authenticated;
revoke execute on function public.create_visual_review_package() from public, anon, authenticated;
revoke execute on function public.create_visual_revision_task_after_changes_requested() from public, anon, authenticated;
revoke execute on function public.link_visual_review_approval() from public, anon, authenticated;
