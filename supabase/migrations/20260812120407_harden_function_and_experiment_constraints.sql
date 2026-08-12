alter function public.is_allowed_episode_transition(public.episode_stage, public.episode_stage)
  set search_path = '';

alter table public.experiments
  add constraint experiments_guardrail_metrics_max_two
  check (cardinality(guardrail_metrics) <= 2);
