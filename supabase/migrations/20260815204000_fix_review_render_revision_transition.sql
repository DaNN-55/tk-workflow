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

  select package.* into selected_package
  from public.review_packages package
  where package.id = p_review_package_id
    and package.stage = 'qc_review'
    and package.invalidated_at is null
    and package.context_snapshot ->> 'review_kind' = 'hyperframes_review_render';
  if not found then
    raise exception 'Current HyperFrames review package is required' using errcode = '22023';
  end if;

  select * into selected_episode from public.episodes
  where id = selected_package.episode_id for update;
  if selected_episode.stage <> 'qc_review' or exists (
    select 1 from public.review_packages package
    where package.episode_id = selected_episode.id and package.stage = 'qc_review'
      and package.invalidated_at is null and package.revision_number > selected_package.revision_number
  ) then
    raise exception 'Review render package is no longer current' using errcode = '22023';
  end if;
  select role into membership_role from public.account_memberships
  where account_id = selected_episode.account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to adjust a review render' using errcode = '42501';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_revision
  from public.review_render_composition_revisions
  where pre_render_review_package_id = (selected_package.context_snapshot ->> 'pre_render_review_package_id')::uuid;
  insert into public.review_render_composition_revisions (
    episode_id, pre_render_review_package_id, revision_number, caption_style, pacing, crop, transition, layout, reason, created_by
  ) values (
    selected_episode.id, (selected_package.context_snapshot ->> 'pre_render_review_package_id')::uuid, next_revision,
    p_caption_style, p_pacing, p_crop, p_transition, p_layout, btrim(p_reason), auth.uid()
  );

  update public.episodes set stage = 'render_ready', updated_at = now() where id = selected_episode.id returning * into selected_episode;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (selected_episode.id, 'qc_review', 'render_ready', btrim(p_reason), auth.uid());
  insert into public.approvals (episode_id, stage, decision, reason, actor_id, review_package_id)
  values (selected_episode.id, 'qc_review', 'changes_requested', btrim(p_reason), auth.uid(), selected_package.id);
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (selected_episode.account_id, selected_episode.id, 'review_render_composition_requested', jsonb_build_object(
    'review_package_id', p_review_package_id, 'revision_number', next_revision,
    'caption_style', p_caption_style, 'pacing', p_pacing, 'crop', p_crop, 'transition', p_transition, 'layout', p_layout
  ), auth.uid());
  return selected_episode;
end;
$$;

revoke all on function public.request_review_render_revision(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_review_render_revision(uuid, text, text, text, text, text, text) to authenticated;
