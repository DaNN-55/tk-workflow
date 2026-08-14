create table public.learning_reports (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null unique references public.episodes(id) on delete cascade,
  recommendation text not null check (recommendation in ('keep', 'change', 'kill', 'insufficient_data')),
  summary text not null check (char_length(btrim(summary)) > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.blueprint_change_suggestions (
  id uuid primary key default gen_random_uuid(),
  learning_report_id uuid not null references public.learning_reports(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  source_blueprint_version_id uuid not null references public.account_blueprint_versions(id) on delete restrict,
  proposed_policy jsonb not null check (jsonb_typeof(proposed_policy) = 'object'),
  rationale text not null check (char_length(btrim(rationale)) > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decision_reason text,
  proposed_blueprint_version_id uuid references public.account_blueprint_versions(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'pending' and decision_reason is null and reviewed_by is null and reviewed_at is null and proposed_blueprint_version_id is null)
    or (status = 'approved' and char_length(btrim(decision_reason)) > 0 and reviewed_by is not null and reviewed_at is not null and proposed_blueprint_version_id is not null)
    or (status = 'rejected' and char_length(btrim(decision_reason)) > 0 and reviewed_by is not null and reviewed_at is not null and proposed_blueprint_version_id is null))
);

create index learning_reports_episode_idx on public.learning_reports(episode_id);
create index blueprint_change_suggestions_account_status_idx on public.blueprint_change_suggestions(account_id, status, created_at desc);

alter table public.learning_reports enable row level security;
alter table public.blueprint_change_suggestions enable row level security;

create policy "members can read learning reports" on public.learning_reports for select using (
  exists (
    select 1 from public.episodes
    where episodes.id = learning_reports.episode_id and public.is_account_member(episodes.account_id)
  )
);

create policy "members can read blueprint change suggestions" on public.blueprint_change_suggestions for select using (public.is_account_member(account_id));

create function public.record_learning_report(
  p_episode_id uuid,
  p_recommendation text,
  p_summary text
)
returns public.learning_reports
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_episode public.episodes;
  membership_role public.member_role;
  saved_report public.learning_reports;
begin
  select * into target_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  select role into membership_role from public.account_memberships where account_id = target_episode.account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to record a learning report' using errcode = '42501';
  end if;
  if target_episode.stage <> 'metrics_collecting'::public.episode_stage then
    raise exception 'Learning reports can only be recorded while metrics are being collected' using errcode = '22023';
  end if;
  if p_recommendation not in ('keep', 'change', 'kill', 'insufficient_data') then
    raise exception 'Learning report recommendation is invalid' using errcode = '22023';
  end if;
  if coalesce(btrim(p_summary), '') = '' then
    raise exception 'Learning report summary is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.experiments where episode_id = p_episode_id)
    or not exists (select 1 from public.metric_snapshots where episode_id = p_episode_id) then
    raise exception 'An experiment and at least one weekly metric snapshot are required before recording a learning report' using errcode = '22023';
  end if;

  insert into public.learning_reports (episode_id, recommendation, summary, created_by)
  values (p_episode_id, p_recommendation, btrim(p_summary), auth.uid())
  returning * into saved_report;
  update public.episodes set stage = 'learning_recorded'::public.episode_stage, updated_at = now() where id = p_episode_id;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (p_episode_id, 'metrics_collecting'::public.episode_stage, 'learning_recorded'::public.episode_stage, 'Owner recorded learning report', auth.uid());
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (target_episode.account_id, p_episode_id, 'learning_report_recorded', jsonb_build_object('learning_report_id', saved_report.id, 'recommendation', p_recommendation), auth.uid());
  return saved_report;
end;
$$;

create function public.create_blueprint_change_suggestion(
  p_learning_report_id uuid,
  p_proposed_policy jsonb,
  p_rationale text
)
returns public.blueprint_change_suggestions
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_report public.learning_reports;
  target_episode public.episodes;
  membership_role public.member_role;
  saved_suggestion public.blueprint_change_suggestions;
begin
  select * into target_report from public.learning_reports where id = p_learning_report_id;
  if not found then
    raise exception 'Learning report % does not exist', p_learning_report_id using errcode = 'P0002';
  end if;
  select * into target_episode from public.episodes where id = target_report.episode_id;
  select role into membership_role from public.account_memberships where account_id = target_episode.account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to create a blueprint change suggestion' using errcode = '42501';
  end if;
  if jsonb_typeof(p_proposed_policy) <> 'object' then
    raise exception 'Proposed blueprint policy must be a JSON object' using errcode = '22023';
  end if;
  if coalesce(btrim(p_rationale), '') = '' then
    raise exception 'Blueprint change rationale is required' using errcode = '22023';
  end if;

  insert into public.blueprint_change_suggestions (learning_report_id, account_id, source_blueprint_version_id, proposed_policy, rationale, created_by)
  values (target_report.id, target_episode.account_id, target_episode.blueprint_version_id, p_proposed_policy, btrim(p_rationale), auth.uid())
  returning * into saved_suggestion;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (target_episode.account_id, target_episode.id, 'blueprint_change_suggested', jsonb_build_object('blueprint_change_suggestion_id', saved_suggestion.id, 'learning_report_id', target_report.id), auth.uid());
  return saved_suggestion;
end;
$$;

create function public.review_blueprint_change_suggestion(
  p_suggestion_id uuid,
  p_decision text,
  p_decision_reason text
)
returns public.blueprint_change_suggestions
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_suggestion public.blueprint_change_suggestions;
  membership_role public.member_role;
  next_version integer;
  activated_blueprint public.account_blueprint_versions;
begin
  select * into target_suggestion from public.blueprint_change_suggestions where id = p_suggestion_id for update;
  if not found then
    raise exception 'Blueprint change suggestion % does not exist', p_suggestion_id using errcode = 'P0002';
  end if;
  select role into membership_role from public.account_memberships where account_id = target_suggestion.account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to review a blueprint change suggestion' using errcode = '42501';
  end if;
  if target_suggestion.status <> 'pending' then
    raise exception 'Blueprint change suggestion has already been reviewed' using errcode = '22023';
  end if;
  if p_decision not in ('approved', 'rejected') or coalesce(btrim(p_decision_reason), '') = '' then
    raise exception 'A valid decision and non-blank reason are required' using errcode = '22023';
  end if;

  if p_decision = 'approved' then
    select coalesce(max(version), 0) + 1 into next_version from public.account_blueprint_versions where account_id = target_suggestion.account_id;
    update public.account_blueprint_versions set is_active = false where account_id = target_suggestion.account_id and is_active;
    insert into public.account_blueprint_versions (account_id, version, policy, is_active)
    values (target_suggestion.account_id, next_version, target_suggestion.proposed_policy, true)
    returning * into activated_blueprint;
    update public.accounts set current_blueprint_version_id = activated_blueprint.id where id = target_suggestion.account_id;
    update public.blueprint_change_suggestions
    set status = 'approved', decision_reason = btrim(p_decision_reason), proposed_blueprint_version_id = activated_blueprint.id, reviewed_by = auth.uid(), reviewed_at = now()
    where id = target_suggestion.id
    returning * into target_suggestion;
    insert into public.audit_events (account_id, event_type, payload, actor_id)
    values (target_suggestion.account_id, 'blueprint_change_approved', jsonb_build_object('blueprint_change_suggestion_id', target_suggestion.id, 'blueprint_version_id', activated_blueprint.id, 'version', next_version), auth.uid());
  else
    update public.blueprint_change_suggestions
    set status = 'rejected', decision_reason = btrim(p_decision_reason), reviewed_by = auth.uid(), reviewed_at = now()
    where id = target_suggestion.id
    returning * into target_suggestion;
    insert into public.audit_events (account_id, event_type, payload, actor_id)
    values (target_suggestion.account_id, 'blueprint_change_rejected', jsonb_build_object('blueprint_change_suggestion_id', target_suggestion.id), auth.uid());
  end if;
  return target_suggestion;
end;
$$;

revoke execute on function public.record_learning_report(uuid, text, text) from public, anon;
revoke execute on function public.create_blueprint_change_suggestion(uuid, jsonb, text) from public, anon;
revoke execute on function public.review_blueprint_change_suggestion(uuid, text, text) from public, anon;
grant select on public.learning_reports, public.blueprint_change_suggestions to authenticated;
grant execute on function public.record_learning_report(uuid, text, text) to authenticated;
grant execute on function public.create_blueprint_change_suggestion(uuid, jsonb, text) to authenticated;
grant execute on function public.review_blueprint_change_suggestion(uuid, text, text) to authenticated;
