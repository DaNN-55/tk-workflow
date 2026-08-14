alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
check (task_type in ('draft_brief', 'draft_script', 'prepare_visual_brief'));

create unique index tasks_one_active_script_draft_idx
on public.tasks (episode_id)
where task_type = 'draft_script' and status in ('ready', 'running');

alter table public.review_packages drop constraint review_packages_stage_check;
alter table public.review_packages add constraint review_packages_stage_check
check (stage in ('script_review', 'visual_review'));

alter table public.production_material_revisions drop constraint production_material_revisions_source_kind_check;
alter table public.production_material_revisions add constraint production_material_revisions_source_kind_check
check (source_kind in ('directory', 'file', 'paste', 'worker'));

update public.account_blueprint_versions
set policy = policy || jsonb_build_object(
  'budgets', case
    when jsonb_typeof(policy -> 'budgets') = 'object' then
      (policy -> 'budgets') || case
        when policy #> '{budgets,script_writing_cents}' is null then jsonb_build_object('script_writing_cents', 0)
        else '{}'::jsonb
      end
    when policy ? 'budgets' then policy -> 'budgets'
    else jsonb_build_object('script_writing_cents', 0)
  end,
  'executors', case
    when jsonb_typeof(policy -> 'executors') = 'object' then
      (policy -> 'executors') || case
        when policy #> '{executors,script_writing}' is null then jsonb_build_object(
          'script_writing', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.6-codex', 'prompt_version', 'script-writing-v1')
        )
        else '{}'::jsonb
      end
    when policy ? 'executors' then policy -> 'executors'
    else jsonb_build_object(
      'script_writing', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.6-codex', 'prompt_version', 'script-writing-v1')
    )
  end
);

