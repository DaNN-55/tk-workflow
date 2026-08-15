alter table public.tasks
  add column invalidated_at timestamptz,
  add column invalidated_reason text,
  add constraint tasks_invalidation_reason_check check ((invalidated_at is null and invalidated_reason is null) or (invalidated_at is not null and btrim(coalesce(invalidated_reason, '')) <> ''));

create table public.production_dependencies (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  upstream_kind text not null check (upstream_kind in ('material_revision', 'series_version', 'review_package')),
  upstream_id uuid not null,
  downstream_kind text not null check (downstream_kind in ('task', 'review_package')),
  downstream_id uuid not null,
  created_at timestamptz not null default now(),
  unique (upstream_kind, upstream_id, downstream_kind, downstream_id)
);

create index production_dependencies_upstream_idx on public.production_dependencies (upstream_kind, upstream_id, episode_id);

create table public.production_invalidations (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  upstream_kind text not null check (upstream_kind in ('material_revision', 'series_version', 'review_package')),
  upstream_id uuid not null,
  target_kind text not null check (target_kind in ('task', 'review_package', 'approval')),
  target_id uuid not null,
  reason text not null check (btrim(reason) <> ''),
  created_at timestamptz not null default now(),
  unique (upstream_kind, upstream_id, target_kind, target_id)
);

create index production_invalidations_episode_idx on public.production_invalidations (episode_id, created_at desc);

alter table public.production_dependencies enable row level security;
alter table public.production_invalidations enable row level security;

create policy "members can read production dependencies" on public.production_dependencies for select to authenticated
using (exists (select 1 from public.episodes episode where episode.id = production_dependencies.episode_id and public.is_account_member(episode.account_id)));

create policy "members can read production invalidations" on public.production_invalidations for select to authenticated
using (exists (select 1 from public.episodes episode where episode.id = production_invalidations.episode_id and public.is_account_member(episode.account_id)));

grant select on public.production_dependencies, public.production_invalidations to authenticated;

create function public.record_pre_render_member_dependencies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  package public.review_packages;
  source_task public.tasks;
  source_input jsonb;
  material public.production_material_revisions;
  series_version_id uuid;
