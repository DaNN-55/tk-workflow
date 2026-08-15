alter table public.review_packages
  drop constraint review_packages_stage_check;

alter table public.review_packages
  add constraint review_packages_stage_check
  check (stage in ('script_review', 'visual_review', 'storyboard_review', 'production_ready'));

alter table public.review_packages
  alter column task_id drop not null,
  alter column task_run_id drop not null,
  alter column artifact_id drop not null,
  add column invalidated_at timestamptz,
  add column invalidated_reason text;

alter table public.review_packages
  add constraint review_packages_invalidation_reason_check
  check ((invalidated_at is null and invalidated_reason is null) or (invalidated_at is not null and btrim(coalesce(invalidated_reason, '')) <> ''));

create table public.pre_render_review_members (
  id uuid primary key default gen_random_uuid(),
  review_package_id uuid not null references public.review_packages(id) on delete cascade,
  member_key text not null check (btrim(member_key) <> ''),
  member_kind text not null check (member_kind in ('shot_media', 'narration', 'soundtrack')),
  source_task_id uuid not null references public.tasks(id) on delete restrict,
  artifact_id uuid references public.artifacts(id) on delete restrict,
  audio_track_id uuid references public.audio_tracks(id) on delete restrict,
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (review_package_id, member_key),
  check ((artifact_id is not null and audio_track_id is null) or (artifact_id is null and audio_track_id is not null))
);

create index pre_render_review_members_package_idx
  on public.pre_render_review_members (review_package_id, member_kind, member_key);

alter table public.pre_render_review_members enable row level security;

create policy "members can read pre-render review members"
on public.pre_render_review_members for select to authenticated
using (
  exists (
    select 1
    from public.review_packages package
    join public.episodes episode on episode.id = package.episode_id
    where package.id = pre_render_review_members.review_package_id
      and public.is_account_member(episode.account_id)
  )
);

grant select on public.pre_render_review_members to authenticated;

