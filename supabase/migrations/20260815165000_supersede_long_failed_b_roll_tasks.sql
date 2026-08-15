update public.tasks
set input_snapshot = jsonb_set(
      input_snapshot,
      '{configuration_hash}',
      to_jsonb('deprecated-query-length-' || (input_snapshot ->> 'configuration_hash'))
    )
where task_type = 'generate_b_roll'
  and status in ('failed', 'blocked')
  and char_length(coalesce(input_snapshot #>> '{media,b_roll,query}', '')) > 100
  and coalesce(input_snapshot ->> 'configuration_hash', '') not like 'deprecated-%';
