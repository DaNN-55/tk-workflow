alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
check (task_type in ('draft_brief', 'draft_script', 'prepare_visual_brief', 'draft_storyboard', 'generate_a_roll', 'generate_b_roll', 'generate_narration', 'extract_embedded_audio', 'generate_soundtrack'));

create table public.audio_tracks (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  source_task_id uuid not null unique references public.tasks(id) on delete restrict,
  source_artifact_id uuid not null unique references public.artifacts(id) on delete restrict,
  source_review_package_id uuid references public.review_packages(id) on delete restrict,
  track_kind text not null check (track_kind in ('narration', 'derived', 'bgm', 'sfx')),
  cue_id text,
  relative_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_size bigint not null check (file_size >= 0),
  start_seconds numeric(12, 3) not null default 0 check (start_seconds >= 0),
  duration_seconds numeric(12, 3) not null check (duration_seconds > 0),
  created_at timestamptz not null default now(),
  unique (episode_id, track_kind, cue_id, source_review_package_id)
);

create index audio_tracks_episode_created_idx on public.audio_tracks (episode_id, created_at desc);

create table public.audio_track_annotations (
  id uuid primary key default gen_random_uuid(),
  audio_track_id uuid not null references public.audio_tracks(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  at_seconds numeric(12, 3) not null check (at_seconds >= 0),
  reason text not null check (btrim(reason) <> ''),
  created_at timestamptz not null default now()
);

create index audio_track_annotations_track_time_idx on public.audio_track_annotations (audio_track_id, at_seconds, created_at);

alter table public.audio_tracks enable row level security;
alter table public.audio_track_annotations enable row level security;

create policy "members can read audio tracks" on public.audio_tracks for select
using (exists (select 1 from public.episodes episode where episode.id = audio_tracks.episode_id and public.is_account_member(episode.account_id)));

create policy "members can read audio track annotations" on public.audio_track_annotations for select
using (exists (select 1 from public.audio_tracks track join public.episodes episode on episode.id = track.episode_id where track.id = audio_track_annotations.audio_track_id and public.is_account_member(episode.account_id)));

grant select on public.audio_tracks, public.audio_track_annotations to authenticated;

create function public.create_audio_track_annotation(p_audio_track_id uuid, p_at_seconds numeric, p_reason text)
returns public.audio_track_annotations
language plpgsql
security definer
set search_path = ''
as $$
declare
  track public.audio_tracks;
  membership_role public.member_role;
  created_annotation public.audio_track_annotations;
begin
  if p_at_seconds < 0 or p_at_seconds > 86400 or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Audio annotation is invalid' using errcode = '22023';
  end if;
  select * into track from public.audio_tracks where id = p_audio_track_id;
  if not found then raise exception 'Audio track does not exist' using errcode = 'P0002'; end if;
  select membership.role into membership_role from public.account_memberships membership join public.episodes episode on episode.account_id = membership.account_id where episode.id = track.episode_id and membership.user_id = auth.uid();
  if membership_role is distinct from 'owner' then raise exception 'Owner membership is required to annotate an audio track' using errcode = '42501'; end if;
  insert into public.audio_track_annotations (audio_track_id, author_id, at_seconds, reason)
  values (track.id, auth.uid(), p_at_seconds, btrim(p_reason))
  returning * into created_annotation;
  return created_annotation;
end;
$$;

create function public.register_completed_audio_track()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_artifact public.artifacts;
  track_snapshot jsonb;
begin
  if new.status <> 'completed' or new.task_type not in ('generate_narration', 'extract_embedded_audio', 'generate_soundtrack') then return new; end if;
  track_snapshot := new.input_snapshot -> 'audio_track';
  if jsonb_typeof(track_snapshot) <> 'object' then raise exception 'Completed audio task is missing its frozen audio track snapshot' using errcode = '22023'; end if;
  select * into selected_artifact from public.artifacts artifact where artifact.producer_task_id = new.id and artifact.relative_path = new.input_snapshot #>> '{output,relative_path}';
  if not found then raise exception 'Completed audio task is missing its frozen output artifact' using errcode = '22023'; end if;
  insert into public.audio_tracks (episode_id, source_task_id, source_artifact_id, source_review_package_id, track_kind, cue_id, relative_path, sha256, file_size, start_seconds, duration_seconds)
  values (
    new.episode_id,
    new.id,
    selected_artifact.id,
    nullif(track_snapshot ->> 'source_review_package_id', '')::uuid,
    track_snapshot ->> 'kind',
    nullif(track_snapshot ->> 'cue_id', ''),
    selected_artifact.relative_path,
    selected_artifact.sha256,
    selected_artifact.file_size,
    coalesce((track_snapshot ->> 'start_seconds')::numeric, 0),
    (track_snapshot ->> 'duration_seconds')::numeric
  );
  return new;
end;
$$;

create trigger register_completed_audio_track_after_result
after update of status on public.tasks
for each row execute function public.register_completed_audio_track();

revoke execute on function public.create_audio_track_annotation(uuid, numeric, text) from public, anon;
grant execute on function public.create_audio_track_annotation(uuid, numeric, text) to authenticated;
revoke execute on function public.register_completed_audio_track() from public, anon, authenticated;
