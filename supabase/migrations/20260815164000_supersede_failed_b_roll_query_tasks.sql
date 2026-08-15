update public.tasks
set input_snapshot = jsonb_set(
      input_snapshot,
      '{configuration_hash}',
      to_jsonb('deprecated-invalid-query-' || (input_snapshot ->> 'configuration_hash'))
    )
where task_type = 'generate_b_roll'
  and status in ('failed', 'blocked')
  and coalesce(input_snapshot #>> '{media,b_roll,query}', '') like 'review_only_storyboard%'
  and coalesce(input_snapshot ->> 'configuration_hash', '') not like 'deprecated-%';
