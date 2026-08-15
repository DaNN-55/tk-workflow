create or replace function public.orchestrate_review_render_tasks(p_episode_id uuid default null)
returns setof public.tasks
language plpgsql security definer set search_path = ''
as $$
declare candidate record; created_task public.tasks; next_revision integer; members jsonb; inputs jsonb; project_path text; render_path text; latest_task_at timestamptz;
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
    select max(task.created_at) into latest_task_at from public.tasks task where task.episode_id = candidate.episode_id and task.task_type = 'generate_review_render' and task.input_snapshot #>> '{review_render,pre_render_review_package_id}' = candidate.pre_render_review_package_id::text;
    if latest_task_at is not null and not exists (
      select 1 from public.approvals approval where approval.episode_id = candidate.episode_id and approval.stage = 'qc_review' and approval.decision = 'changes_requested' and approval.created_at > latest_task_at
    ) then continue; end if;
    select coalesce(max((task.input_snapshot #>> '{review_render,project_revision}')::integer), 0) + 1 into next_revision from public.tasks task where task.episode_id = candidate.episode_id and task.task_type = 'generate_review_render' and task.input_snapshot #>> '{review_render,pre_render_review_package_id}' = candidate.pre_render_review_package_id::text;
    select coalesce(jsonb_agg(jsonb_build_object('member_key',member.member_key,'member_kind',member.member_kind,'relative_path',coalesce(member.evidence_snapshot #>> '{artifact,relative_path}',member.evidence_snapshot #>> '{audio_track,relative_path}'),'sha256',coalesce(member.evidence_snapshot #>> '{artifact,sha256}',member.evidence_snapshot #>> '{audio_track,sha256}'),'start_seconds',coalesce((member.evidence_snapshot #>> '{audio_track,start_seconds}')::numeric,0),'duration_seconds',coalesce((member.evidence_snapshot #>> '{audio_track,duration_seconds}')::numeric,(member.evidence_snapshot #>> '{shot,durationSeconds}')::numeric)) order by member.member_key),'[]'::jsonb),coalesce(jsonb_agg(jsonb_build_object('artifactType',case when member.artifact_id is null then 'audio_track' else member.evidence_snapshot #>> '{artifact,artifact_type}' end,'relativePath',coalesce(member.evidence_snapshot #>> '{artifact,relative_path}',member.evidence_snapshot #>> '{audio_track,relative_path}'),'sha256',coalesce(member.evidence_snapshot #>> '{artifact,sha256}',member.evidence_snapshot #>> '{audio_track,sha256}'),'fileSize',coalesce((member.evidence_snapshot #>> '{artifact,file_size}')::bigint,(member.evidence_snapshot #>> '{audio_track,file_size}')::bigint)) order by member.member_key),'[]'::jsonb) into members,inputs
    from public.pre_render_review_members member join public.pre_render_review_member_decisions decision on decision.review_package_id=member.review_package_id and decision.member_key=member.member_key and decision.decision='approved' where member.review_package_id=candidate.pre_render_review_package_id;
    if jsonb_array_length(members)=0 or jsonb_array_length(inputs)<>jsonb_array_length(members) then continue; end if;
    project_path:=format('episodes/%s/review-render/v%s/index.html',candidate.episode_id,next_revision); render_path:=format('episodes/%s/review-render/v%s/review-render.mp4',candidate.episode_id,next_revision);
    insert into public.tasks (episode_id,task_type,status,input_snapshot,budget_limit_cents,max_attempts,provider,model,prompt_version) values (candidate.episode_id,'generate_review_render','ready',jsonb_build_object('capability','review_rendering','allowed_tools',jsonb_build_array('read','write'),'review_render',jsonb_build_object('pre_render_review_package_id',candidate.pre_render_review_package_id,'project_revision',next_revision,'project_relative_path',project_path,'storyboard',candidate.context_snapshot->'storyboard','members',members),'input_artifacts',inputs,'output',jsonb_build_object('required_artifact_types',jsonb_build_array('render','review_render_project'),'content_type','video/mp4','relative_path',render_path,'review_stage','qc_review')),0,1,'hyperframes','hyperframes@0.7.109','review-render-v1') returning * into created_task;
    return next created_task;
  end loop;
end;
$$;

revoke all on function public.orchestrate_review_render_tasks(uuid) from public, anon, authenticated;
grant execute on function public.orchestrate_review_render_tasks(uuid) to service_role;
