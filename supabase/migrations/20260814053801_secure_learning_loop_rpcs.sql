do $$
begin
  if to_regprocedure('public.define_experiment(uuid, text, text, text, text[])') is not null then
    execute 'revoke execute on function public.define_experiment(uuid, text, text, text, text[]) from public, anon';
  end if;
  if to_regprocedure('public.record_weekly_metric_snapshot(uuid, timestamptz, jsonb)') is not null then
    execute 'revoke execute on function public.record_weekly_metric_snapshot(uuid, timestamptz, jsonb) from public, anon';
  end if;
end;
$$;
