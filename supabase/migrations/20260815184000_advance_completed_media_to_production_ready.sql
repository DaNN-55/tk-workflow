create function public.advance_production_ready_episodes(p_episode_id uuid default null)
returns setof public.episodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  advanced_episode public.episodes;
begin
  for candidate in
    select
      episode.id,
      episode.account_id,
      package.id as storyboard_review_package_id,
      package.context_snapshot as storyboard_context
    from public.episodes episode
    join lateral (
      select review_package.*
      from public.review_packages review_package
      join public.approvals approval
        on approval.review_package_id = review_package.id
       and approval.stage = 'storyboard_approved'
       and approval.decision = 'approved'
      where review_package.episode_id = episode.id
        and review_package.stage = 'storyboard_review'
        and review_package.invalidated_at is null
      order by review_package.revision_number desc
      limit 1
    ) package on true
    where episode.stage = 'storyboard_approved'
      and (p_episode_id is null or episode.id = p_episode_id)
    order by episode.updated_at, episode.id
    for update of episode skip locked
  loop
    if jsonb_typeof(candidate.storyboard_context #> '{worker_result,storyboard,shots}') <> 'array'
      or jsonb_array_length(candidate.storyboard_context #> '{worker_result,storyboard,shots}') = 0 then
      continue;
    end if;

    if exists (
      select 1
      from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}') shot
      where shot ->> 'shotType' not in ('a_roll', 'b_roll')
         or coalesce(btrim(shot ->> 'id'), '') = ''
         or not exists (
           select 1
           from public.tasks task
           join public.artifacts artifact
             on artifact.producer_task_id = task.id
            and artifact.relative_path = task.input_snapshot #>> '{output,relative_path}'
            and artifact.artifact_type = any (
              array(select jsonb_array_elements_text(task.input_snapshot #> '{output,required_artifact_types}'))
            )
           where task.episode_id = candidate.id
             and task.status = 'completed'
             and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text
             and task.input_snapshot #>> '{shot,id}' = shot ->> 'id'
             and task.task_type = case shot ->> 'shotType' when 'a_roll' then 'generate_a_roll' else 'generate_b_roll' end
         )
    ) then
      continue;
    end if;

    if exists (
      select 1
      from public.production_material_revisions material
      join public.material_revision_approvals approval on approval.material_revision_id = material.id
      where material.episode_id = candidate.id
        and material.material_type = 'video'
        and material.storage_path ~* '[.](mp4|mov|webm)$'
    ) then
      if not exists (
        select 1
        from public.audio_tracks track
        join public.production_material_revisions material on material.id = track.source_material_revision_id
        join public.material_revision_approvals approval on approval.material_revision_id = material.id
        where track.episode_id = candidate.id
          and track.track_kind = 'derived'
      ) then
        continue;
      end if;
    elsif exists (
      select 1
      from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}') shot
      where not exists (
        select 1
        from public.audio_tracks track
        where track.episode_id = candidate.id
          and track.track_kind = 'narration'
          and track.source_review_package_id = candidate.storyboard_review_package_id
          and track.cue_id = shot ->> 'id'
      )
    ) then
      continue;
    end if;

    if exists (
      select 1
      from jsonb_array_elements(coalesce(candidate.storyboard_context #> '{worker_result,storyboard,audioCues}', '[]'::jsonb)) cue
      where cue ->> 'kind' not in ('bgm', 'sfx')
         or coalesce(btrim(cue ->> 'id'), '') = ''
         or not exists (
           select 1
           from public.audio_tracks track
           where track.episode_id = candidate.id
             and track.track_kind = cue ->> 'kind'
             and track.source_review_package_id = candidate.storyboard_review_package_id
             and track.cue_id = cue ->> 'id'
         )
    ) then
      continue;
    end if;

    update public.episodes
    set stage = 'production_ready', updated_at = now()
    where id = candidate.id
    returning * into advanced_episode;

    insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
    values (candidate.id, 'storyboard_approved', 'production_ready', '所有冻结镜头媒体、旁白及声明声轨均已验证完成。', null);
    insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
    values (candidate.account_id, candidate.id, 'stage_transition', jsonb_build_object('from_stage', 'storyboard_approved', 'to_stage', 'production_ready', 'reason', '所有冻结镜头媒体、旁白及声明声轨均已验证完成。'), null);
    return next advanced_episode;
  end loop;
end;
$$;

revoke all on function public.advance_production_ready_episodes(uuid) from public, anon, authenticated;
grant execute on function public.advance_production_ready_episodes(uuid) to service_role;
