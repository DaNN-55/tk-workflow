create table public.series (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  unique (account_id, name),
  unique (account_id, id)
);

create table public.series_versions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  series_id uuid not null,
  version integer not null check (version > 0),
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (series_id, version),
  unique (account_id, id),
  foreign key (account_id, series_id) references public.series(account_id, id) on delete cascade
);

alter table public.episodes
  drop constraint episodes_title_check,
  add column series_version_id uuid,
  add column main_script_revision_id uuid,
  add constraint episodes_series_version_belongs_to_account_fk
    foreign key (account_id, series_version_id)
    references public.series_versions(account_id, id)
    on delete restrict;

alter table public.episodes alter column stage set default 'waiting_input';

create table public.production_material_revisions (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  material_type text not null check (char_length(trim(material_type)) > 0),
  source_kind text not null check (source_kind in ('directory', 'file', 'paste')),
  source_path text not null check (char_length(trim(source_path)) > 0),
  storage_path text not null check (char_length(trim(storage_path)) > 0),
  mime_type text not null check (char_length(trim(mime_type)) > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_size bigint not null check (file_size >= 0),
  is_main_script boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (episode_id, material_type, revision_number),
  unique (episode_id, id)
);

alter table public.episodes
  add constraint episodes_main_script_revision_fk
  foreign key (id, main_script_revision_id)
  references public.production_material_revisions(episode_id, id)
  on delete restrict;

create index series_account_idx on public.series(account_id, created_at);
create index series_versions_series_idx on public.series_versions(series_id, version desc);
create index episodes_series_version_idx on public.episodes(series_version_id, updated_at desc);
create index production_material_revisions_episode_idx on public.production_material_revisions(episode_id, created_at desc);

alter table public.series enable row level security;
alter table public.series_versions enable row level security;
alter table public.production_material_revisions enable row level security;

create policy "members can read series" on public.series
for select to authenticated
using (public.is_account_member(account_id));

create policy "members can read series versions" on public.series_versions
for select to authenticated
using (public.is_account_member(account_id));

create policy "members can read production material revisions" on public.production_material_revisions
for select to authenticated
using (
  exists (
    select 1
    from public.episodes
    where episodes.id = production_material_revisions.episode_id
      and public.is_account_member(episodes.account_id)
  )
);

drop function public.create_episode(uuid, uuid, text);

create function public.create_episode(
  p_account_id uuid,
  p_blueprint_version_id uuid,
  p_series_version_id uuid,
  p_title text
)
returns public.episodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_episode public.episodes;
  membership_role public.member_role;
begin
  select role into membership_role
  from public.account_memberships
  where account_id = p_account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to create an episode' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.accounts account
    join public.account_blueprint_versions blueprint
      on blueprint.account_id = account.id
     and blueprint.id = account.current_blueprint_version_id
     and blueprint.is_active
    where account.id = p_account_id and blueprint.id = p_blueprint_version_id
  ) then
    raise exception 'Episode blueprint must be the account active blueprint' using errcode = '22023';
  end if;
  if p_series_version_id is not null and not exists (
    select 1 from public.series_versions
    where account_id = p_account_id and id = p_series_version_id
  ) then
    raise exception 'Series version must belong to the episode account' using errcode = '22023';
  end if;

  insert into public.episodes (account_id, blueprint_version_id, series_version_id, title, stage)
  values (p_account_id, p_blueprint_version_id, p_series_version_id, coalesce(p_title, ''), 'waiting_input')
  returning * into created_episode;

  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    p_account_id,
    created_episode.id,
    'episode_created',
    jsonb_build_object('blueprint_version_id', p_blueprint_version_id, 'series_version_id', p_series_version_id),
    auth.uid()
  );
  return created_episode;
end;
$$;

create function public.update_episode_title(p_episode_id uuid, p_title text)
returns public.episodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_episode public.episodes;
begin
  if not exists (
    select 1
    from public.episodes episode
    join public.account_memberships membership on membership.account_id = episode.account_id
    where episode.id = p_episode_id and membership.user_id = auth.uid() and membership.role = 'owner'
  ) then
    raise exception 'Owner membership is required to update an episode title' using errcode = '42501';
  end if;

  update public.episodes
  set title = coalesce(p_title, ''), updated_at = now()
  where id = p_episode_id
  returning * into updated_episode;
  return updated_episode;
end;
$$;