create table public.pre_render_review_member_decisions (
  review_package_id uuid not null references public.review_packages(id) on delete cascade,
  member_key text not null check (btrim(member_key) <> ''),
  decision text not null check (decision in ('approved', 'changes_requested')),
  reason text not null check (btrim(reason) <> ''),
  actor_id uuid not null references auth.users(id) on delete restrict,
  inherited_from_review_package_id uuid references public.review_packages(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (review_package_id, member_key)
);

create index pre_render_member_decisions_package_idx
  on public.pre_render_review_member_decisions (review_package_id, decision);

drop index if exists public.tasks_one_a_roll_per_storyboard_shot_idx;
create unique index tasks_one_a_roll_per_storyboard_shot_revision_idx
on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot #>> '{shot,id}'), coalesce(input_snapshot ->> 'pre_render_revision', ''))
where task_type = 'generate_a_roll';

drop index if exists public.tasks_one_b_roll_per_storyboard_shot_configuration_idx;
create unique index tasks_one_b_roll_per_storyboard_shot_configuration_revision_idx
on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot #>> '{shot,id}'), (input_snapshot ->> 'configuration_hash'), coalesce(input_snapshot ->> 'pre_render_revision', ''))
where task_type = 'generate_b_roll';

drop index if exists public.tasks_one_narration_per_storyboard_cue_configuration_idx;
create unique index tasks_one_narration_per_storyboard_cue_configuration_revision_idx
on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot #>> '{audio_track,cue_id}'), (input_snapshot ->> 'configuration_hash'), coalesce(input_snapshot ->> 'pre_render_revision', ''))
where task_type = 'generate_narration';

drop index if exists public.tasks_one_soundtrack_per_storyboard_cue_configuration_idx;
create unique index tasks_one_soundtrack_per_storyboard_cue_configuration_revision_idx
on public.tasks (episode_id, (input_snapshot ->> 'storyboard_review_package_id'), (input_snapshot #>> '{audio_track,cue_id}'), (input_snapshot ->> 'configuration_hash'), coalesce(input_snapshot ->> 'pre_render_revision', ''))
where task_type = 'generate_soundtrack';

alter table public.pre_render_review_member_decisions enable row level security;

create policy "members can read pre-render member decisions"
on public.pre_render_review_member_decisions for select to authenticated
using (
  exists (
    select 1
    from public.review_packages package
    join public.episodes episode on episode.id = package.episode_id
    where package.id = pre_render_review_member_decisions.review_package_id
      and public.is_account_member(episode.account_id)
  )
);

grant select on public.pre_render_review_member_decisions to authenticated;

create function public.create_pre_render_review_packages()
returns setof public.review_packages
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  storyboard_shot jsonb;
  audio_cue jsonb;
  selected_task public.tasks;
  selected_artifact public.artifacts;
  selected_track public.audio_tracks;
  members jsonb := '[]'::jsonb;
  member_evidence jsonb;
  member_key text;
  expected_member_count integer;
  next_revision integer;
  created_package public.review_packages;
  has_approved_video boolean;
begin
  for candidate in
    select
      episode.id as episode_id,
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
    where episode.stage = 'production_ready'
      and not exists (
        select 1
        from public.review_packages package
        where package.episode_id = episode.id
          and package.stage = 'production_ready'
          and package.invalidated_at is null
      )
    order by episode.updated_at, episode.id
    for update of episode skip locked
  loop
    members := '[]'::jsonb;

    for storyboard_shot in
      select value
      from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}')
    loop
      if storyboard_shot ->> 'shotType' = 'a_roll' then
        select task.* into selected_task
        from public.tasks task
        where task.episode_id = candidate.episode_id
          and task.task_type = 'generate_a_roll'
          and task.status = 'completed'
          and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text
          and task.input_snapshot #>> '{shot,id}' = storyboard_shot ->> 'id'
        order by task.completed_at desc, task.id desc
        limit 1;
      elsif storyboard_shot ->> 'shotType' = 'b_roll' then
        select task.* into selected_task
        from public.tasks task
        where task.episode_id = candidate.episode_id
          and task.task_type = 'generate_b_roll'
          and task.status = 'completed'
          and task.input_snapshot ->> 'storyboard_review_package_id' = candidate.storyboard_review_package_id::text
          and task.input_snapshot #>> '{shot,id}' = storyboard_shot ->> 'id'
        order by task.completed_at desc, task.id desc
        limit 1;
      else
        raise exception 'Approved storyboard contains an invalid shot type' using errcode = '22023';
      end if;
      if not found then
        continue;
      end if;

      select artifact.* into selected_artifact
      from public.artifacts artifact
      where artifact.producer_task_id = selected_task.id
        and artifact.relative_path = selected_task.input_snapshot #>> '{output,relative_path}'
        and artifact.artifact_type = any (
          array(select jsonb_array_elements_text(selected_task.input_snapshot #> '{output,required_artifact_types}'))
        );
      if not found then
        continue;
      end if;

      member_key := format('shot:%s', storyboard_shot ->> 'id');
      member_evidence := jsonb_build_object(
        'member_kind', 'shot_media',
        'member_key', member_key,
        'shot', storyboard_shot,
        'task', jsonb_build_object('id', selected_task.id, 'type', selected_task.task_type, 'attempt', selected_task.attempt, 'provider', selected_task.provider, 'model', selected_task.model, 'prompt_version', selected_task.prompt_version, 'actual_cost_cents', selected_task.actual_cost_cents, 'result', selected_task.last_result),
        'artifact', jsonb_build_object('id', selected_artifact.id, 'artifact_type', selected_artifact.artifact_type, 'relative_path', selected_artifact.relative_path, 'sha256', selected_artifact.sha256, 'file_size', selected_artifact.file_size)
      );
      members := members || jsonb_build_array(member_evidence);
    end loop;

    expected_member_count := jsonb_array_length(candidate.storyboard_context #> '{worker_result,storyboard,shots}');
    if jsonb_array_length(members) <> expected_member_count then
      continue;
    end if;

    select exists (
      select 1
      from public.production_material_revisions material
      join public.material_revision_approvals approval on approval.material_revision_id = material.id
      where material.episode_id = candidate.episode_id
        and material.material_type = 'video'
        and material.storage_path ~* '[.](mp4|mov|webm)$'
    ) into has_approved_video;

    if has_approved_video then
      select track.* into selected_track
      from public.audio_tracks track
      join public.production_material_revisions material on material.id = track.source_material_revision_id
      join public.material_revision_approvals approval on approval.material_revision_id = material.id
      where track.episode_id = candidate.episode_id
        and track.track_kind = 'derived'
      order by track.created_at desc, track.id desc
      limit 1;
      if not found then
        continue;
      end if;
      select * into selected_task from public.tasks where id = selected_track.source_task_id;
      member_key := 'narration:derived-video';
      member_evidence := jsonb_build_object('member_kind','narration','member_key',member_key,'task',jsonb_build_object('id',selected_task.id,'type',selected_task.task_type,'attempt',selected_task.attempt,'provider',selected_task.provider,'model',selected_task.model,'prompt_version',selected_task.prompt_version,'actual_cost_cents',selected_task.actual_cost_cents,'result',selected_task.last_result),'audio_track',jsonb_build_object('id',selected_track.id,'kind',selected_track.track_kind,'cue_id',selected_track.cue_id,'relative_path',selected_track.relative_path,'sha256',selected_track.sha256,'file_size',selected_track.file_size,'start_seconds',selected_track.start_seconds,'duration_seconds',selected_track.duration_seconds,'source_material_revision_id',selected_track.source_material_revision_id));
      members := members || jsonb_build_array(member_evidence);
      expected_member_count := expected_member_count + 1;
    else
      for storyboard_shot in select value from jsonb_array_elements(candidate.storyboard_context #> '{worker_result,storyboard,shots}') loop
        select track.* into selected_track
        from public.audio_tracks track
        where track.episode_id = candidate.episode_id
          and track.track_kind = 'narration'
          and track.source_review_package_id = candidate.storyboard_review_package_id
          and track.cue_id = storyboard_shot ->> 'id'
        order by track.created_at desc, track.id desc
        limit 1;
        if not found then
          continue;
        end if;
        select * into selected_task from public.tasks where id = selected_track.source_task_id;
        member_key := format('narration:%s', storyboard_shot ->> 'id');
        member_evidence := jsonb_build_object('member_kind','narration','member_key',member_key,'task',jsonb_build_object('id',selected_task.id,'type',selected_task.task_type,'attempt',selected_task.attempt,'provider',selected_task.provider,'model',selected_task.model,'prompt_version',selected_task.prompt_version,'actual_cost_cents',selected_task.actual_cost_cents,'result',selected_task.last_result),'audio_track',jsonb_build_object('id',selected_track.id,'kind',selected_track.track_kind,'cue_id',selected_track.cue_id,'relative_path',selected_track.relative_path,'sha256',selected_track.sha256,'file_size',selected_track.file_size,'start_seconds',selected_track.start_seconds,'duration_seconds',selected_track.duration_seconds));
        members := members || jsonb_build_array(member_evidence);
      end loop;
      expected_member_count := expected_member_count + jsonb_array_length(candidate.storyboard_context #> '{worker_result,storyboard,shots}');
      if jsonb_array_length(members) <> expected_member_count then
        continue;
      end if;
    end if;

    for audio_cue in select value from jsonb_array_elements(coalesce(candidate.storyboard_context #> '{worker_result,storyboard,audioCues}', '[]'::jsonb)) loop
      select track.* into selected_track
      from public.audio_tracks track
      where track.episode_id = candidate.episode_id
        and track.track_kind = audio_cue ->> 'kind'
        and track.source_review_package_id = candidate.storyboard_review_package_id
        and track.cue_id = audio_cue ->> 'id'
      order by track.created_at desc, track.id desc
      limit 1;
      if not found then
        continue;
      end if;
      select * into selected_task from public.tasks where id = selected_track.source_task_id;
      member_key := format('soundtrack:%s', audio_cue ->> 'id');
      member_evidence := jsonb_build_object('member_kind','soundtrack','member_key',member_key,'cue',audio_cue,'task',jsonb_build_object('id',selected_task.id,'type',selected_task.task_type,'attempt',selected_task.attempt,'provider',selected_task.provider,'model',selected_task.model,'prompt_version',selected_task.prompt_version,'actual_cost_cents',selected_task.actual_cost_cents,'result',selected_task.last_result),'audio_track',jsonb_build_object('id',selected_track.id,'kind',selected_track.track_kind,'cue_id',selected_track.cue_id,'relative_path',selected_track.relative_path,'sha256',selected_track.sha256,'file_size',selected_track.file_size,'start_seconds',selected_track.start_seconds,'duration_seconds',selected_track.duration_seconds));
      members := members || jsonb_build_array(member_evidence);
      expected_member_count := expected_member_count + 1;
    end loop;
    if jsonb_array_length(members) <> expected_member_count then
      continue;
    end if;

    select coalesce(max(revision_number), 0) + 1 into next_revision
    from public.review_packages
    where episode_id = candidate.episode_id and stage = 'production_ready';

    insert into public.review_packages (episode_id, stage, revision_number, context_snapshot)
    values (candidate.episode_id, 'production_ready', next_revision, jsonb_build_object('review_kind','pre_render','storyboard_review_package_id',candidate.storyboard_review_package_id,'storyboard',candidate.storyboard_context #> '{worker_result,storyboard}','members',members))
    returning * into created_package;

    insert into public.pre_render_review_members (review_package_id,member_key,member_kind,source_task_id,artifact_id,audio_track_id,evidence_snapshot)
    select created_package.id,
      evidence ->> 'member_key',
      evidence ->> 'member_kind',
      (evidence #>> '{task,id}')::uuid,
      case when evidence ? 'artifact' then (evidence #>> '{artifact,id}')::uuid else null end,
      case when evidence ? 'audio_track' then (evidence #>> '{audio_track,id}')::uuid else null end,
      evidence
    from jsonb_array_elements(members) evidence;

    insert into public.pre_render_review_member_decisions (review_package_id, member_key, decision, reason, actor_id, inherited_from_review_package_id)
    select
      created_package.id,
      member.member_key,
      'approved',
      '沿用未受本次返工影响的已批准成员。',
      previous_decision.actor_id,
      previous_decision.review_package_id
    from public.pre_render_review_members member
    join lateral (
      select decision.*
      from public.pre_render_review_member_decisions decision
      join public.pre_render_review_members previous_member
        on previous_member.review_package_id = decision.review_package_id
       and previous_member.member_key = decision.member_key
      where previous_member.member_key = member.member_key
        and previous_member.source_task_id = member.source_task_id
        and decision.decision = 'approved'
      order by decision.created_at desc
      limit 1
    ) previous_decision on true
    where member.review_package_id = created_package.id;

    insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
    values (candidate.account_id, candidate.episode_id, 'pre_render_review_package_created', jsonb_build_object('review_package_id',created_package.id,'storyboard_review_package_id',candidate.storyboard_review_package_id,'revision_number',next_revision,'member_count',jsonb_array_length(members)), null);
    return next created_package;
  end loop;
end;
$$;

create or replace function public.has_required_artifacts(p_episode_id uuid, p_to_stage public.episode_stage)
returns boolean
language sql
stable
set search_path = public
as $$
  select case p_to_stage
    when 'script_approved'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'script')
    when 'visual_approved'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'visual_brief')
    when 'storyboard_approved'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'storyboard')
    when 'render_ready'::public.episode_stage then exists (
      select 1
      from public.review_packages package
      where package.episode_id = p_episode_id
        and package.stage = 'production_ready'
        and package.invalidated_at is null
        and not exists (
          select 1
          from public.pre_render_review_members member
          where member.review_package_id = package.id
            and not exists (
              select 1
              from public.pre_render_review_member_decisions decision
              where decision.review_package_id = member.review_package_id
                and decision.member_key = member.member_key
                and decision.decision = 'approved'
            )
        )
    )
    when 'qc_passed'::public.episode_stage then exists (select 1 from public.artifacts where episode_id = p_episode_id and artifact_type = 'render')
    else true
  end;
$$;

create or replace function public.transition_episode(p_episode_id uuid, p_to_stage public.episode_stage, p_reason text)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
declare
  current_episode public.episodes;
  previous_stage public.episode_stage;
  membership_role public.member_role;
  owner_approval_stages public.episode_stage[] := array['script_approved','visual_approved','storyboard_approved','render_ready','qc_passed','publish_ready','published']::public.episode_stage[];
  review_stages public.episode_stage[] := array['script_review','visual_review','storyboard_review','production_ready','qc_review','publishing_review']::public.episode_stage[];
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Transition reason is required' using errcode = '22023'; end if;
  select * into current_episode from public.episodes where id = p_episode_id for update;
  if not found then raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002'; end if;
  if not public.is_allowed_episode_transition(current_episode.stage, p_to_stage) then raise exception 'Invalid transition from % to %', current_episode.stage, p_to_stage using errcode = '22023'; end if;
  select role into membership_role from public.account_memberships where account_id = current_episode.account_id and user_id = auth.uid();
  if membership_role is null then raise exception 'No membership for this account' using errcode = '42501'; end if;
  if (p_to_stage = any(owner_approval_stages) or current_episode.stage = any(review_stages)) and membership_role <> 'owner' then raise exception 'Owner approval is required for this review decision' using errcode = '42501'; end if;
  if not public.has_required_artifacts(p_episode_id, p_to_stage) then raise exception 'Required artifacts are missing for %', p_to_stage using errcode = '22023'; end if;
  previous_stage := current_episode.stage;
  update public.episodes set stage = p_to_stage, updated_at = now() where id = p_episode_id returning * into current_episode;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id) values (p_episode_id, previous_stage, p_to_stage, btrim(p_reason), auth.uid());
  if p_to_stage = any(owner_approval_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id) values (p_episode_id, p_to_stage, 'approved', btrim(p_reason), auth.uid());
  elsif previous_stage = any(review_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id) values (p_episode_id, previous_stage, 'changes_requested', btrim(p_reason), auth.uid());
  end if;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id) values (current_episode.account_id, p_episode_id, 'stage_transition', jsonb_build_object('to_stage', p_to_stage, 'reason', btrim(p_reason)), auth.uid());
  return current_episode;
end;
$$;

create or replace function public.link_review_package_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare review_stage public.episode_stage;
begin
  review_stage := case
    when new.stage in ('script_review', 'script_approved') then 'script_review'::public.episode_stage
    when new.stage in ('visual_review', 'visual_approved') then 'visual_review'::public.episode_stage
    when new.stage in ('storyboard_review', 'storyboard_approved') then 'storyboard_review'::public.episode_stage
    when new.stage in ('production_ready', 'render_ready') then 'production_ready'::public.episode_stage
    else null
  end;
  if review_stage is null then return new; end if;
  select review_package.id into new.review_package_id
  from public.review_packages review_package
  where review_package.episode_id = new.episode_id
    and review_package.stage = review_stage
    and review_package.invalidated_at is null
  order by review_package.revision_number desc
  limit 1;
  if new.review_package_id is null then raise exception 'Review approval requires a current review package' using errcode = '22023'; end if;
  return new;
end;
$$;

create function public.review_pre_render_member(p_review_package_id uuid, p_member_key text, p_decision text, p_reason text)
returns public.pre_render_review_member_decisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_package public.review_packages;
  selected_member public.pre_render_review_members;
  selected_task public.tasks;
  membership_role public.member_role;
  created_task public.tasks;
  saved_decision public.pre_render_review_member_decisions;
  original_path text;
  suffix text;
  next_path text;
begin
  if p_decision not in ('approved', 'changes_requested') or btrim(coalesce(p_member_key, '')) = '' or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Pre-render member review input is invalid' using errcode = '22023';
  end if;
  select package.* into selected_package
  from public.review_packages package
  join public.episodes episode on episode.id = package.episode_id
  join public.account_memberships membership on membership.account_id = episode.account_id and membership.user_id = auth.uid()
  where package.id = p_review_package_id and package.stage = 'production_ready' and package.invalidated_at is null
  for update of package;
  if not found then raise exception 'A current pre-render review package is required' using errcode = '22023'; end if;
  select role into membership_role from public.account_memberships membership join public.episodes episode on episode.account_id = membership.account_id where episode.id = selected_package.episode_id and membership.user_id = auth.uid();
  if membership_role is distinct from 'owner' then raise exception 'Owner membership is required to review a pre-render member' using errcode = '42501'; end if;
  select * into selected_member from public.pre_render_review_members where review_package_id = selected_package.id and member_key = btrim(p_member_key) for update;
  if not found then raise exception 'Pre-render member does not belong to this package' using errcode = '22023'; end if;

  if p_decision = 'approved' then
    insert into public.pre_render_review_member_decisions (review_package_id,member_key,decision,reason,actor_id)
    values (selected_package.id,selected_member.member_key,'approved',btrim(p_reason),auth.uid())
    on conflict (review_package_id,member_key) do update set decision = excluded.decision, reason = excluded.reason, actor_id = excluded.actor_id, inherited_from_review_package_id = null, created_at = now()
    returning * into saved_decision;
    return saved_decision;
  end if;

  select * into selected_task from public.tasks where id = selected_member.source_task_id for update;
  if selected_task.task_type = 'extract_embedded_audio' then raise exception 'Derived audio must be revised by replacing its approved source video revision' using errcode = '22023'; end if;
  if selected_task.task_type not in ('generate_a_roll', 'generate_b_roll', 'generate_narration', 'generate_soundtrack') then raise exception 'Pre-render member task type is not revisionable' using errcode = '22023'; end if;
  original_path := selected_task.input_snapshot #>> '{output,relative_path}';
  suffix := right(original_path, strpos(reverse(original_path), '.'));
  next_path := case when suffix = '' then format('%s-pre-render-v%s', original_path, selected_package.revision_number + 1) else left(original_path, length(original_path) - length(suffix)) || format('-pre-render-v%s%s', selected_package.revision_number + 1, suffix) end;
  insert into public.tasks (episode_id,task_type,status,input_snapshot,budget_limit_cents,max_attempts,provider,model,prompt_version)
  values (
    selected_task.episode_id, selected_task.task_type, 'ready',
    jsonb_set(jsonb_set(selected_task.input_snapshot || jsonb_build_object('pre_render_revision',selected_package.id::text,'review_feedback',jsonb_build_object('review_package_id',selected_package.id,'member_key',selected_member.member_key,'reason',btrim(p_reason),'actor_id',auth.uid())), '{output,relative_path}', to_jsonb(next_path), true), '{output,review_stage}', to_jsonb('production_ready'::text), true),
    selected_task.budget_limit_cents, selected_task.max_attempts, selected_task.provider, selected_task.model, selected_task.prompt_version
  ) returning * into created_task;
  insert into public.pre_render_review_member_decisions (review_package_id,member_key,decision,reason,actor_id)
  values (selected_package.id,selected_member.member_key,'changes_requested',btrim(p_reason),auth.uid())
  on conflict (review_package_id,member_key) do update set decision = excluded.decision, reason = excluded.reason, actor_id = excluded.actor_id, inherited_from_review_package_id = null, created_at = now()
  returning * into saved_decision;
  update public.review_packages set invalidated_at = now(), invalidated_reason = format('Owner requested a revision for %s.', selected_member.member_key) where id = selected_package.id;
  insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id)
  select episode.account_id, episode.id, 'pre_render_member_revision_task_created', jsonb_build_object('review_package_id',selected_package.id,'member_key',selected_member.member_key,'task_id',created_task.id,'reason',btrim(p_reason)), auth.uid()
  from public.episodes episode where episode.id = selected_package.episode_id;
  return saved_decision;
end;
$$;

revoke all on function public.create_pre_render_review_packages() from public, anon, authenticated;
grant execute on function public.create_pre_render_review_packages() to service_role;
revoke all on function public.has_required_artifacts(uuid, public.episode_stage) from public, anon, authenticated;
revoke all on function public.link_review_package_approval() from public, anon, authenticated;
revoke all on function public.review_pre_render_member(uuid, text, text, text) from public, anon;
grant execute on function public.review_pre_render_member(uuid, text, text, text) to authenticated;
revoke all on function public.transition_episode(uuid, public.episode_stage, text) from public, anon;
grant execute on function public.transition_episode(uuid, public.episode_stage, text) to authenticated;
