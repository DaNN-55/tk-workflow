drop trigger if exists register_completed_audio_track_after_result on public.tasks;

create trigger register_completed_audio_track_after_result
after update of status on public.tasks
for each row
when (new.status = 'completed'::public.task_status and old.status is distinct from new.status)
execute function public.register_completed_audio_track();

insert into public.audio_tracks (episode_id,source_task_id,source_artifact_id,source_review_package_id,source_material_revision_id,track_kind,cue_id,relative_path,sha256,file_size,start_seconds,duration_seconds)
select task.episode_id,task.id,artifact.id,nullif(track_snapshot ->> 'source_review_package_id','')::uuid,
  case when track_snapshot ? 'source_material_revision_id' then (track_snapshot ->> 'source_material_revision_id')::uuid else null end,
  track_snapshot ->> 'kind',nullif(track_snapshot ->> 'cue_id',''),artifact.relative_path,artifact.sha256,artifact.file_size,
  coalesce((track_snapshot ->> 'start_seconds')::numeric,0),(task.last_result ->> 'audioDurationSeconds')::numeric
from public.tasks task
join public.artifacts artifact on artifact.producer_task_id = task.id and artifact.relative_path = task.input_snapshot #>> '{output,relative_path}'
cross join lateral (select task.input_snapshot -> 'audio_track' as track_snapshot) snapshot
where task.status = 'completed'
  and task.task_type in ('generate_narration','extract_embedded_audio','generate_soundtrack')
  and jsonb_typeof(track_snapshot) = 'object'
  and track_snapshot ->> 'kind' in ('narration','derived','bgm','sfx')
  and coalesce(btrim(track_snapshot ->> 'cue_id'),'') <> ''
  and coalesce(task.last_result ->> 'audioDurationSeconds','') ~ '^[0-9]+([.][0-9]+)?$'
  and (task.last_result ->> 'audioDurationSeconds')::numeric > 0
  and (not track_snapshot ? 'source_material_revision_id' or exists (
    select 1 from public.production_material_revisions material
    join public.material_revision_approvals approval on approval.material_revision_id = material.id
    where material.id = (track_snapshot ->> 'source_material_revision_id')::uuid
      and material.episode_id = task.episode_id
  ))
  and not exists (select 1 from public.audio_tracks track where track.source_task_id = task.id);

revoke all on function public.register_completed_audio_track() from public, anon, authenticated;
