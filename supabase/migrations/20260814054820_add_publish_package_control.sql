create or replace function public.has_required_artifacts(p_episode_id uuid, p_to_stage public.episode_stage)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case p_to_stage
    when 'script_approved'::public.episode_stage then exists (
      select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'script'
    )
    when 'visual_approved'::public.episode_stage then exists (
      select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'visual_brief'
    )
    when 'storyboard_approved'::public.episode_stage then exists (
      select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'storyboard'
    )
    when 'qc_passed'::public.episode_stage then exists (
      select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'render'
    )
    when 'publish_ready'::public.episode_stage then (
      select count(distinct artifact_type) = 5
        and exists (
          select 1
          from public.tasks verification
          join public.artifacts publish_package
            on publish_package.episode_id = verification.episode_id
           and publish_package.artifact_type = 'publish_package'
          where verification.episode_id = p_episode_id
            and verification.task_type = 'verify_publish_package'
            and verification.status = 'completed'
            and verification.input_snapshot #>> '{publish_package,sha256}' = publish_package.sha256
            and (verification.input_snapshot #>> '{publish_package,file_size}')::bigint = publish_package.file_size
        )
      from public.artifacts
      where episode_id = p_episode_id
        and artifact_type in ('render', 'cover', 'metadata', 'qc_report', 'publish_package')
    )
    else true
  end;
$$;

create function public.record_publish_package(
  p_episode_id uuid,
  p_relative_path text,
  p_sha256 text,
  p_file_size bigint
)
returns public.artifacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_episode public.episodes;
  recorded_artifact public.artifacts;
  publish_task public.tasks;
  expected_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the local publish-prep worker may record a publish package' using errcode = '42501';
  end if;
  select * into current_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  if current_episode.stage <> 'qc_passed' then
    raise exception 'Publish package requires qc_passed' using errcode = '22023';
  end if;
  expected_path := 'episodes/' || p_episode_id::text || '/publish-package/manifest.json';
  if p_relative_path <> expected_path or p_sha256 !~ '^[0-9a-f]{64}$' or p_file_size < 0 then
    raise exception 'Publish package index is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.artifacts
    where episode_id = p_episode_id and artifact_type = 'render'
  ) then
    raise exception 'Render artifact is required before a publish package' using errcode = '22023';
  end if;
  select * into recorded_artifact
  from public.artifacts
  where episode_id = p_episode_id
    and artifact_type = 'publish_package'
    and relative_path = p_relative_path;
  if found then
    if recorded_artifact.sha256 <> p_sha256 or recorded_artifact.file_size <> p_file_size then
      raise exception 'Publish package is already fixed for this episode' using errcode = '22023';
    end if;
    return recorded_artifact;
  end if;
  insert into public.tasks (episode_id, task_type, status, input_snapshot)
  values (
    p_episode_id,
    'prepare_publish_package',
    'completed',
    jsonb_build_object('publish_package', jsonb_build_object('relative_path', p_relative_path, 'sha256', p_sha256, 'file_size', p_file_size))
  )
  returning * into publish_task;
  insert into public.artifacts (episode_id, artifact_type, relative_path, sha256, file_size, producer_task_id)
  values (p_episode_id, 'publish_package', p_relative_path, p_sha256, p_file_size, publish_task.id)
  returning * into recorded_artifact;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    p_episode_id,
    'publish_package_generated',
    jsonb_build_object('relative_path', p_relative_path, 'sha256', p_sha256, 'file_size', p_file_size),
    auth.uid()
  );
  return recorded_artifact;
end;
$$;

alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check check (task_type in ('draft_brief', 'prepare_publish_package', 'verify_publish_package'));

create function public.record_publish_package_verification(
  p_episode_id uuid,
  p_sha256 text,
  p_file_size bigint
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_episode public.episodes;
  publish_package public.artifacts;
  verification_task public.tasks;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the local publish verification command may record a result' using errcode = '42501';
  end if;
  select * into current_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  if current_episode.stage <> 'qc_passed' then
    raise exception 'Publish package verification requires qc_passed' using errcode = '22023';
  end if;
  select * into publish_package from public.artifacts
  where episode_id = p_episode_id and artifact_type = 'publish_package';
  if not found or publish_package.sha256 <> p_sha256 or publish_package.file_size <> p_file_size then
    raise exception 'Publish package verification does not match the fixed package' using errcode = '22023';
  end if;
  insert into public.tasks (episode_id, task_type, status, input_snapshot)
  values (
    p_episode_id,
    'verify_publish_package',
    'completed',
    jsonb_build_object('publish_package', jsonb_build_object('sha256', p_sha256, 'file_size', p_file_size))
  )
  returning * into verification_task;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (current_episode.account_id, p_episode_id, 'publish_package_verified', jsonb_build_object('sha256', p_sha256, 'file_size', p_file_size), auth.uid());
  return verification_task;
end;
$$;

revoke all on function public.record_publish_package(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_publish_package(uuid, text, text, bigint) to service_role;
revoke all on function public.record_publish_package_verification(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.record_publish_package_verification(uuid, text, bigint) to service_role;
