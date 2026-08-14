alter table public.experiments add column primary_variable text;
update public.experiments set primary_variable = hypothesis where primary_variable is null;
alter table public.experiments alter column primary_variable set not null;
alter table public.experiments add constraint experiments_primary_variable_not_blank check (char_length(btrim(primary_variable)) > 0);

create function public.define_experiment(
  p_episode_id uuid,
  p_hypothesis text,
  p_primary_variable text,
  p_primary_metric text,
  p_guardrail_metrics text[]
)
returns public.experiments
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_episode public.episodes;
  membership_role public.member_role;
  normalized_primary_variable text := btrim(p_primary_variable);
  normalized_primary_metric text := btrim(p_primary_metric);
  normalized_guardrail_metrics text[] := coalesce(p_guardrail_metrics, '{}'::text[]);
  created_experiment public.experiments;
begin
  select * into target_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  select role into membership_role from public.account_memberships where account_id = target_episode.account_id and user_id = auth.uid();
  if membership_role is null then
    raise exception 'Account membership is required to define an experiment' using errcode = '42501';
  end if;
  if target_episode.stage <> 'metrics_collecting'::public.episode_stage then
    raise exception 'Experiments can only be defined while metrics are being collected' using errcode = '22023';
  end if;
  if coalesce(btrim(p_hypothesis), '') = '' or normalized_primary_variable = '' or normalized_primary_metric = '' then
    raise exception 'Experiment hypothesis, primary variable, and primary metric are required' using errcode = '22023';
  end if;
  if cardinality(normalized_guardrail_metrics) > 2 then
    raise exception 'An experiment can have at most two guardrail metrics' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(normalized_guardrail_metrics) metric where metric is null or btrim(metric) = '') then
    raise exception 'Guardrail metrics cannot be blank' using errcode = '22023';
  end if;
  normalized_guardrail_metrics := array(select btrim(metric) from unnest(normalized_guardrail_metrics) metric);
  if normalized_primary_metric = any(normalized_guardrail_metrics) then
    raise exception 'The primary metric cannot also be a guardrail metric' using errcode = '22023';
  end if;
  if cardinality(normalized_guardrail_metrics) <> cardinality(array(select distinct metric from unnest(normalized_guardrail_metrics) metric)) then
    raise exception 'Guardrail metrics must be unique' using errcode = '22023';
  end if;

  insert into public.experiments (episode_id, hypothesis, primary_variable, primary_metric, guardrail_metrics)
  values (p_episode_id, btrim(p_hypothesis), normalized_primary_variable, normalized_primary_metric, normalized_guardrail_metrics)
  returning * into created_experiment;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (target_episode.account_id, p_episode_id, 'experiment_defined', jsonb_build_object('primary_variable', normalized_primary_variable, 'primary_metric', normalized_primary_metric, 'guardrail_metrics', normalized_guardrail_metrics), auth.uid());
  return created_experiment;
end;
$$;

create function public.record_weekly_metric_snapshot(
  p_episode_id uuid,
  p_captured_at timestamptz,
  p_metrics jsonb
)
returns public.metric_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_episode public.episodes;
  membership_role public.member_role;
  experiment public.experiments;
  expected_metric_names text[];
  metric_name text;
  saved_snapshot public.metric_snapshots;
begin
  select * into target_episode from public.episodes where id = p_episode_id for update;
  if not found then
    raise exception 'Episode % does not exist', p_episode_id using errcode = 'P0002';
  end if;
  select role into membership_role from public.account_memberships where account_id = target_episode.account_id and user_id = auth.uid();
  if membership_role is distinct from 'owner' then
    raise exception 'Owner membership is required to record metrics' using errcode = '42501';
  end if;
  if target_episode.stage <> 'metrics_collecting'::public.episode_stage then
    raise exception 'Metrics can only be recorded while metrics are being collected' using errcode = '22023';
  end if;
  select * into experiment from public.experiments where episode_id = p_episode_id;
  if not found then
    raise exception 'An experiment must be defined before recording metrics' using errcode = '22023';
  end if;
  if p_captured_at is null or p_captured_at <> date_trunc('week', p_captured_at at time zone 'UTC') at time zone 'UTC' then
    raise exception 'Metric snapshots must use the start of an ISO week in UTC' using errcode = '22023';
  end if;
  if p_metrics is null or jsonb_typeof(p_metrics) <> 'object' then
    raise exception 'Metrics must be a JSON object' using errcode = '22023';
  end if;

  expected_metric_names := array[experiment.primary_metric] || experiment.guardrail_metrics;
  if cardinality(array(select key from jsonb_object_keys(p_metrics) key)) <> cardinality(expected_metric_names)
    or exists (select 1 from jsonb_object_keys(p_metrics) key where key <> all(expected_metric_names)) then
    raise exception 'Metrics must match the experiment primary and guardrail metrics' using errcode = '22023';
  end if;
  foreach metric_name in array expected_metric_names loop
    if jsonb_typeof(p_metrics -> metric_name) <> 'number' or (p_metrics ->> metric_name)::numeric < 0 then
      raise exception 'Each metric value must be a non-negative number' using errcode = '22023';
    end if;
  end loop;

  insert into public.metric_snapshots (episode_id, captured_at, metrics, captured_by)
  values (p_episode_id, p_captured_at, p_metrics, auth.uid())
  on conflict (episode_id, captured_at) do update
    set metrics = excluded.metrics,
        captured_by = excluded.captured_by
  returning * into saved_snapshot;
  insert into public.audit_events (account_id, episode_id, event_type, payload, actor_id)
  values (target_episode.account_id, p_episode_id, 'weekly_metrics_recorded', jsonb_build_object('captured_at', p_captured_at, 'metrics', p_metrics), auth.uid());
  return saved_snapshot;
end;
$$;

grant execute on function public.define_experiment(uuid, text, text, text, text[]) to authenticated;
grant execute on function public.record_weekly_metric_snapshot(uuid, timestamptz, jsonb) to authenticated;
