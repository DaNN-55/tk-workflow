alter type public.task_status add value if not exists 'running';
alter type public.task_status add value if not exists 'failed';

alter table public.tasks
  add column if not exists attempt integer not null default 0 check (attempt >= 0),
  add column if not exists provider text not null default 'codex',
  add column if not exists model text not null default 'gpt-5.6-codex',
  add column if not exists prompt_version text not null default 'brief-v1',
  add column if not exists claimed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists actual_cost_cents integer,
  add column if not exists last_result jsonb;

update public.tasks
set budget_limit_cents = 0
where budget_limit_cents is null;

alter table public.tasks
  alter column budget_limit_cents set default 0,
  alter column budget_limit_cents set not null,
  add constraint tasks_actual_cost_cents_nonnegative
  check (actual_cost_cents is null or actual_cost_cents >= 0);

create index tasks_ready_queue_idx
  on public.tasks (status, created_at)
  where status = 'ready';
