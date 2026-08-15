do $$
declare
  constraint_name text;
begin
  select constraint_row.conname into constraint_name
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'public.audio_tracks'::regclass
    and constraint_row.contype = 'u'
    and pg_catalog.pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (episode_id, track_kind, cue_id, source_review_package_id)';
  if constraint_name is null then
    raise exception 'Expected audio-track cue uniqueness constraint is missing' using errcode = '22023';
  end if;
  execute format('alter table public.audio_tracks drop constraint %I', constraint_name);
end;
$$;
