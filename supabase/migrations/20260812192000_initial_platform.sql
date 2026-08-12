create type public.episode_stage as enum (
  'brief_draft', 'script_draft', 'script_review', 'script_approved',
  'visual_draft', 'visual_review', 'visual_approved',
  'storyboard_draft', 'storyboard_review', 'storyboard_approved',
  'production_ready', 'render_ready', 'qc_review', 'qc_passed',
  'publish_ready', 'publishing_review', 'published', 'metrics_collecting', 'learning_recorded'
);

create type public.member_role as enum ('owner', 'worker');
create type public.task_status as enum ('ready', 'completed', 'blocked');

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  timezone text not null,
  current_blueprint_version_id uuid,
  created_at timestamptz not null default now()
);

create table public.account_blueprint_versions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  version integer not null check (version > 0),
  policy jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, version),
  unique (account_id, id)
);

alter table public.accounts
  add constraint accounts_current_blueprint_version_fk
  foreign key (id, current_blueprint_version_id)
  references public.account_blueprint_versions(account_id, id);

create table public.account_memberships (
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  primary key (account_id, user_id)
);

create table public.episodes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  blueprint_version_id uuid not null,
  title text not null check (char_length(trim(title)) > 0),
  stage public.episode_stage not null default 'brief_draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.episodes
  add constraint episodes_blueprint_belongs_to_account_fk
  foreign key (account_id, blueprint_version_id)
  references public.account_blueprint_versions(account_id, id)
  on delete restrict;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  task_type text not null check (task_type in ('draft_brief')),
  status public.task_status not null default 'ready',
  input_snapshot jsonb not null default '{}'::jsonb,
  budget_limit_cents integer check (budget_limit_cents is null or budget_limit_cents >= 0),
  max_attempts integer not null default 1 check (max_attempts > 0),
  created_at timestamptz not null default now()
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  artifact_type text not null,
  relative_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_size bigint not null check (file_size >= 0),
  producer_task_id uuid references public.tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (episode_id, artifact_type, relative_path)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  stage public.episode_stage not null,
  decision text not null check (decision in ('approved', 'changes_requested')),
  reason text not null check (char_length(trim(reason)) > 0),
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.state_transitions (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  from_stage public.episode_stage,
  to_stage public.episode_stage not null,
  reason text not null,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  episode_id uuid references public.episodes(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.experiments (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null unique references public.episodes(id) on delete cascade,
  hypothesis text not null,
  primary_metric text not null,
  guardrail_metrics text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  captured_at timestamptz not null,
  metrics jsonb not null,
  captured_by uuid not null references auth.users(id) on delete restrict,
  unique (episode_id, captured_at)
);

create table public.asset_locks (
  resource_key text primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index episodes_account_stage_idx on public.episodes(account_id, stage, updated_at desc);
create index tasks_episode_status_idx on public.tasks(episode_id, status);
create index artifacts_episode_idx on public.artifacts(episode_id);
create index audit_events_episode_idx on public.audit_events(episode_id, created_at desc);

alter table public.accounts enable row level security;
alter table public.account_blueprint_versions enable row level security;
alter table public.account_memberships enable row level security;
alter table public.episodes enable row level security;
alter table public.tasks enable row level security;
alter table public.artifacts enable row level security;
alter table public.approvals enable row level security;
alter table public.state_transitions enable row level security;
alter table public.audit_events enable row level security;
alter table public.experiments enable row level security;
alter table public.metric_snapshots enable row level security;
alter table public.asset_locks enable row level security;

create function public.is_account_member(target_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.account_memberships
    where account_id = target_account_id and user_id = auth.uid()
  );
$$;

create policy "members can read their accounts" on public.accounts for select using (public.is_account_member(id));
create policy "members can read blueprints" on public.account_blueprint_versions for select using (public.is_account_member(account_id));
create policy "members can read memberships" on public.account_memberships for select using (public.is_account_member(account_id));
create policy "members can read episodes" on public.episodes for select using (public.is_account_member(account_id));
create policy "members can read tasks" on public.tasks for select using (exists (select 1 from public.episodes where episodes.id = tasks.episode_id and public.is_account_member(episodes.account_id)));
create policy "members can read artifacts" on public.artifacts for select using (exists (select 1 from public.episodes where episodes.id = artifacts.episode_id and public.is_account_member(episodes.account_id)));
create policy "members can read approvals" on public.approvals for select using (exists (select 1 from public.episodes where episodes.id = approvals.episode_id and public.is_account_member(episodes.account_id)));
create policy "members can read transitions" on public.state_transitions for select using (exists (select 1 from public.episodes where episodes.id = state_transitions.episode_id and public.is_account_member(episodes.account_id)));
create policy "members can read audit events" on public.audit_events for select using (public.is_account_member(account_id));
create policy "members can read experiments" on public.experiments for select using (exists (select 1 from public.episodes where episodes.id = experiments.episode_id and public.is_account_member(episodes.account_id)));
create policy "members can read metric snapshots" on public.metric_snapshots for select using (exists (select 1 from public.episodes where episodes.id = metric_snapshots.episode_id and public.is_account_member(episodes.account_id)));
create policy "members can read asset locks" on public.asset_locks for select using (exists (select 1 from public.episodes where episodes.id = asset_locks.episode_id and public.is_account_member(episodes.account_id)));

create function public.is_allowed_episode_transition(from_stage public.episode_stage, to_stage public.episode_stage)
returns boolean
language sql
immutable
as $$
  select (from_stage, to_stage) in (
    ('brief_draft'::public.episode_stage, 'script_draft'::public.episode_stage),
    ('script_draft'::public.episode_stage, 'script_review'::public.episode_stage),
    ('script_review'::public.episode_stage, 'script_draft'::public.episode_stage),
    ('script_review'::public.episode_stage, 'script_approved'::public.episode_stage),
    ('script_approved'::public.episode_stage, 'visual_draft'::public.episode_stage),
    ('visual_draft'::public.episode_stage, 'visual_review'::public.episode_stage),
    ('visual_review'::public.episode_stage, 'visual_draft'::public.episode_stage),
    ('visual_review'::public.episode_stage, 'visual_approved'::public.episode_stage),
    ('visual_approved'::public.episode_stage, 'storyboard_draft'::public.episode_stage),
    ('storyboard_draft'::public.episode_stage, 'storyboard_review'::public.episode_stage),
    ('storyboard_review'::public.episode_stage, 'storyboard_draft'::public.episode_stage),
    ('storyboard_review'::public.episode_stage, 'storyboard_approved'::public.episode_stage),
    ('storyboard_approved'::public.episode_stage, 'production_ready'::public.episode_stage),
    ('production_ready'::public.episode_stage, 'render_ready'::public.episode_stage),
    ('render_ready'::public.episode_stage, 'qc_review'::public.episode_stage),
    ('qc_review'::public.episode_stage, 'render_ready'::public.episode_stage),
    ('qc_review'::public.episode_stage, 'qc_passed'::public.episode_stage),
    ('qc_passed'::public.episode_stage, 'publish_ready'::public.episode_stage),
    ('publish_ready'::public.episode_stage, 'publishing_review'::public.episode_stage),
    ('publishing_review'::public.episode_stage, 'publish_ready'::public.episode_stage),
    ('publishing_review'::public.episode_stage, 'published'::public.episode_stage),
    ('published'::public.episode_stage, 'metrics_collecting'::public.episode_stage),
    ('metrics_collecting'::public.episode_stage, 'learning_recorded'::public.episode_stage)
  );
$$;

create function public.has_required_artifacts(p_episode_id uuid, p_to_stage public.episode_stage)
returns boolean
language sql
stable
set search_path = public
as $$
  select case p_to_stage
    when 'script_approved'::public.episode_stage then exists (
      select 1 from public.artifacts
      where episode_id = p_episode_id and artifact_type = 'script'
    )
    when 'visual_approved'::public.episode_stage then exists (
      select 1 from public.artifacts
      where episode_id = p_episode_id and artifact_type = 'visual_brief'
    )
    when 'storyboard_approved'::public.episode_stage then exists (
      select 1 from public.artifacts
      where episode_id = p_episode_id and artifact_type = 'storyboard'
    )
    when 'qc_passed'::public.episode_stage then exists (
      select 1 from public.artifacts
      where episode_id = p_episode_id and artifact_type = 'render'
    )
    else true
  end;
$$;

create function public.create_episode(p_account_id uuid, p_blueprint_version_id uuid, p_title text)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
declare
  created_episode public.episodes;
  membership_role public.member_role;
begin
  select role into membership_role from public.account_memberships
  where account_id = p_account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to create an episode' using errcode = '42501';
  end if;
  insert into public.episodes (account_id, blueprint_version_id, title)
  values (p_account_id, p_blueprint_version_id, p_title)
  returning * into created_episode;
  insert into public.tasks (episode_id, task_type, input_snapshot)
  values (created_episode.id, 'draft_brief', jsonb_build_object('account_id', p_account_id, 'blueprint_version_id', p_blueprint_version_id));
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (p_account_id, created_episode.id, 'episode_created', jsonb_build_object('blueprint_version_id', p_blueprint_version_id), auth.uid());
  return created_episode;
end;
$$;

create function public.transition_episode(p_episode_id uuid, p_to_stage public.episode_stage, p_reason text)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
declare
  current_episode public.episodes;
  previous_stage public.episode_stage;
  membership_role public.member_role;
  owner_only_stages public.episode_stage[] := array[
    'script_approved', 'visual_approved', 'storyboard_approved', 'qc_passed', 'publish_ready', 'published'
  ]::public.episode_stage[];
begin
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
  if p_to_stage = any(owner_only_stages) and membership_role <> 'owner' then
    raise exception 'Owner approval is required for %', p_to_stage using errcode = '42501';
  end if;
  if not public.has_required_artifacts(p_episode_id, p_to_stage) then
    raise exception 'Required artifacts are missing for %', p_to_stage using errcode = '22023';
  end if;
  previous_stage := current_episode.stage;
  update public.episodes set stage = p_to_stage, updated_at = now() where id = p_episode_id returning * into current_episode;
  insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
  values (p_episode_id, previous_stage, p_to_stage, p_reason, auth.uid());
  if p_to_stage = any(owner_only_stages) then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id)
    values (p_episode_id, p_to_stage, 'approved', p_reason, auth.uid());
  elsif previous_stage in ('script_review', 'visual_review', 'storyboard_review', 'qc_review', 'publishing_review') then
    insert into public.approvals (episode_id, stage, decision, reason, actor_id)
    values (p_episode_id, previous_stage, 'changes_requested', p_reason, auth.uid());
  end if;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (current_episode.account_id, p_episode_id, 'stage_transition', jsonb_build_object('to_stage', p_to_stage, 'reason', p_reason), auth.uid());
  return current_episode;
end;
$$;
