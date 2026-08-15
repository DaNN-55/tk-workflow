alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check check (task_type in ('draft_brief', 'draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll', 'generate_b_roll', 'generate_narration', 'extract_embedded_audio', 'generate_soundtrack', 'generate_review_render'));

alter table public.review_packages drop constraint review_packages_stage_check;
alter table public.review_packages add constraint review_packages_stage_check check (stage in ('script_review', 'visual_review', 'storyboard_review', 'production_ready', 'qc_review'));

create function public.orchestrate_review_render_tasks(p_episode_id uuid default null)
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare candidate record; created_task public.tasks; next_revision integer; members jsonb; inputs jsonb; project_path text; render_path text;
begin
  for candidate in
    select episode.id as episode_id, episode.account_id, package.id as pre_render_review_package_id, package.context_snapshot
    from public.episodes episode
    join lateral (
      select package.* from public.review_packages package
      join public.approvals approval on approval.review_package_id = package.id and approval.stage = 'render_ready' and approval.decision = 'approved'
      where package.episode_id = episode.id and package.stage = 'production_ready' and package.invalidated_at is null
      order by package.revision_number desc limit 1
    ) package on true
    where episode.stage = 'render_ready' and (p_episode_id is null or episode.id = p_episode_id)
    order by episode.updated_at, episode.id for update of episode skip locked
  loop
    select coalesce(max((task.input_snapshot #>> '{review_render,project_revision}')::integer), 0) + 1 into next_revision
    from public.tasks task
    where task.episode_id = candidate.episode_id and task.task_type = 'generate_review_render'
      and task.input_snapshot #>> '{review_render,pre_render_review_package_id}' = candidate.pre_render_review_package_id::text;
    if exists (select 1 from public.tasks task where task.episode_id = candidate.episode_id and task.task_type = 'generate_review_render' and task.input_snapshot #>> '{review_render,pre_render_review_package_id}' = candidate.pre_render_review_package_id::text and task.input_snapshot #>> '{review_render,project_revision}' = next_revision::text) then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'member_key', member.member_key, 'member_kind', member.member_kind,
      'relative_path', coalesce(member.evidence_snapshot #>> '{artifact,relative_path}', member.evidence_snapshot #>> '{audio_track,relative_path}'),
      'sha256', coalesce(member.evidence_snapshot #>> '{artifact,sha256}', member.evidence_snapshot #>> '{audio_track,sha256}'),
      'start_seconds', coalesce((member.evidence_snapshot #>> '{audio_track,start_seconds}')::numeric, 0),
      'duration_seconds', coalesce((member.evidence_snapshot #>> '{audio_track,duration_seconds}')::numeric, (member.evidence_snapshot #>> '{shot,durationSeconds}')::numeric)
    ) order by member.member_key), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'artifactType', case when member.artifact_id is null then 'audio_track' else member.evidence_snapshot #>> '{artifact,artifact_type}' end,
      'relativePath', coalesce(member.evidence_snapshot #>> '{artifact,relative_path}', member.evidence_snapshot #>> '{audio_track,relative_path}'),
      'sha256', coalesce(member.evidence_snapshot #>> '{artifact,sha256}', member.evidence_snapshot #>> '{audio_track,sha256}'),
      'fileSize', coalesce((member.evidence_snapshot #>> '{artifact,file_size}')::bigint, (member.evidence_snapshot #>> '{audio_track,file_size}')::bigint)
    ) order by member.member_key), '[]'::jsonb)
    into members, inputs
    from public.pre_render_review_members member
    join public.pre_render_review_member_decisions decision on decision.review_package_id = member.review_package_id and decision.member_key = member.member_key and decision.decision = 'approved'
    where member.review_package_id = candidate.pre_render_review_package_id;
    if jsonb_array_length(members) = 0 or jsonb_array_length(inputs) <> jsonb_array_length(members) then continue; end if;
    project_path := format('episodes/%s/review-render/v%s/index.html', candidate.episode_id, next_revision);
    render_path := format('episodes/%s/review-render/v%s/review-render.mp4', candidate.episode_id, next_revision);
    insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version)
    values (candidate.episode_id, 'generate_review_render', 'ready', jsonb_build_object(
      'capability','review_rendering','allowed_tools',jsonb_build_array('read','write'),
      'review_render',jsonb_build_object('pre_render_review_package_id',candidate.pre_render_review_package_id,'project_revision',next_revision,'project_relative_path',project_path,'storyboard',candidate.context_snapshot -> 'storyboard','members',members),
      'input_artifacts',inputs,
      'output',jsonb_build_object('required_artifact_types',jsonb_build_array('render','review_render_project'),'content_type','video/mp4','relative_path',render_path,'review_stage','qc_review')
    ), 0, 1, 'hyperframes', 'hyperframes@0.7.109', 'review-render-v1') returning * into created_task;
    return next created_task;
  end loop;
end;
$$;

create function public.register_completed_review_render()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare render_artifact public.artifacts; task_run public.task_runs; package public.review_packages; next_revision integer; previous_stage public.episode_stage;
begin
  if new.status <> 'completed' or new.task_type <> 'generate_review_render' or old.status = 'completed' then return new; end if;
  select * into render_artifact from public.artifacts where producer_task_id = new.id and artifact_type = 'render' and relative_path = new.input_snapshot #>> '{output,relative_path}';
  select * into task_run from public.task_runs where task_id = new.id and attempt = new.attempt - 1;
  if not found or render_artifact.id is null then raise exception 'Completed review render is missing frozen evidence' using errcode = '22023'; end if;
  select coalesce(max(revision_number), 0) + 1 into next_revision from public.review_packages where episode_id = new.episode_id and stage = 'qc_review';
  insert into public.review_packages (episode_id,task_id,task_run_id,artifact_id,stage,revision_number,context_snapshot)
  values (new.episode_id,new.id,task_run.id,render_artifact.id,'qc_review',next_revision,jsonb_build_object(
    'review_kind','hyperframes_review_render','pre_render_review_package_id',new.input_snapshot #>> '{review_render,pre_render_review_package_id}',
    'project_revision',new.input_snapshot #>> '{review_render,project_revision}','project_relative_path',new.input_snapshot #>> '{review_render,project_relative_path}',
    'frozen_input_artifacts',new.input_snapshot -> 'input_artifacts','technical_evidence',new.last_result -> 'validation'
  )) returning * into package;
  select stage into previous_stage from public.episodes where id = new.episode_id for update;
  if previous_stage <> 'render_ready' then raise exception 'Review render completed outside render_ready stage' using errcode = '22023'; end if;
  update public.episodes set stage = 'qc_review', updated_at = now() where id = new.episode_id;
  insert into public.state_transitions (episode_id,from_stage,to_stage,reason,actor_id) values (new.episode_id,'render_ready','qc_review','HyperFrames deterministic review render completed.',null);
  insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id)
  select episode.account_id, episode.id, 'review_render_created', jsonb_build_object('review_package_id',package.id,'task_id',new.id,'project_revision',new.input_snapshot #>> '{review_render,project_revision}','pre_render_review_package_id',new.input_snapshot #>> '{review_render,pre_render_review_package_id}'), null from public.episodes episode where episode.id = new.episode_id;
  return new;
end;
$$;

drop trigger if exists register_completed_review_render_after_result on public.tasks;
create trigger register_completed_review_render_after_result after update of status on public.tasks for each row execute function public.register_completed_review_render();

create or replace function public.link_review_package_approval()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare review_stage public.episode_stage;
begin
  review_stage := case
    when new.stage in ('script_review', 'script_approved') then 'script_review'::public.episode_stage
    when new.stage in ('visual_review', 'visual_approved') then 'visual_review'::public.episode_stage
    when new.stage in ('storyboard_review', 'storyboard_approved') then 'storyboard_review'::public.episode_stage
    when new.stage in ('production_ready', 'render_ready') then 'production_ready'::public.episode_stage
    when new.stage in ('qc_review', 'qc_passed') then 'qc_review'::public.episode_stage
    else null
  end;
  if review_stage is null then return new; end if;
  select review_package.id into new.review_package_id from public.review_packages review_package where review_package.episode_id = new.episode_id and review_package.stage = review_stage and review_package.invalidated_at is null order by review_package.revision_number desc limit 1;
  if new.review_package_id is null then raise exception 'Review approval requires a current review package' using errcode = '22023'; end if;
  return new;
end;
$$;

revoke all on function public.orchestrate_review_render_tasks(uuid) from public, anon, authenticated;
grant execute on function public.orchestrate_review_render_tasks(uuid) to service_role;
revoke all on function public.register_completed_review_render() from public, anon, authenticated;