create function public.import_production_material(
  p_episode_id uuid,
  p_material_type text,
  p_source_kind text,
  p_source_path text,
  p_storage_path text,
  p_mime_type text,
  p_sha256 text,
  p_file_size bigint,
  p_is_main_script boolean
)
returns public.production_material_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_revision public.production_material_revisions;
  current_episode public.episodes;
  next_revision integer;
begin
  select episode.* into current_episode
  from public.episodes episode
  join public.account_memberships membership on membership.account_id = episode.account_id
  where episode.id = p_episode_id and membership.user_id = auth.uid() and membership.role = 'owner'
  for update of episode;
  if not found then
    raise exception 'Owner membership is required to import production material' using errcode = '42501';
  end if;
  if p_is_main_script and trim(p_material_type) <> 'script' then
    raise exception 'Main script material must have script type' using errcode = '22023';
  end if;
  if p_storage_path !~ ('^episodes/' || p_episode_id::text || '/materials/[0-9a-f]{64}-[^/]+$') then
    raise exception 'Material storage path is outside the episode material directory' using errcode = '22023';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_revision
  from public.production_material_revisions
  where episode_id = p_episode_id and material_type = trim(p_material_type);

  insert into public.production_material_revisions (
    episode_id, revision_number, material_type, source_kind, source_path, storage_path,
    mime_type, sha256, file_size, is_main_script, created_by
  ) values (
    p_episode_id, next_revision, trim(p_material_type), p_source_kind, trim(p_source_path),
    p_storage_path, p_mime_type, p_sha256, p_file_size, p_is_main_script, auth.uid()
  ) returning * into created_revision;

  if p_is_main_script then
    update public.episodes
    set main_script_revision_id = created_revision.id,
        stage = case when stage = 'waiting_input' then 'script_approved' else stage end,
        updated_at = now()
    where id = p_episode_id;
    if current_episode.stage = 'waiting_input' then
      insert into public.state_transitions (episode_id, from_stage, to_stage, reason, actor_id)
      values (p_episode_id, 'waiting_input', 'script_approved', 'Owner confirmed an imported main script revision.', auth.uid());
    end if;
  end if;

  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (
    current_episode.account_id,
    p_episode_id,
    'production_material_imported',
    jsonb_build_object(
      'material_revision_id', created_revision.id,
      'material_type', created_revision.material_type,
      'sha256', created_revision.sha256,
      'source_kind', created_revision.source_kind,
      'is_main_script', created_revision.is_main_script
    ),
    auth.uid()
  );
  return created_revision;
end;
$$;

create function public.create_series(p_account_id uuid, p_name text, p_rules jsonb)
returns public.series_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_series public.series;
  created_version public.series_versions;
begin
  if not exists (
    select 1 from public.account_memberships
    where account_id = p_account_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Owner membership is required to create a series' using errcode = '42501';
  end if;
  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Series name is required' using errcode = '22023';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then
    raise exception 'Series rules must be a JSON object' using errcode = '22023';
  end if;

  insert into public.series (account_id, name)
  values (p_account_id, trim(p_name))
  returning * into created_series;

  insert into public.series_versions (series_id, account_id, version, rules, created_by)
  values (created_series.id, p_account_id, 1, p_rules, auth.uid())
  returning * into created_version;

  insert into public.audit_events (account_id, event_type, payload, actor_id)
  values (
    p_account_id,
    'series_created',
    jsonb_build_object('series_id', created_series.id, 'series_version_id', created_version.id, 'version', 1),
    auth.uid()
  );
  return created_version;
end;
$$;

revoke all on public.series, public.series_versions, public.production_material_revisions from anon, authenticated;
grant select on public.series, public.series_versions, public.production_material_revisions to authenticated;

revoke execute on function public.create_series(uuid, text, jsonb) from public, anon;
revoke execute on function public.create_episode(uuid, uuid, uuid, text) from public, anon;
revoke execute on function public.update_episode_title(uuid, text) from public, anon;
revoke execute on function public.import_production_material(uuid, text, text, text, text, text, text, bigint, boolean) from public, anon;
grant execute on function public.create_episode(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.create_series(uuid, text, jsonb) to authenticated;
grant execute on function public.update_episode_title(uuid, text) to authenticated;
grant execute on function public.import_production_material(uuid, text, text, text, text, text, text, bigint, boolean) to authenticated;
