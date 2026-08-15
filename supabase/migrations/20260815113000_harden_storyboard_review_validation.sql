create table public.storyboard_review_shots (
  review_package_id uuid not null references public.review_packages(id) on delete cascade,
  shot_id text not null check (char_length(btrim(shot_id)) > 0),
  primary key (review_package_id, shot_id)
);

alter table public.storyboard_review_shots enable row level security;
revoke all on public.storyboard_review_shots from anon, authenticated;

create or replace function public.create_storyboard_annotation(
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
  if not exists (
    select 1 from public.storyboard_review_shots shot
    where shot.review_package_id = p_review_package_id and shot.shot_id = btrim(p_shot_id)
  ) then
    raise exception 'Storyboard annotation shot does not exist in this frozen revision' using errcode = '22023';
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

create or replace function public.create_storyboard_review_package()
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
  storyboard_shot jsonb;
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
  if jsonb_typeof(completed_run.result -> 'storyboard') <> 'object'
    or completed_run.result #>> '{storyboard,version}' <> 'storyboard/v1' then
    raise exception 'Storyboard planning task has invalid storyboard content' using errcode = '22023';
  end if;
  if jsonb_typeof(completed_run.result #> '{storyboard,shots}') <> 'array'
    or jsonb_array_length(completed_run.result #> '{storyboard,shots}') = 0 then
    raise exception 'Storyboard planning task has no reviewable shots' using errcode = '22023';
  end if;
  if exists (
    select 1
    from (
      select shot ->> 'id' as shot_id
      from jsonb_array_elements(completed_run.result #> '{storyboard,shots}') shot
    ) shot_ids
    group by shot_id
    having count(*) > 1
  ) then
    raise exception 'Storyboard planning task has duplicate shot IDs' using errcode = '22023';
  end if;
  for storyboard_shot in select value from jsonb_array_elements(completed_run.result #> '{storyboard,shots}')
  loop
    if jsonb_typeof(storyboard_shot) <> 'object'
      or coalesce(btrim(storyboard_shot ->> 'id'), '') = ''
      or coalesce(btrim(storyboard_shot ->> 'scriptSegment'), '') = ''
      or coalesce(btrim(storyboard_shot ->> 'productionMethod'), '') = ''
      or coalesce(btrim(storyboard_shot ->> 'targetSpec'), '') = ''
      or jsonb_typeof(storyboard_shot -> 'durationSeconds') <> 'number'
      or (storyboard_shot ->> 'durationSeconds')::numeric <= 0
      or storyboard_shot ->> 'shotType' not in ('a_roll', 'b_roll')
      or jsonb_typeof(storyboard_shot -> 'inputBasis') <> 'array'
      or jsonb_array_length(storyboard_shot -> 'inputBasis') = 0 then
      raise exception 'Storyboard planning task has an invalid shot' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis
      where jsonb_typeof(input_basis) <> 'object'
        or coalesce(btrim(input_basis ->> 'relativePath'), '') = ''
        or input_basis ->> 'sha256' !~ '^[0-9a-f]{64}$'
        or not exists (
          select 1 from jsonb_array_elements(new.input_snapshot -> 'input_artifacts') frozen_input
          where frozen_input ->> 'relativePath' = input_basis ->> 'relativePath'
            and frozen_input ->> 'sha256' = input_basis ->> 'sha256'
        )
    ) then
      raise exception 'Storyboard planning task references a non-frozen input' using errcode = '22023';
    end if;
    if not exists (
      select 1
      from jsonb_array_elements(new.input_snapshot -> 'input_artifacts') frozen_input
      join jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis
        on input_basis ->> 'relativePath' = frozen_input ->> 'relativePath'
       and input_basis ->> 'sha256' = frozen_input ->> 'sha256'
      where frozen_input ->> 'artifactType' = 'main_script'
    ) then
      raise exception 'Storyboard shot must trace to the frozen main script' using errcode = '22023';
    end if;
    if not exists (
      select 1
      from jsonb_array_elements(new.input_snapshot -> 'input_artifacts') frozen_input
      join jsonb_array_elements(storyboard_shot -> 'inputBasis') input_basis
        on input_basis ->> 'relativePath' = frozen_input ->> 'relativePath'
       and input_basis ->> 'sha256' = frozen_input ->> 'sha256'
      where frozen_input ->> 'artifactType' <> 'main_script'
    ) then
      raise exception 'Storyboard shot must trace to approved visual inputs' using errcode = '22023';
    end if;
  end loop;

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

  insert into public.storyboard_review_shots (review_package_id, shot_id)
  select created_package.id, btrim(shot ->> 'id')
  from jsonb_array_elements(completed_run.result #> '{storyboard,shots}') shot;

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

revoke execute on function public.create_storyboard_annotation(uuid, text, text) from public, anon;
grant execute on function public.create_storyboard_annotation(uuid, text, text) to authenticated;
revoke execute on function public.create_storyboard_review_package() from public, anon, authenticated;
