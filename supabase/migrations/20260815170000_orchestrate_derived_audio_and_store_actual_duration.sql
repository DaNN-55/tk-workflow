create unique index tasks_one_derived_audio_per_source_material_idx
on public.tasks ((input_snapshot ->> 'source_material_revision_id'))
where task_type = 'extract_embedded_audio';

create or replace function public.register_completed_audio_track()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare selected_artifact public.artifacts; track_snapshot jsonb; actual_duration numeric;
begin
  if new.status <> 'completed' or new.task_type not in ('generate_narration', 'extract_embedded_audio', 'generate_soundtrack') then return new; end if;
  track_snapshot := new.input_snapshot -> 'audio_track';
  if jsonb_typeof(track_snapshot) <> 'object' then raise exception 'Completed audio task is missing its frozen audio track snapshot' using errcode = '22023'; end if;
  if coalesce(new.last_result ->> 'audioDurationSeconds', '') !~ '^[0-9]+(\.[0-9]+)?$' or (new.last_result ->> 'audioDurationSeconds')::numeric <= 0 then raise exception 'Completed audio task is missing its probed duration' using errcode = '22023'; end if;
  actual_duration := (new.last_result ->> 'audioDurationSeconds')::numeric;
  select * into selected_artifact from public.artifacts artifact where artifact.producer_task_id = new.id and artifact.relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then raise exception 'Completed audio task is missing its frozen output artifact' using errcode = '22023'; end if;
  insert into public.audio_tracks (episode_id,source_task_id,source_artifact_id,source_review_package_id,track_kind,cue_id,relative_path,sha256,file_size,start_seconds,duration_seconds)
  values (new.episode_id,new.id,selected_artifact.id,nullif(track_snapshot ->> 'source_review_package_id','')::uuid,track_snapshot ->> 'kind',nullif(track_snapshot ->> 'cue_id',''),selected_artifact.relative_path,selected_artifact.sha256,selected_artifact.file_size,coalesce((track_snapshot ->> 'start_seconds')::numeric,0),actual_duration);
  return new;
end;
$$;

create function public.orchestrate_embedded_audio_tasks()
returns setof public.tasks language plpgsql security definer set search_path = ''
as $$
declare candidate record; created_task public.tasks;
begin
  for candidate in
    select material.*, episode.account_id, episode.blueprint_version_id
    from public.production_material_revisions material join public.episodes episode on episode.id = material.episode_id
    where material.material_type = 'video' and material.storage_path ~* '\.(mp4|mov|webm)$'
    order by material.created_at, material.id for update of material skip locked
  loop
    if exists (select 1 from public.tasks task where task.task_type = 'extract_embedded_audio' and task.input_snapshot ->> 'source_material_revision_id' = candidate.id::text) then continue; end if;
    insert into public.tasks (episode_id,task_type,status,input_snapshot,budget_limit_cents,max_attempts,provider,model,prompt_version)
    values (candidate.episode_id,'extract_embedded_audio','ready',jsonb_build_object(
      'capability','embedded_audio_extraction','source_material_revision_id',candidate.id,'source_video_revision_sha256',candidate.sha256,
      'media',jsonb_build_object('adapter','ffmpeg_extract_audio','embedded_audio',jsonb_build_object('source_relative_path',candidate.storage_path,'duration_seconds',0.001)),
      'audio_track',jsonb_build_object('kind','derived','cue_id',format('material-v%s',candidate.revision_number),'start_seconds',0,'duration_seconds',0.001),
      'budget',jsonb_build_object('limit_cents',0,'max_attempts',1),'allowed_tools',jsonb_build_array('read','write'),
      'output',jsonb_build_object('required_artifact_types',jsonb_build_array('derived_audio'),'content_type','audio/mpeg','relative_path',format('episodes/%s/audio/derived-material-v%s.mp3',candidate.episode_id,candidate.revision_number),'review_stage','production_ready'),
      'input_artifacts',jsonb_build_array(jsonb_build_object('artifactType','source_video_material','relativePath',candidate.storage_path,'sha256',candidate.sha256,'fileSize',candidate.file_size))),0,1,'ffmpeg','ffmpeg','embedded-audio-v1') returning * into created_task;
    return next created_task;
  end loop;
end;
$$;

revoke all on function public.register_completed_audio_track() from public, anon, authenticated;
revoke all on function public.orchestrate_embedded_audio_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_embedded_audio_tasks() to service_role;
