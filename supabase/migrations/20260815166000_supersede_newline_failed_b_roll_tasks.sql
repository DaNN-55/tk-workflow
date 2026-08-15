update public.tasks
set input_snapshot = jsonb_set(
      input_snapshot,
      '{configuration_hash}',
      to_jsonb('deprecated-newline-query-' || (input_snapshot ->> 'configuration_hash'))
    )
where task_type = 'generate_b_roll'
  and status = 'failed'
  and position(E'\n' in coalesce(input_snapshot #>> '{media,b_roll,query}', '')) > 0
  and coalesce(input_snapshot ->> 'configuration_hash', '') not like 'deprecated-%';