begin
  select * into package from public.review_packages where id = new.review_package_id;
  select * into source_task from public.tasks where id = new.source_task_id;
  if not found then raise exception 'Pre-render member source task is missing' using errcode = '22023'; end if;
  if coalesce(package.context_snapshot ->> 'storyboard_review_package_id', '') <> '' then
    insert into public.production_dependencies (episode_id,upstream_kind,upstream_id,downstream_kind,downstream_id)
    values (package.episode_id,'review_package',(package.context_snapshot ->> 'storyboard_review_package_id')::uuid,'review_package',package.id)
    on conflict do nothing;
  end if;
  for source_input in select value from jsonb_array_elements(coalesce(source_task.input_snapshot -> 'input_artifacts','[]'::jsonb)) loop
    select revision.* into material
    from public.production_material_revisions revision
    where revision.episode_id = package.episode_id
      and revision.storage_path = source_input ->> 'relativePath'
      and revision.sha256 = source_input ->> 'sha256'
    limit 1;
    if found then
      insert into public.production_dependencies (episode_id,upstream_kind,upstream_id,downstream_kind,downstream_id)
      values (package.episode_id,'material_revision',material.id,'task',source_task.id), (package.episode_id,'material_revision',material.id,'review_package',package.id)
      on conflict do nothing;
    end if;
  end loop;
  if coalesce(source_task.input_snapshot #>> '{series_baseline,version_id}', '') <> '' then
    series_version_id := (source_task.input_snapshot #>> '{series_baseline,version_id}')::uuid;
    insert into public.production_dependencies (episode_id,upstream_kind,upstream_id,downstream_kind,downstream_id)
    values (package.episode_id,'series_version',series_version_id,'task',source_task.id), (package.episode_id,'series_version',series_version_id,'review_package',package.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger record_pre_render_member_dependencies_after_insert
after insert on public.pre_render_review_members
for each row execute function public.record_pre_render_member_dependencies();

create function public.invalidate_dependent_production_work(p_upstream_kind text, p_upstream_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  dependency public.production_dependencies;
  source_task public.tasks;
  candidate_rank integer;
  episode_candidate record;
  target_stage public.episode_stage;
  approval public.approvals;
begin
  if p_upstream_kind not in ('material_revision', 'series_version', 'review_package') or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Production invalidation input is invalid' using errcode = '22023';
  end if;
  for dependency in select * from public.production_dependencies where upstream_kind = p_upstream_kind and upstream_id = p_upstream_id loop
    insert into public.production_invalidations (episode_id,upstream_kind,upstream_id,target_kind,target_id,reason)
    values (dependency.episode_id,p_upstream_kind,p_upstream_id,dependency.downstream_kind,dependency.downstream_id,btrim(p_reason))
    on conflict do nothing;
    if dependency.downstream_kind = 'task' then
      update public.tasks set invalidated_at = now(), invalidated_reason = btrim(p_reason) where id = dependency.downstream_id and invalidated_at is null;
      select * into source_task from public.tasks where id = dependency.downstream_id;
      candidate_rank := case
        when source_task.task_type = 'prepare_visual_brief' then 1
        when source_task.task_type = 'draft_storyboard' then 2
        else 3
      end;
    else
      update public.review_packages set invalidated_at = now(), invalidated_reason = btrim(p_reason) where id = dependency.downstream_id and invalidated_at is null;
      candidate_rank := 3;
      for approval in select * from public.approvals where review_package_id = dependency.downstream_id loop
        insert into public.production_invalidations (episode_id,upstream_kind,upstream_id,target_kind,target_id,reason)
        values (dependency.episode_id,p_upstream_kind,p_upstream_id,'approval',approval.id,btrim(p_reason))
        on conflict do nothing;
      end loop;
    end if;
  end loop;
  for episode_candidate in
    select episode.*, min(case when task.task_type = 'prepare_visual_brief' then 1 when task.task_type = 'draft_storyboard' then 2 else 3 end) as earliest_rank
    from public.episodes episode
    join public.production_dependencies candidate on candidate.episode_id = episode.id
    left join public.tasks task on candidate.downstream_kind = 'task' and task.id = candidate.downstream_id
    where candidate.upstream_kind = p_upstream_kind and candidate.upstream_id = p_upstream_id
    group by episode.id
  loop
    target_stage := case episode_candidate.earliest_rank when 1 then 'visual_draft'::public.episode_stage when 2 then 'storyboard_draft'::public.episode_stage else 'production_ready'::public.episode_stage end;
    if episode_candidate.stage <> target_stage then
      update public.episodes set stage = target_stage, updated_at = now() where id = episode_candidate.id;
      insert into public.state_transitions (episode_id,from_stage,to_stage,reason,actor_id) values (episode_candidate.id,episode_candidate.stage,target_stage,btrim(p_reason),null);
      insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id) values (episode_candidate.account_id,episode_candidate.id,'production_dependencies_invalidated',jsonb_build_object('upstream_kind',p_upstream_kind,'upstream_id',p_upstream_id,'to_stage',target_stage,'reason',btrim(p_reason)),null);
    end if;
  end loop;
end;
$$;

create function public.invalidate_replaced_material_dependents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare previous_revision public.production_material_revisions;
begin
  select * into previous_revision
  from public.production_material_revisions revision
  where revision.episode_id = new.episode_id
    and revision.material_type = new.material_type
    and revision.source_path = new.source_path
    and revision.id <> new.id
  order by revision.revision_number desc
  limit 1;
  if found then
    perform public.invalidate_dependent_production_work('material_revision',previous_revision.id,'A newer revision replaced an upstream production material.');
  end if;
  return new;
end;
$$;

create trigger invalidate_replaced_material_dependents_after_insert
after insert on public.production_material_revisions
for each row execute function public.invalidate_replaced_material_dependents();

create function public.invalidate_changed_series_baseline_dependents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.rules is distinct from old.rules then
    perform public.invalidate_dependent_production_work('series_version',new.id,'The frozen series visual baseline changed.');
  end if;
  return new;
end;
$$;

create trigger invalidate_changed_series_baseline_dependents_after_update
after update of rules on public.series_versions
for each row execute function public.invalidate_changed_series_baseline_dependents();

create function public.invalidate_revised_storyboard_dependents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare previous_package_id uuid;
begin
  if new.stage <> 'storyboard_review' then return new; end if;
  if coalesce(new.context_snapshot #>> '{review_feedback,review_package_id}', '') = '' then return new; end if;
  previous_package_id := (new.context_snapshot #>> '{review_feedback,review_package_id}')::uuid;
  perform public.invalidate_dependent_production_work('review_package',previous_package_id,'A revised storyboard replaced the upstream approved storyboard package.');
  return new;
end;
$$;

create trigger invalidate_revised_storyboard_dependents_after_insert
after insert on public.review_packages
for each row execute function public.invalidate_revised_storyboard_dependents();

revoke all on function public.record_pre_render_member_dependencies() from public, anon, authenticated;
revoke all on function public.invalidate_dependent_production_work(text, uuid, text) from public, anon, authenticated;
revoke all on function public.invalidate_replaced_material_dependents() from public, anon, authenticated;
revoke all on function public.invalidate_changed_series_baseline_dependents() from public, anon, authenticated;
revoke all on function public.invalidate_revised_storyboard_dependents() from public, anon, authenticated;
