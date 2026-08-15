create or replace function public.request_review_render_revision(
  p_review_package_id uuid,
  p_caption_style text,
  p_pacing text,
  p_crop text,
  p_transition text,
  p_layout text,
  p_reason text
)
returns public.episodes
language plpgsql security definer set search_path = ''
as $$
declare
  selected_package public.review_packages;
  selected_episode public.episodes;
  membership_role public.member_role;
  next_revision integer;
begin
  if p_caption_style not in ('cinematic', 'minimal')
    or p_pacing not in ('gentle', 'standard', 'compact')
    or p_crop not in ('cover', 'contain')
    or p_transition not in ('fade', 'cut')
    or p_layout not in ('lower_third', 'center')
    or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Invalid review render composition adjustment' using errcode = '22023';
  end if;

  select package.* into selected_package from public.review_packages package
  where package.id = p_review_package_id and package.stage = 'qc_review' and package.invalidated_at is null
    and package.context_snapshot ->> 'review_kind' = 'hyperframes_review_render';
  if not found then raise exception 'Current HyperFrames review package is required' using errcode = '22023'; end if;
  select * into selected_episode from public.episodes where id = selected_package.episode_id for update;
  if selected_episode.stage <> 'qc_review' or exists (
    select 1 from public.review_packages package where package.episode_id = selected_episode.id and package.stage = 'qc_review'
      and package.invalidated_at is null and package.revision_number > selected_package.revision_number
  ) then raise exception 'Review render package is no longer current' using errcode = '22023'; end if;
  select role into membership_role from public.account_memberships where account_id = selected_episode.account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then raise exception 'Owner membership is required to adjust a review render' using errcode = '42501'; end if;

  select greatest(
    coalesce((select max(revision_number) from public.review_render_composition_revisions where pre_render_review_package_id = (selected_package.context_snapshot ->> 'pre_render_review_package_id')::uuid), 0),
    coalesce((select max((task.input_snapshot #>> '{review_render,project_revision}')::integer) from public.tasks task where task.episode_id = selected_episode.id and task.task_type = 'generate_review_render' and task.input_snapshot #>> '{review_render,pre_render_review_package_id}' = selected_package.context_snapshot ->> 'pre_render_review_package_id'), 0)
  ) + 1 into next_revision;
  insert into public.review_render_composition_revisions (episode_id, pre_render_review_package_id, revision_number, caption_style, pacing, crop, transition, layout, reason, created_by)
  values (selected_episode.id, (selected_package.context_snapshot ->> 'pre_render_review_package_id')::uuid, next_revision, p_caption_style, p_pacing, p_crop, p_transition, p_layout, btrim(p_reason), auth.uid());

  update public.episodes set stage = 'render_ready', updated_at = now() where id = selected_episode.id returning * into selected_episode;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id) values (selected_episode.id, 'qc_review', 'render_ready', btrim(p_reason), auth.uid());
  insert into public.approvals (episode_id, stage, decision, reason, actor_id, review_package_id) values (selected_episode.id, 'qc_review', 'changes_requested', btrim(p_reason), auth.uid(), selected_package.id);
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (selected_episode.account_id, selected_episode.id, 'review_render_composition_requested', jsonb_build_object('review_package_id', p_review_package_id, 'revision_number', next_revision, 'caption_style', p_caption_style, 'pacing', p_pacing, 'crop', p_crop, 'transition', p_transition, 'layout', p_layout), auth.uid());
  return selected_episode;
end;
$$;

create or replace function public.orchestrate_review_render_tasks(p_episode_id uuid default null)
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare candidate record; created_task public.tasks; members jsonb; inputs jsonb; composition public.review_render_composition_revisions; project_path text; render_path text; default_revision integer;
begin
  for candidate in
    select episode.id as episode_id, package.id as pre_render_review_package_id, package.context_snapshot
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
    select coalesce(max((task.input_snapshot #>> '{review_render,project_revision}')::integer), 0) + 1 into default_revision
    from public.tasks task where task.episode_id = candidate.episode_id and task.task_type = 'generate_review_render'
      and task.input_snapshot #>> '{review_render,pre_render_review_package_id}' = candidate.pre_render_review_package_id::text;
    insert into public.review_render_composition_revisions (episode_id, pre_render_review_package_id, revision_number, caption_style, pacing, crop, transition, layout, reason)
    values (candidate.episode_id, candidate.pre_render_review_package_id, default_revision, 'cinematic', 'standard', 'cover', 'fade', 'lower_third', '默认合成配置。')
    on conflict (pre_render_review_package_id, revision_number) do nothing;
    select * into composition from public.review_render_composition_revisions where pre_render_review_package_id = candidate.pre_render_review_package_id order by revision_number desc limit 1;
    if exists (select 1 from public.tasks task where task.episode_id = candidate.episode_id and task.task_type = 'generate_review_render' and task.input_snapshot #>> '{review_render,composition_revision_id}' = composition.id::text) then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('member_key', member.member_key, 'member_kind', member.member_kind, 'relative_path', coalesce(member.evidence_snapshot #>> '{artifact,relative_path}', member.evidence_snapshot #>> '{audio_track,relative_path}'), 'sha256', coalesce(member.evidence_snapshot #>> '{artifact,sha256}', member.evidence_snapshot #>> '{audio_track,sha256}'), 'start_seconds', coalesce((member.evidence_snapshot #>> '{audio_track,start_seconds}')::numeric, 0), 'duration_seconds', coalesce((member.evidence_snapshot #>> '{audio_track,duration_seconds}')::numeric, (member.evidence_snapshot #>> '{shot,durationSeconds}')::numeric)) order by member.member_key), '[]'::jsonb), coalesce(jsonb_agg(jsonb_build_object('artifactType', case when member.artifact_id is null then 'audio_track' else member.evidence_snapshot #>> '{artifact,artifact_type}' end, 'relativePath', coalesce(member.evidence_snapshot #>> '{artifact,relative_path}', member.evidence_snapshot #>> '{audio_track,relative_path}'), 'sha256', coalesce(member.evidence_snapshot #>> '{artifact,sha256}', member.evidence_snapshot #>> '{audio_track,sha256}'), 'fileSize', coalesce((member.evidence_snapshot #>> '{artifact,file_size}')::bigint, (member.evidence_snapshot #>> '{audio_track,file_size}')::bigint)) order by member.member_key), '[]'::jsonb) into members, inputs
    from public.pre_render_review_members member join public.pre_render_review_member_decisions decision on decision.review_package_id = member.review_package_id and decision.member_key = member.member_key and decision.decision = 'approved'
    where member.review_package_id = candidate.pre_render_review_package_id;
    if jsonb_array_length(members) = 0 or jsonb_array_length(inputs) <> jsonb_array_length(members) then continue; end if;
    project_path := format('episodes/%s/review-render/v%s/index.html', candidate.episode_id, composition.revision_number);
    render_path := format('episodes/%s/review-render/v%s/review-render.mp4', candidate.episode_id, composition.revision_number);
    insert into public.tasks (episode_id, task_type, status, input_snapshot, budget_limit_cents, max_attempts, provider, model, prompt_version)
    values (candidate.episode_id, 'generate_review_render', 'ready', jsonb_build_object('capability', 'review_rendering', 'allowed_tools', jsonb_build_array('read', 'write'), 'review_render', jsonb_build_object('pre_render_review_package_id', candidate.pre_render_review_package_id, 'composition_revision_id', composition.id, 'project_revision', composition.revision_number, 'project_relative_path', project_path, 'storyboard', candidate.context_snapshot -> 'storyboard', 'members', members, 'adjustments', jsonb_build_object('caption_style', composition.caption_style, 'pacing', composition.pacing, 'crop', composition.crop, 'transition', composition.transition, 'layout', composition.layout, 'reason', composition.reason)), 'input_artifacts', inputs, 'output', jsonb_build_object('required_artifact_types', jsonb_build_array('render', 'review_render_project'), 'content_type', 'video/mp4', 'relative_path', render_path, 'review_stage', 'qc_review')), 0, 1, 'hyperframes', 'hyperframes@0.7.109', 'review-render-v1') returning * into created_task;
    return next created_task;
  end loop;
end;
$$;

revoke all on function public.request_review_render_revision(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_review_render_revision(uuid, text, text, text, text, text, text) to authenticated;
revoke all on function public.orchestrate_review_render_tasks(uuid) from public, anon, authenticated;
grant execute on function public.orchestrate_review_render_tasks(uuid) to service_role;
