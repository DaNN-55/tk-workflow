create or replace function public.transition_episode(p_episode_id uuid, p_to_stage public.episode_stage, p_reason text)
returns public.episodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_episode public.episodes;
  previous_stage public.episode_stage;
  membership_role public.member_role;
  owner_approval_stages public.episode_stage[] := array[
    'script_approved', 'visual_approved', 'storyboard_approved', 'qc_passed', 'publish_ready', 'published'
  ]::public.episode_stage[];
  review_stages public.episode_stage[] := array[
    'script_review', 'visual_review', 'storyboard_review', 'qc_review', 'publishing_review'
  ]::public.episode_stage[];
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A transition reason is required' using errcode = '22023';
  end if;

  select * into current_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  if not public.is_allowed_episode_transition(current_episode.stage, p_to_stage) then
    raise exception 'Invalid transition from % to %', current_episode.stage, p_to_stage using errcode = '22023';
  end if;
  select role into membership_role from public.account_memberships where account_id = current_episode.account_id and user_id = auth.uid();
  if membership_role is null then
    raise exception 'No membership for this account' using errcode = '42501';
  end if;
  if (p_to_stage = any(owner_approval_stages) or current_episode.stage = any(review_stages)) and membership_role <> 'owner' then
    raise exception 'Owner approval is required for this review decision' using errcode = '42501';
  end if;
  if not public.has_required_artifacts(p_episode_id, p_to_stage) then
    raise exception 'Required artifacts are missing for %', p_to_stage using errcode = '22023';
  end if;
  previous_stage := current_episode.stage;
  update public.episodes set stage = p_to_stage, updated_at = now() where id = p_episode_id returning * into current_episode;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (p_episode_id, previous_stage, p_to_stage, btrim(p_reason), auth.uid());
  if p_to_stage = any(owner_approval_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id)
    values (p_episode_id, p_to_stage, 'approved', btrim(p_reason), auth.uid());
  elsif previous_stage = any(review_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id)
    values (p_episode_id, previous_stage, 'changes_requested', btrim(p_reason), auth.uid());
  end if;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (current_episode.account_id, p_episode_id, 'stage_transition', jsonb_build_object('to_stage', p_to_stage, 'reason', btrim(p_reason)), auth.uid());
  return current_episode;
end;
$$;
