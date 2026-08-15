create or replace function public.orchestrate_b_roll_tasks()
returns setof public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_task public.tasks;
  corrected_query text;
begin
  for created_task in select * from public.orchestrate_b_roll_tasks_legacy()
  loop
    if created_task.status = 'ready' then
      corrected_query := left(btrim(created_task.input_snapshot #>> '{shot,scriptSegment}'), 100);
      if corrected_query = '' then raise exception 'B-roll task is missing a frozen search query basis' using errcode = '22023'; end if;
      update public.tasks set input_snapshot = jsonb_set(input_snapshot, '{media,b_roll,query}', to_jsonb(corrected_query)) where id = created_task.id returning * into created_task;
    end if;
    return next created_task;
  end loop;
end;
$$;

update public.tasks
set input_snapshot = jsonb_set(input_snapshot, '{configuration_hash}', to_jsonb('deprecated-query-length-' || (input_snapshot ->> 'configuration_hash'))),
    status = 'blocked',
    completed_at = now(),
    last_result = jsonb_build_object(
      'version', 'worker-result/v1', 'taskId', id, 'status', 'blocked', 'artifacts', jsonb_build_array(),
      'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array()), 'actualCostCents', 0,
      'blockers', jsonb_build_array(jsonb_build_object('code', 'b_roll_query_too_long', 'detail', '任务尚未领取；已用不超过 100 字符的新冻结检索词重建。')),
      'retry', jsonb_build_object('shouldRetry', false, 'reason', 'The original frozen search query exceeded the provider limit.'),
      'nextStep', 'Use the replacement task created with the bounded frozen search query.'
    )
where task_type = 'generate_b_roll' and status = 'ready' and char_length(input_snapshot #>> '{media,b_roll,query}') > 100;

revoke all on function public.orchestrate_b_roll_tasks() from public, anon, authenticated;
grant execute on function public.orchestrate_b_roll_tasks() to service_role;
