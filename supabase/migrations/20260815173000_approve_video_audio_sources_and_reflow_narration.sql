create table public.material_revision_approvals (
  id uuid primary key default gen_random_uuid(),
  material_revision_id uuid not null unique references public.production_material_revisions(id) on delete cascade,
  approved_by uuid not null references auth.users(id) on delete restrict,
  approved_at timestamptz not null default now()
);

alter table public.material_revision_approvals enable row level security;
create policy "members can read material revision approvals" on public.material_revision_approvals for select to authenticated
using (exists (select 1 from public.production_material_revisions material join public.episodes episode on episode.id = material.episode_id where material.id = material_revision_approvals.material_revision_id and public.is_account_member(episode.account_id)));
grant select on public.material_revision_approvals to authenticated;

insert into public.material_revision_approvals (material_revision_id, approved_by)
select material.id, material.created_by
from public.production_material_revisions material
join public.episodes episode on episode.id = material.episode_id
join public.account_memberships membership on membership.account_id = episode.account_id and membership.user_id = material.created_by and membership.role = 'owner'
on conflict (material_revision_id) do nothing;

alter table public.audio_tracks add column source_material_revision_id uuid references public.production_material_revisions(id) on delete restrict;
create index audio_tracks_source_material_revision_idx on public.audio_tracks (source_material_revision_id) where source_material_revision_id is not null;

update public.audio_tracks track
set source_material_revision_id = material.id
from public.tasks task
join public.production_material_revisions material on material.id = (task.input_snapshot ->> 'source_material_revision_id')::uuid and material.episode_id = task.episode_id
where task.id = track.source_task_id and track.source_material_revision_id is null and task.input_snapshot ? 'source_material_revision_id';

create or replace function public.import_production_material(
  p_episode_id uuid, p_material_type text, p_source_kind text, p_source_path text, p_storage_path text, p_mime_type text, p_sha256 text, p_file_size bigint, p_is_main_script boolean
)
returns public.production_material_revisions
language plpgsql security definer set search_path = ''
as $$
declare created_revision public.production_material_revisions; current_episode public.episodes; next_revision integer;
begin
  select episode.* into current_episode from public.episodes episode join public.account_memberships membership on membership.account_id = episode.account_id where episode.id = p_episode_id and membership.user_id = auth.uid() and membership.role = 'owner' for update of episode;
  if not found then raise exception 'Owner membership is required to import production material' using errcode = '42501'; end if;
  if p_is_main_script and trim(p_material_type) <> 'script' then raise exception 'Main script material must have script type' using errcode = '22023'; end if;
  if p_is_main_script and current_episode.stage <> 'waiting_input' then raise exception 'A main script can only be imported while the episode is waiting for input' using errcode = '22023'; end if;
  if p_storage_path !~ ('^episodes/' || p_episode_id::text || '/materials/[0-9a-f]{64}-[^/]+$') then raise exception 'Material storage path is outside the episode material directory' using errcode = '22023'; end if;
  select coalesce(max(revision_number), 0) + 1 into next_revision from public.production_material_revisions where episode_id = p_episode_id and material_type = trim(p_material_type);
  insert into public.production_material_revisions (episode_id,revision_number,material_type,source_kind,source_path,storage_path,mime_type,sha256,file_size,is_main_script,created_by)
  values (p_episode_id,next_revision,trim(p_material_type),p_source_kind,trim(p_source_path),p_storage_path,p_mime_type,p_sha256,p_file_size,p_is_main_script,auth.uid()) returning * into created_revision;
  insert into public.material_revision_approvals (material_revision_id,approved_by) values (created_revision.id,auth.uid());
  if p_is_main_script then
    update public.episodes set main_script_revision_id = created_revision.id, stage = 'script_approved', updated_at = now() where id = p_episode_id;
    insert into public.state_transitions (episode_id,from_stage,to_stage,reason,actor_id) values (p_episode_id,'waiting_input','script_approved','Owner confirmed an imported main script revision.',auth.uid());
  end if;
  insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id) values (current_episode.account_id,p_episode_id,'production_material_imported',jsonb_build_object('material_revision_id',created_revision.id,'material_type',created_revision.material_type,'sha256',created_revision.sha256,'source_kind',created_revision.source_kind,'is_main_script',created_revision.is_main_script,'approval_id',(select id from public.material_revision_approvals where material_revision_id = created_revision.id)),auth.uid());
  return created_revision;
end;
$$;