create function public.commission_script(
  p_episode_id uuid,
  p_creative_direction text,
  p_core_content text
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_episode public.episodes;
  blueprint_policy jsonb;
  allowed_tools jsonb;
  budget_limit integer;
  executor_model text;
  prompt_version text;
  created_task public.tasks;
begin
  if coalesce(btrim(p_creative_direction), '') = '' or coalesce(btrim(p_core_content), '') = '' then
    raise exception 'Creative direction and core content are required' using errcode = '22023';
  end if;

  select episode.* into current_episode
  from public.episodes episode
  join public.account_memberships membership on membership.account_id = episode.account_id
  where episode.id = p_episode_id and membership.user_id = auth.uid() and membership.role = 'owner'
  for update of episode;
  if not found then
    raise exception 'Owner membership is required to commission a script' using errcode = '42501';
  end if;
  if current_episode.stage <> 'waiting_input' or current_episode.main_script_revision_id is not null then
    raise exception 'Only an episode waiting for its main script can commission script writing' using errcode = '22023';
  end if;
  if exists (select 1 from public.tasks where episode_id = p_episode_id and task_type = 'draft_script') then
    raise exception 'A script commission already exists for this episode' using errcode = '22023';
  end if;

  select policy into blueprint_policy from public.account_blueprint_versions where id = current_episode.blueprint_version_id;
  if jsonb_typeof(blueprint_policy -> 'allowed_tools') <> 'array'
    or jsonb_array_length(blueprint_policy -> 'allowed_tools') = 0
    or exists (
      select 1 from jsonb_array_elements(blueprint_policy -> 'allowed_tools') tool
      where jsonb_typeof(tool) <> 'string' or coalesce(btrim(tool #>> '{}'), '') = ''
    ) then
    raise exception 'Blueprint % has invalid allowed_tools', current_episode.blueprint_version_id using errcode = '22023';
  end if;
  if jsonb_typeof(blueprint_policy #> '{budgets,script_writing_cents}') <> 'number'
    or blueprint_policy #>> '{budgets,script_writing_cents}' !~ '^[0-9]+$' then
    raise exception 'Blueprint % has invalid script writing budget', current_episode.blueprint_version_id using errcode = '22023';
  end if;
  if blueprint_policy #>> '{executors,script_writing,provider}' <> 'codex'
    or coalesce(btrim(blueprint_policy #>> '{executors,script_writing,model}'), '') = ''
    or coalesce(btrim(blueprint_policy #>> '{executors,script_writing,prompt_version}'), '') = '' then
    raise exception 'Blueprint % has invalid script writing executor', current_episode.blueprint_version_id using errcode = '22023';
  end if;

  allowed_tools := blueprint_policy -> 'allowed_tools';
  budget_limit := (blueprint_policy #>> '{budgets,script_writing_cents}')::integer;
  executor_model := blueprint_policy #>> '{executors,script_writing,model}';
  prompt_version := blueprint_policy #>> '{executors,script_writing,prompt_version}';

  insert into public.tasks (
    episode_id, task_type, status, input_snapshot, budget_limit_cents,
    max_attempts, provider, model, prompt_version
  ) values (
    current_episode.id,
    'draft_script',
    'ready',
    jsonb_build_object(
      'capability', 'script_writing',
      'commission', jsonb_build_object(
        'creative_direction', btrim(p_creative_direction),
        'core_content', btrim(p_core_content)
      ),
      'executor', jsonb_build_object(
        'provider', 'codex',
        'model', executor_model,
        'prompt_version', prompt_version
      ),
      'budget', jsonb_build_object('limit_cents', budget_limit, 'max_attempts', 2),
      'allowed_tools', allowed_tools,
      'output', jsonb_build_object(
        'required_artifact_types', jsonb_build_array('script'),
        'content_type', 'text/markdown',
        'relative_path', format('episodes/%s/generated-script-v1.md', current_episode.id),
        'review_stage', 'script_review'
      ),
      'input_artifacts', '[]'::jsonb
    ),
    budget_limit,
    2,
    'codex',
    executor_model,
    prompt_version
  ) returning * into created_task;

  update public.episodes set stage = 'script_draft', updated_at = now() where id = current_episode.id;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (current_episode.id, 'waiting_input', 'script_draft', 'Owner froze creative direction and core content for script writing.', auth.uid());
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    current_episode.id,
    'script_commissioned',
    jsonb_build_object('task_id', created_task.id, 'creative_direction', btrim(p_creative_direction), 'core_content', btrim(p_core_content)),
    auth.uid()
  );
  return created_task;
end;
$$;

drop trigger freeze_provided_script_task_run_before_insert on public.task_runs;
drop function public.freeze_provided_script_task_run();

create function public.freeze_worker_task_run()
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
  if selected_task.task_type not in ('draft_script', 'prepare_visual_brief') then
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
    'script_revision', selected_task.input_snapshot -> 'script_revision',
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

create trigger freeze_worker_task_run_before_insert
before insert on public.task_runs
for each row execute function public.freeze_worker_task_run();

create function public.create_script_review_package()
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
  if new.task_type <> 'draft_script' or new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select * into current_episode from public.episodes where id = new.episode_id for update;
  if current_episode.stage <> 'script_draft' then
    raise exception 'Script writing task can only complete from script_draft' using errcode = '22023';
  end if;
  select * into completed_run
  from public.task_runs
  where task_id = new.id and attempt = new.attempt - 1 and status = 'completed';
  if not found then
    raise exception 'Completed script writing task run is missing' using errcode = '22023';
  end if;
  select * into produced_artifact
  from public.artifacts
  where producer_task_id = new.id
    and artifact_type = 'script'
    and relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then
    raise exception 'Script writing task is missing its frozen script artifact revision' using errcode = '22023';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(completed_run.result -> 'artifacts') result_artifact
    where result_artifact ->> 'artifactType' = produced_artifact.artifact_type
      and result_artifact ->> 'relativePath' = produced_artifact.relative_path
      and result_artifact ->> 'sha256' = produced_artifact.sha256
      and (result_artifact ->> 'fileSize')::bigint = produced_artifact.file_size
  ) then
    raise exception 'Script artifact revision does not match the frozen worker result' using errcode = '22023';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_revision
  from public.review_packages
  where episode_id = new.episode_id and stage = 'script_review';

  insert into public.review_packages (
    episode_id, task_id, task_run_id, artifact_id, stage, revision_number, context_snapshot
  ) values (
    new.episode_id,
    new.id,
    completed_run.id,
    produced_artifact.id,
    'script_review',
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

  update public.episodes set stage = 'script_review', updated_at = now() where id = new.episode_id;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (new.episode_id, 'script_draft', 'script_review', 'Worker submitted a frozen script review package.', null);
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    new.episode_id,
    'script_review_package_created',
    jsonb_build_object('review_package_id', created_package.id, 'task_id', new.id, 'artifact_id', produced_artifact.id, 'revision_number', next_revision),
    null
  );
  return new;
end;
$$;

create trigger create_script_review_package_after_task_completion
after update of status on public.tasks
for each row execute function public.create_script_review_package();

create function public.create_script_revision_task_after_changes_requested()
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
  if new.stage <> 'script_review' or new.decision <> 'changes_requested' then
    return new;
  end if;
  select * into previous_package
  from public.review_packages
  where episode_id = new.episode_id and stage = 'script_review'
  order by revision_number desc
  limit 1;
  if not found then
    raise exception 'Script review package is required before requesting changes' using errcode = '22023';
  end if;
  select * into previous_task from public.tasks where id = previous_package.task_id;

  insert into public.tasks (
    episode_id, task_type, status, input_snapshot, budget_limit_cents,
    max_attempts, provider, model, prompt_version
  ) values (
    previous_task.episode_id,
    'draft_script',
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
      to_jsonb(format('episodes/%s/generated-script-v%s.md', new.episode_id, previous_package.revision_number + 1))
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
    'script_revision_task_created',
    jsonb_build_object('task_id', created_task.id, 'review_package_id', previous_package.id, 'reason', new.reason),
    new.actor_id
  from public.episodes episode where episode.id = new.episode_id;
  return new;
end;
$$;

create trigger create_script_revision_task_after_changes_requested
after insert on public.approvals
for each row execute function public.create_script_revision_task_after_changes_requested();

drop trigger link_visual_review_approval_before_insert on public.approvals;
drop function public.link_visual_review_approval();

create function public.link_review_package_approval()
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

create trigger link_review_package_approval_before_insert
before insert on public.approvals
for each row execute function public.link_review_package_approval();

create function public.materialize_approved_script_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  approved_package public.review_packages;
  approved_artifact public.artifacts;
  current_episode public.episodes;
  next_revision integer;
  created_revision public.production_material_revisions;
begin
  if new.stage <> 'script_approved' or new.decision <> 'approved' then
    return new;
  end if;
  select * into current_episode from public.episodes where id = new.episode_id for update;
  if current_episode.stage <> 'script_approved' or current_episode.main_script_revision_id is not null then
    raise exception 'Approved generated script requires an episode without a main script revision' using errcode = '22023';
  end if;
  select * into approved_package from public.review_packages
  where id = new.review_package_id and episode_id = new.episode_id and stage = 'script_review';
  if not found then
    raise exception 'Approved generated script requires its script review package' using errcode = '22023';
  end if;
  select * into approved_artifact from public.artifacts
  where id = approved_package.artifact_id and episode_id = new.episode_id and artifact_type = 'script';
  if not found then
    raise exception 'Approved generated script artifact is missing' using errcode = '22023';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_revision
  from public.production_material_revisions
  where episode_id = new.episode_id and material_type = 'script';

  insert into public.production_material_revisions (
    episode_id, revision_number, material_type, source_kind, source_path, storage_path,
    mime_type, sha256, file_size, is_main_script, created_by
  ) values (
    new.episode_id,
    next_revision,
    'script',
    'worker',
    format('task:%s', approved_package.task_id),
    approved_artifact.relative_path,
    'text/markdown',
    approved_artifact.sha256,
    approved_artifact.file_size,
    true,
    new.actor_id
  ) returning * into created_revision;

  update public.episodes
  set main_script_revision_id = created_revision.id, updated_at = now()
  where id = new.episode_id;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    new.episode_id,
    'generated_script_approved',
    jsonb_build_object('review_package_id', approved_package.id, 'material_revision_id', created_revision.id, 'artifact_id', approved_artifact.id),
    new.actor_id
  );
  return new;
end;
$$;

create trigger materialize_approved_script_revision_after_approval
after insert on public.approvals
for each row execute function public.materialize_approved_script_revision();

revoke execute on function public.commission_script(uuid, text, text) from public, anon;
grant execute on function public.commission_script(uuid, text, text) to authenticated;
revoke execute on function public.freeze_worker_task_run() from public, anon, authenticated;
revoke execute on function public.create_script_review_package() from public, anon, authenticated;
revoke execute on function public.create_script_revision_task_after_changes_requested() from public, anon, authenticated;
revoke execute on function public.link_review_package_approval() from public, anon, authenticated;
revoke execute on function public.materialize_approved_script_revision() from public, anon, authenticated;
