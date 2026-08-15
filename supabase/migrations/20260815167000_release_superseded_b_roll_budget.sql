update public.tasks
set status = 'blocked',
    completed_at = now(),
    last_result = jsonb_build_object(
      'version', 'worker-result/v1', 'taskId', id, 'status', 'blocked', 'artifacts', jsonb_build_array(),
      'validation', jsonb_build_object('passed', false, 'checks', jsonb_build_array()), 'actualCostCents', 0,
      'blockers', jsonb_build_array(jsonb_build_object('code', 'b_roll_task_superseded', 'detail', '该失败任务的冻结检索词已被替换，不再占用 B-roll 预算。')),
      'retry', jsonb_build_object('shouldRetry', false, 'reason', 'A corrected frozen task replaced this failed task.'),
      'nextStep', 'Use the replacement task created with the corrected frozen search query.'
    )
where task_type = 'generate_b_roll'
  and status = 'failed'
  and coalesce(input_snapshot ->> 'configuration_hash', '') like 'deprecated-%';

update public.tasks
set input_snapshot = jsonb_set(
      input_snapshot,
      '{configuration_hash}',
      to_jsonb('deprecated-blocked-query-' || (input_snapshot ->> 'configuration_hash'))
    )
where task_type = 'generate_b_roll'
  and status = 'blocked'
  and coalesce(input_snapshot ->> 'configuration_hash', '') not like 'deprecated-%'
  and (
    coalesce(input_snapshot #>> '{media,b_roll,query}', '') like 'review_only_storyboard%'
    or char_length(coalesce(input_snapshot #>> '{media,b_roll,query}', '')) > 100
  );