create or replace function public.orchestrate_embedded_audio_tasks()
returns setof public.tasks language plpgsql security definer set search_path = ''
as $$
declare candidate record; created_task public.tasks;
begin
  for candidate in
    select material.*, approval.id as approval_id, episode.account_id, episode.blueprint_version_id
    from public.production_material_revisions material
    join public.material_revision_approvals approval on approval.material_revision_id = material.id
    join public.episodes episode on episode.id = material.episode_id
    where material.material_type = 'video' and material.storage_path ~* '[.](mp4|mov|webm)$'
    order by material.created_at, material.id for update of material skip locked
  loop
    if exists (select 1 from public.tasks task where task.task_type = 'extract_embedded_audio' and task.input_snapshot ->> 'source_material_revision_id' = candidate.id::text) then continue; end if;
    insert into public.tasks (episode_id,task_type,status,input_snapshot,budget_limit_cents,max_attempts,provider,model,prompt_version)
    values (candidate.episode_id,'extract_embedded_audio','ready',jsonb_build_object(
      'capability','embedded_audio_extraction','source_material_revision_id',candidate.id,'source_material_approval_id',candidate.approval_id,'source_video_revision_sha256',candidate.sha256,
      'media',jsonb_build_object('adapter','ffmpeg_extract_audio','embedded_audio',jsonb_build_object('source_relative_path',candidate.storage_path,'duration_seconds',0.001)),
      'audio_track',jsonb_build_object('kind','derived','cue_id',format('material-v%s',candidate.revision_number),'source_material_revision_id',candidate.id,'start_seconds',0,'duration_seconds',0.001),
      'budget',jsonb_build_object('limit_cents',0,'max_attempts',1),'allowed_tools',jsonb_build_array('read','write'),
      'output',jsonb_build_object('required_artifact_types',jsonb_build_array('derived_audio'),'content_type','audio/mpeg','relative_path',format('episodes/%s/audio/derived-material-v%s.mp3',candidate.episode_id,candidate.revision_number),'review_stage','production_ready'),
      'input_artifacts',jsonb_build_array(jsonb_build_object('artifactType','source_video_material','relativePath',candidate.storage_path,'sha256',candidate.sha256,'fileSize',candidate.file_size))),0,1,'ffmpeg','ffmpeg','embedded-audio-v1') returning * into created_task;
    return next created_task;
  end loop;
end;
$$;

create or replace function public.register_completed_audio_track()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare selected_artifact public.artifacts; track_snapshot jsonb; actual_duration numeric; source_material public.production_material_revisions;
begin
  if new.status <> 'completed' or new.task_type not in ('generate_narration', 'extract_embedded_audio', 'generate_soundtrack') then return new; end if;
  track_snapshot := new.input_snapshot -> 'audio_track';
  if jsonb_typeof(track_snapshot) <> 'object' then raise exception 'Completed audio task is missing its frozen audio track snapshot' using errcode = '22023'; end if;
  if coalesce(new.last_result ->> 'audioDurationSeconds', '') !~ '^[0-9]+([.][0-9]+)?$' or (new.last_result ->> 'audioDurationSeconds')::numeric <= 0 then raise exception 'Completed audio task is missing its probed duration' using errcode = '22023'; end if;
  actual_duration := (new.last_result ->> 'audioDurationSeconds')::numeric;
  if track_snapshot ? 'source_material_revision_id' then
    select material.* into source_material from public.production_material_revisions material join public.material_revision_approvals approval on approval.material_revision_id = material.id where material.id = (track_snapshot ->> 'source_material_revision_id')::uuid and material.episode_id = new.episode_id;
    if not found then raise exception 'Completed audio task source material approval is invalid' using errcode = '22023'; end if;
  end if;
  select * into selected_artifact from public.artifacts artifact where artifact.producer_task_id = new.id and artifact.relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then raise exception 'Completed audio task is missing its frozen output artifact' using errcode = '22023'; end if;
  insert into public.audio_tracks (episode_id,source_task_id,source_artifact_id,source_review_package_id,source_material_revision_id,track_kind,cue_id,relative_path,sha256,file_size,start_seconds,duration_seconds)
  values (new.episode_id,new.id,selected_artifact.id,nullif(track_snapshot ->> 'source_review_package_id','')::uuid,source_material.id,track_snapshot ->> 'kind',nullif(track_snapshot ->> 'cue_id',''),selected_artifact.relative_path,selected_artifact.sha256,selected_artifact.file_size,coalesce((track_snapshot ->> 'start_seconds')::numeric,0),actual_duration);
  if new.task_type = 'generate_narration' and track_snapshot ->> 'cue_id' <> 'episode_narration' then
    with sequenced as (
      select track.id, coalesce(sum(track.duration_seconds) over (order by (source_task.input_snapshot #>> '{audio_track,start_seconds}')::numeric rows between unbounded preceding and 1 preceding),0) as next_start
      from public.audio_tracks track join public.tasks source_task on source_task.id = track.source_task_id
      where track.episode_id = new.episode_id and track.track_kind = 'narration' and track.source_review_package_id = nullif(track_snapshot ->> 'source_review_package_id','')::uuid and source_task.input_snapshot #>> '{audio_track,cue_id}' <> 'episode_narration'
    ) update public.audio_tracks track set start_seconds = sequenced.next_start from sequenced where track.id = sequenced.id;
  end if;
  return new;
end;
$$;

revoke all on function public.import_production_material(uuid,text,text,text,text,text,text,bigint,boolean) from public, anon;
grant execute on function public.import_production_material(uuid,text,text,text,text,text,text,bigint,boolean) to authenticated;
revoke all on function public.orchestrate_embedded_audio_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_embedded_audio_tasks() to service_role;
revoke all on function public.register_completed_audio_track() from public, anon, authenticated;
