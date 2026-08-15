alter table public.tasks drop constraint tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check check (task_type in ('draft_brief','draft_script','prepare_visual_brief','draft_storyboard','generate_a_roll','generate_b_roll','generate_narration','extract_embedded_audio','generate_soundtrack','generate_review_render','generate_final_render','prepare_publish_package','verify_publish_package','register_publish_input'));

create function public.record_publish_input(p_episode_id uuid, p_artifact_type text, p_relative_path text, p_sha256 text, p_file_size bigint)
returns public.artifacts language plpgsql security definer set search_path = '' as $$
declare selected_episode public.episodes; existing public.artifacts; producer public.tasks; expected_path text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Only the local publish input registrar may record an input' using errcode='42501'; end if;
  if p_artifact_type not in ('cover','metadata') or p_sha256 !~ '^[0-9a-f]{64}$' or p_file_size < 1 then raise exception 'Publish input is invalid' using errcode='22023'; end if;
  select * into selected_episode from public.episodes where id=p_episode_id for update;
  if not found or selected_episode.stage <> 'qc_passed' then raise exception 'Publish inputs require qc_passed' using errcode='22023'; end if;
  expected_path := 'episodes/' || p_episode_id::text || '/publish-input/' || p_artifact_type || '-v1.' || case when p_artifact_type='cover' then 'png' else 'json' end;
  if p_relative_path <> expected_path then raise exception 'Publish input path is invalid' using errcode='22023'; end if;
  select * into existing from public.artifacts where episode_id=p_episode_id and artifact_type=p_artifact_type;
  if found then if existing.relative_path<>p_relative_path or existing.sha256<>p_sha256 or existing.file_size<>p_file_size then raise exception 'Publish input is already fixed' using errcode='22023'; end if; return existing; end if;
  insert into public.tasks (episode_id,task_type,status,input_snapshot) values (p_episode_id,'register_publish_input','completed',jsonb_build_object('artifact_type',p_artifact_type,'relative_path',p_relative_path,'sha256',p_sha256,'file_size',p_file_size)) returning * into producer;
  insert into public.artifacts (episode_id,artifact_type,relative_path,sha256,file_size,producer_task_id) values (p_episode_id,p_artifact_type,p_relative_path,p_sha256,p_file_size,producer.id) returning * into existing;
  insert into public.audit_events (account_id,episode_id,event_type,payload,actor_id) values (selected_episode.account_id,p_episode_id,'publish_input_registered',jsonb_build_object('artifact_type',p_artifact_type,'relative_path',p_relative_path,'sha256',p_sha256),auth.uid());
  return existing;
end; $$;
revoke all on function public.record_publish_input(uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.record_publish_input(uuid,text,text,text,bigint) to service_role;
