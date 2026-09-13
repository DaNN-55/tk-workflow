import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationNames = readdirSync(resolve("supabase/migrations"));
const accountArchivingMigration = resolve("supabase/migrations/20260909191919_add_account_archiving.sql");
const approvalGatesMigration = resolve("supabase/migrations/20260909203000_enforce_blueprint_approval_gates.sql");
const stopLegacyNarrationMigration = resolve(
  "supabase/migrations/20260907170000_stop_legacy_narration_orchestration.sql",
);
const replaceHyperframesMigration = resolve("supabase/migrations/20260908090000_replace_hyperframes_with_openchatcut.sql");
const restrictOpenChatCutReviewHelperMigration = resolve(
  "supabase/migrations/20260909042941_restrict_openchatcut_review_helper.sql",
);
const technicalConfigMigration = resolve(
  "supabase/migrations/20260822121000_use_blueprint_b_roll_technical_config.sql",
);
const legacyOrchestrationPermissionsMigration = resolve(
  "supabase/migrations/20260822121948_restrict_b_roll_legacy_orchestration.sql",
);
const storyboardHarnessMigration = resolve(
  "supabase/migrations/20260822215000_freeze_storyboard_harness.sql",
);
const audioAdapterConnectionsMigration = resolve(
  "supabase/migrations/20260822223000_freeze_audio_adapter_connections.sql",
);
const audioToolPermissionsMigration = resolve(
  "supabase/migrations/20260822223500_normalize_audio_tool_permissions.sql",
);
const approvedVisualManifestMigration = resolve(
  "supabase/migrations/20260822223700_freeze_approved_visual_manifest.sql",
);
const manualArollMigration = resolve(
  "supabase/migrations/20260823103000_add_manual_a_roll_uploads.sql",
);
const hyperframesStudioRevisionMigration = resolve(
  "supabase/migrations/20260824092000_hyperframes_studio_review_revision.sql",
);
const studioStructuralRevisionMigration = resolve(
  "supabase/migrations/20260824100000_request_studio_structural_revision.sql",
);
const studioStructuralReworkApprovalMigration = resolve(
  "supabase/migrations/20260901141000_remove_duplicate_storyboard_rework_approval.sql",
);
const manualArollFixMigration = resolve(
  "supabase/migrations/20260823110000_fix_manual_a_roll_shot_lookup.sql",
);
const manualArollTakeoverMigration = resolve(
  "supabase/migrations/20260823113000_allow_manual_a_roll_takeover.sql",
);
const manualArollReuseMigration = resolve(
  "supabase/migrations/20260823201000_allow_manual_a_roll_reuse.sql",
);
const manualBrollReuseMigration = resolve(
  "supabase/migrations/20260823202000_allow_manual_b_roll_reuse.sql",
);
const replaceManualShotMediaMigration = resolve(
  "supabase/migrations/20260902153000_replace_manual_shot_media.sql",
);
const prepareManualShotClipsMigration = resolve(
  "supabase/migrations/20260902161000_prepare_manual_shot_clips.sql",
);
const scopedEmbeddedAudioMigration = resolve(
  "supabase/migrations/20260823114000_scope_embedded_audio_orchestration.sql",
);
const manualMediaBindingsMigration = resolve(
  "supabase/migrations/20260823120000_add_manual_media_bindings.sql",
);
const scopedSoundtrackMigration = resolve(
  "supabase/migrations/20260823121000_scope_soundtrack_orchestration.sql",
);
const manualPathOrchestrationMigration = resolve(
  "supabase/migrations/20260825150000_skip_manual_media_orchestration.sql",
);
const scopedManualPathCorrectionMigration = resolve(
  "supabase/migrations/20260825160000_scope_manual_media_orchestration.sql",
);
const explicitMediaPathMigration = resolve(
  "supabase/migrations/20260825170000_require_explicit_media_execution_paths.sql",
);
const bRollBudgetOverflowMigration = resolve(
  "supabase/migrations/20260826093000_prevent_b_roll_budget_overflow.sql",
);
const unrestrictedBRollBudgetMigration = resolve(
  "supabase/migrations/20260826094000_treat_unrestricted_b_roll_budget_as_unlimited.sql",
);
const scopedCoreOrchestrationMigration = resolve(
  "supabase/migrations/20260823200000_add_scoped_core_task_orchestration.sql",
);
const episodeAudioSourceMigration = resolve(
  "supabase/migrations/20260823185000_add_episode_audio_source_mode.sql",
);
const volcengineTtsExecutionMigration = resolve(
  "supabase/migrations/20260901111615_enable_volcengine_tts_execution.sql",
);
const decoupledTtsAlignmentMigration = resolve(
  "supabase/migrations/20260912162500_decouple_tts_and_acoustic_alignment.sql",
);
const captionSafeAreaV2Migration = resolve(
  "supabase/migrations/20260912200000_caption_safe_area_v2.sql",
);
const blueprintSnapshotVersionMigration = resolve(
  "supabase/migrations/20260823114252_fix_current_blueprint_snapshot_version.sql",
);
const qcEditorMigration = resolve(
  "supabase/migrations/20260823190000_integrate_qc_editor.sql",
);
const qcEditorCompletionMigration = resolve(
  "supabase/migrations/20260823191000_fix_qc_only_review_completion.sql",
);
const editingDeskMigration = resolve(
  "supabase/migrations/20260823203000_move_hyperframes_composition_to_editing_desk.sql",
);
const removeSeriesAdvancedRulesMigration = resolve(
  "supabase/migrations/20260824102000_remove_series_advanced_rules.sql",
);
const sharedPlanningMigration = resolve(
  "supabase/migrations/20260824103000_unify_planning_configuration.sql",
);
const reviewRevisionPreconditionsMigration = resolve(
  "supabase/migrations/20260824110000_deepen_review_revision_preconditions.sql",
);
const internalVisualPreparationMigration = resolve(
  "supabase/migrations/20260824120000_internal_visual_asset_preparation.sql",
);
const uploadedVisualDispatchMigration = resolve(
  "supabase/migrations/20260901103000_fix_uploaded_visual_dispatch.sql",
);
const disabledSoundtrackCueMigration = resolve(
  "supabase/migrations/20260901120000_ignore_disabled_soundtrack_cues.sql",
);
const narrationShotStartMigration = resolve(
  "supabase/migrations/20260901130000_preserve_narration_shot_starts.sql",
);
const studioPreRenderInvalidationMigration = resolve(
  "supabase/migrations/20260901150000_respect_tts_pre_render_audio.sql",
);
const frozenStudioProjectPathMigration = resolve(
  "supabase/migrations/20260901151000_fix_frozen_studio_project_path.sql",
);
const publishCoverFormatsMigration = resolve(
  "supabase/migrations/20260902080000_allow_publish_cover_image_formats.sql",
);
const productionCompletionEnumMigration = resolve(
  "supabase/migrations/20260912210000_add_production_completed_stage.sql",
);
const productionCompletionMigration = resolve(
  "supabase/migrations/20260912210100_remove_publication_learning_flow.sql",
);
const qcApprovalArtifactGateMigration = resolve(
  "supabase/migrations/20260912210300_fix_qc_approval_artifact_gate.sql",
);
const shotPreparationDraftMigration = resolve(
  "supabase/migrations/20260903090000_add_shot_preparation_drafts.sql",
);
const shotTtsMigration = resolve(
  "supabase/migrations/20260903100000_add_shot_tts_generation.sql",
);
const reusedShotTtsTrackMigration = resolve(
  "supabase/migrations/20260911071624_restore_reused_shot_tts_track.sql",
);
const shotClipMigration = resolve(
  "supabase/migrations/20260903110000_generate_shot_clip.sql",
);
const shotAudioModesMigration = resolve(
  "supabase/migrations/20260903120000_complete_shot_audio_modes.sql",
);
const shotConfirmationMigration = resolve(
  "supabase/migrations/20260903130000_confirm_shot_preparation.sql",
);
const shotStructureRevisionMigration = resolve(
  "supabase/migrations/20260903140000_add_storyboard_structure_revision.sql",
);
const confirmedStudioSnapshotMigration = resolve(
  "supabase/migrations/20260903150000_auto_create_confirmed_studio_snapshot.sql",
);
const visualManifestApprovalRestoreMigration = resolve(
  "supabase/migrations/20260906142420_restore_visual_asset_manifest_approval.sql",
);
const frozenMultiSegmentShotDraftMigration = resolve(
  "supabase/migrations/20260904100000_freeze_multi_segment_shot_drafts.sql",
);
const deferredStudioTrimmingMigration = resolve(
  "supabase/migrations/20260904110000_defer_shot_trimming_to_studio.sql",
);
const shotTtsConnectionOwnershipFixMigration = resolve(
  "supabase/migrations/20260904120000_fix_shot_tts_connection_ownership.sql",
);
const shotTtsVariableConflictFixMigration = resolve(
  "supabase/migrations/20260904130000_fix_shot_tts_variable_conflict.sql",
);
const shotTtsTrackSyncHardeningMigration = resolve(
  "supabase/migrations/20260904150000_harden_shot_tts_track_sync.sql",
);
const shotTtsEpisodeSettingsMigration = resolve(
  "supabase/migrations/20260904160000_move_tts_settings_to_episode.sql",
);
const shotTtsConfirmationMigration = resolve(
  "supabase/migrations/20260904170000_simplify_shot_tts_confirmation.sql",
);
const perShotTtsGenerationMigration = resolve(
  "supabase/migrations/20260907190000_simplify_per_shot_tts_generation.sql",
);
const batchShotTtsMigration = resolve(
  "supabase/migrations/20260904180000_batch_confirmed_shot_tts.sql",
);
const batchShotTtsConnectionOwnershipFixMigration = resolve(
  "supabase/migrations/20260905190000_fix_batch_tts_connection_ownership.sql",
);
const completedShotClipReplacementMigration = resolve(
  "supabase/migrations/20260905200000_fix_completed_shot_clip_replacement.sql",
);
const shotWorkbenchInputFingerprintMigration = resolve(
  "supabase/migrations/20260905210000_fix_shot_workbench_input_fingerprint.sql",
);
const shotReviewDraftUpdateAliasMigration = resolve(
  "supabase/migrations/20260905220000_fix_shot_review_draft_update_alias.sql",
);
const workerLeaseHeartbeatMigration = resolve(
  "supabase/migrations/20260905280000_refresh_worker_task_lease.sql",
);
const frozenStudioCompositionMigration = resolve(
  "supabase/migrations/20260905300000_freeze_studio_composition_adjustments.sql",
);
const reviewRenderSeriesBaselineVersionMigration = resolve(
  "supabase/migrations/20260905230000_fix_review_render_series_baseline_version.sql",
);
const reviewRenderSeriesBaselineNullMigration = resolve(
  "supabase/migrations/20260905240000_allow_review_render_without_series_baseline.sql",
);
const malformedReviewRenderRecoveryMigration = resolve(
  "supabase/migrations/20260905250000_recover_malformed_review_render_task.sql",
);
const durationDecisionReviewRenderRecoveryMigration = resolve(
  "supabase/migrations/20260905260000_recover_duration_decision_review_render_task.sql",
);
const assetRootReviewRenderRecoveryMigration = resolve(
  "supabase/migrations/20260905270000_requeue_asset_root_review_render_task.sql",
);
const storyboardRevisionHardeningMigration = resolve(
  "supabase/migrations/20260905140000_harden_storyboard_structure_revision.sql",
);
const storyboardRevisionAudioTrackIdempotencyMigration = resolve(
  "supabase/migrations/20260905170000_fix_storyboard_revision_audio_track_idempotency.sql",
);
const workbenchStructureRevisionMigration = resolve(
  "supabase/migrations/20260907162000_keep_structure_revisions_in_workbench.sql",
);
const editableShotClipGenerationMigration = resolve(
  "supabase/migrations/20260905160000_restore_editable_shot_clip_generation.sql",
);
const episodeTtsOwnershipMigration = resolve(
  "supabase/migrations/20260905150000_finalize_episode_tts_ownership.sql",
);
const durationDecisionMigration = resolve(
  "supabase/migrations/20260905100000_unify_shot_duration_decision.sql",
);
const durationSearchPathMigration = resolve(
  "supabase/migrations/20260905180000_fix_shot_duration_search_path.sql",
);
const editableShotWorkbenchMigration = resolve(
  "supabase/migrations/20260905110000_restore_editable_shot_workbench.sql",
);
const shotReviewVideoMigration = resolve(
  "supabase/migrations/20260905120000_generate_shot_review_video.sql",
);
const shotSyncPreviewMigration = resolve(
  "supabase/migrations/20260911032918_shot_sync_preview.sql",
);
const clipIntervalUnionDurationMigration = resolve(
  "supabase/migrations/20260911104219_use_clip_interval_union_duration.sql",
);
const compositionAwareClipDurationMigration = resolve(
  "supabase/migrations/20260911112639_use_composition_aware_clip_duration.sql",
);
const sourceAndPlaybackDurationMigration = resolve(
  "supabase/migrations/20260911124701_separate_source_and_playback_duration.sql",
);
const embeddedSourceAudioPreviewMigration = resolve(
  "supabase/migrations/20260912180135_use_embedded_source_audio_for_shot_preview.sql",
);
const preserveNestedShotAudioMixNullsMigration = resolve(
  "supabase/migrations/20260912210200_preserve_nested_shot_audio_mix_nulls.sql",
);
const openChatCutFrozenPathMigration = resolve(
  "supabase/migrations/20260909044114_align_openchatcut_frozen_project_path.sql",
);
const editableSubmittedWorkbenchMigration = resolve(
  "supabase/migrations/20260909044856_keep_shot_workbench_editable_after_review_submission.sql",
);
const editablePreRenderWorkbenchMigration = resolve(
  "supabase/migrations/20260909051800_keep_shot_workbench_editable_during_pre_render_review.sql",
);
const shotReviewVideoActionMigration = resolve(
  "supabase/migrations/20260907180000_enable_shot_review_video_action.sql",
);
const disabledSubtitleReviewVideoMigration = resolve(
  "supabase/migrations/20260907200000_allow_disabled_subtitles_in_review_video.sql",
);
const disabledSubtitleShotSnapshotMigration = resolve(
  "supabase/migrations/20260907210000_allow_disabled_subtitles_in_shot_snapshot.sql",
);
const disabledSubtitleReviewRenderRetryMigration = resolve(
  "supabase/migrations/20260907220000_retry_disabled_subtitle_review_render.sql",
);
const enforcedShotAudioModesMigration = resolve(
  "supabase/migrations/20260905130000_enforce_shot_audio_modes.sql",
);
const workerRuntimeConstraintsMigration = resolve(
  "supabase/migrations/20260904140000_platform_worker_runtime_constraints.sql",
);
const deployedMigrations = {
  "20260822095959_guard_legacy_b_roll_history.sql": "b36e63037ca12c2785d7bbb9f2fe8596f31377de734dcf8b96cb03af23613c9b",
  "20260822100000_freeze_b_roll_adapter_connection.sql": "f38575ba3b5dcb7814f230c5a48a52c6a5ac37811868d00bdb0f7eb375b2a51d",
  "20260822104421_expand_legacy_b_roll_blueprints.sql": "f8182e92f0ccd25ed228e56d92ca54f1ef836954303d5d385b8e0672cd635a8f",
  "20260822112024_remove_legacy_b_roll_history_guard.sql": "f28b35a78d15812e85abc119440d7a7af3c880935dafa344fc9ff13b64663d30",
  "20260822223000_freeze_audio_adapter_connections.sql": "cd1b31c24d56a2e86b2b9c31cc23008d5bced7e8660582f0bd4176622ab05a68",
  "20260822223500_normalize_audio_tool_permissions.sql": "f258ccb1126c76083ffce532f022b8123476eb31a2392a7bd75de220bf27352b",
};

type RequiredMigrationPatch = {
  signature: string;
  source: string;
  replacement: string;
  label: string;
};

const extractFunctionDefinition = (sql: string, functionName: string) => {
  const marker = new RegExp(`create(?: or replace)? function public\\.${functionName}\\b`, "g");
  const matches = [...sql.matchAll(marker)];
  const start = matches.at(-1)?.index;
  if (start == null) throw new Error(`Function definition not found: ${functionName}`);
  const bodyStart = sql.indexOf("as $$", start);
  const bodyEnd = sql.indexOf("$$;", bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error(`Function body not found: ${functionName}`);
  return sql.slice(start, bodyEnd + 3);
};

const splitSqlArguments = (value: string) => {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      if (depth === 0) {
        args.push(value.slice(start, index).trim());
        return args;
      }
      depth -= 1;
    } else if (character === "," && depth === 0) {
      args.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  throw new Error("Unclosed SQL function call");
};

type ShotGenerationReplayState = {
  drafts: Array<{ id: string; frozen: boolean; sourceMaterialRevisionId: string; clipSegments: Array<{ startSeconds: number; endSeconds: number }> }>;
  packages: Array<{ id: string; studioProject: Record<string, unknown> }>;
  tasks: Array<{ id: string; studioProject: Record<string, unknown> }>;
  revisions: Array<{ revision: number; studioProject: Record<string, unknown> }>;
};

function replayShotGeneration(state: ShotGenerationReplayState, input: { acceptDurationRisk: boolean; isOwner: boolean; riskCount: number; riskReason: string; studioProject: Record<string, unknown> }): ShotGenerationReplayState {
  if (!input.isOwner) throw new Error("Owner membership is required");
  if (!input.studioProject.relative_path || !input.studioProject.sha256 || Number(input.studioProject.file_size) < 1) throw new Error("Invalid frozen Studio project");
  if ((input.riskCount > 0) !== input.acceptDurationRisk || (input.acceptDurationRisk && !input.riskReason.trim()) || (input.riskCount === 0 && input.acceptDurationRisk)) throw new Error("Invalid duration risk decision");
  return {
    drafts: state.drafts.map((draft) => ({ ...draft })),
    packages: [...state.packages, { id: `package-${state.packages.length + 1}`, studioProject: structuredClone(input.studioProject) }],
    tasks: [...state.tasks, { id: `task-${state.tasks.length + 1}`, studioProject: structuredClone(input.studioProject) }],
    revisions: [...state.revisions, { revision: state.revisions.length + 1, studioProject: structuredClone(input.studioProject) }],
  };
}

const decodeSqlTextExpression = (expression: string) => {
  let value = "";
  for (let index = 0; index < expression.length;) {
    if (/\s/.test(expression[index])) {
      index += 1;
      continue;
    }
    if (expression.startsWith("||", index)) {
      index += 2;
      continue;
    }
    if (expression.startsWith("chr(10)", index)) {
      value += "\n";
      index += "chr(10)".length;
      continue;
    }
    if (expression[index] !== "'") throw new Error(`Unsupported SQL text expression: ${expression}`);
    index += 1;
    while (index < expression.length) {
      if (expression[index] === "'" && expression[index + 1] === "'") {
        value += "'";
        index += 2;
      } else if (expression[index] === "'") {
        index += 1;
        break;
      } else {
        value += expression[index];
        index += 1;
      }
    }
  }
  return value;
};

const extractRequiredMigrationPatches = (migration: string): RequiredMigrationPatch[] => {
  const start = migration.indexOf("do $$");
  const end = migration.indexOf("\ndrop function public._required_text_replace", start);
  const body = migration.slice(start, end < 0 ? migration.length : end);
  const patches: RequiredMigrationPatch[] = [];
  let cursor = 0;
  while (true) {
    const callMarker = "public._required_text_replace(definition,";
    const markerIndex = body.indexOf(callMarker, cursor);
    if (markerIndex < 0) break;
    const callStart = body.indexOf("(", markerIndex);
    const args = splitSqlArguments(body.slice(callStart + 1));
    const selector = [...body.slice(0, markerIndex).matchAll(/pg_get_functiondef\('public\.([^']+)'::regprocedure\)/g)].at(-1);
    if (!selector) throw new Error("Patch target selector not found");
    patches.push({
      signature: selector[1],
      source: decodeSqlTextExpression(args[1]),
      replacement: decodeSqlTextExpression(args[2]),
      label: decodeSqlTextExpression(args[3]),
    });
    cursor = markerIndex + callMarker.length;
  }
  return patches;
};

const extractLiteralReplacePatches = (migration: string, signature: string): RequiredMigrationPatch[] => {
  const start = migration.indexOf(`pg_get_functiondef('public.${signature}'::regprocedure)`);
  const end = migration.indexOf("if patched = definition", start);
  if (start < 0 || end < 0) throw new Error(`Literal patch block not found: ${signature}`);
  const body = migration.slice(start, end);
  const patches: RequiredMigrationPatch[] = [];
  let cursor = 0;
  while (true) {
    const markerIndex = body.indexOf("replace(", cursor);
    if (markerIndex < 0) break;
    const args = splitSqlArguments(body.slice(markerIndex + "replace(".length));
    if (args.length === 3 && args[1].trim().startsWith("'") && args[2].trim().startsWith("'")) {
      patches.push({ signature, source: decodeSqlTextExpression(args[1]), replacement: decodeSqlTextExpression(args[2]), label: `${signature} literal replace` });
    }
    cursor = markerIndex + "replace(".length;
  }
  return patches;
};

const extractDollarReplacePatches = (migration: string, signature: string, endMarker = "if patched_definition = definition"): RequiredMigrationPatch[] => {
  const start = migration.indexOf(`pg_get_functiondef('public.${signature}'::regprocedure)`);
  const end = migration.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Dollar patch block not found: ${signature}`);
  const body = migration.slice(start, end);
  return [...body.matchAll(/replace\(\w+,\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\)/g)].map((match) => ({ signature, source: match[1], replacement: match[2], label: `${signature} dollar replace` }));
};

const applyMigrationPatches = (definition: string, patches: RequiredMigrationPatch[]) => patches.reduce((current, patch) => {
  expect(current, patch.label).toContain(patch.source);
  return current.replace(patch.source, patch.replacement);
}, definition);

const applyMigrationPatchesExactly = (definition: string, patches: RequiredMigrationPatch[]) => patches.reduce((current, patch) => {
  const matches = current.split(patch.source).length - 1;
  expect(matches, patch.label).toBe(1);
  return current.replace(patch.source, patch.replacement);
}, definition);

const updateSetBlock = (definition: string) => {
  const updateStart = [...definition.matchAll(/update public\.shot_preparation_drafts\s+set/g)].at(-1)?.index ?? -1;
  const start = Math.max(definition.lastIndexOf("do update set"), updateStart);
  return definition.slice(start, definition.indexOf("returning *", start));
};

const assignmentCount = (definition: string, column: string) => (updateSetBlock(definition).match(new RegExp(`\\n\\s*${column}\\s*=`, "g")) ?? []).length;

describe("B-roll 连接固化迁移", () => {
  it("修复审核渲染任务冻结系列基准缺少版本并安全重放", () => {
    const migration = readFileSync(reviewRenderSeriesBaselineVersionMigration, "utf8");
    const previous = extractFunctionDefinition(readFileSync(shotReviewVideoMigration, "utf8"), "generate_shot_review_video");
    const oldDeclaration = "  series_rules jsonb;";
    const newDeclaration = "  series_rules jsonb;\n  series_version_number integer;";
    const oldSelect = "  select coalesce(version.rules, '{}'::jsonb) into series_rules\n  from public.series_versions version\n  where version.id = current_episode.series_version_id\n    and version.account_id = current_episode.account_id;";
    const newSelect = "  select version.version, coalesce(version.rules, '{}'::jsonb) into series_version_number, series_rules\n  from public.series_versions version\n  where version.id = current_episode.series_version_id\n    and version.account_id = current_episode.account_id;";
    const oldBaseline = "    'series_baseline', jsonb_build_object('version_id', current_episode.series_version_id, 'rules', series_rules),";
    const newBaseline = "    'series_baseline', jsonb_build_object('version_id', current_episode.series_version_id, 'version', series_version_number, 'rules', series_rules),";

    expect(migration).toContain("review render series baseline version patch has unknown or partial state");
    expect(migration).toContain("review render series baseline version patch produced an invalid state");
    expect(previous).toContain(oldDeclaration);
    expect(previous).toContain(oldSelect);
    expect(previous).toContain(oldBaseline);

    const patched = previous.replace(oldDeclaration, newDeclaration).replace(oldSelect, newSelect).replace(oldBaseline, newBaseline);
    expect(patched).toContain(newDeclaration);
    expect(patched).toContain(newSelect);
    expect(patched).toContain(newBaseline);
    expect(patched).not.toContain(oldSelect);
    expect(patched).not.toContain(oldBaseline);
  });

  it("无系列版本时把审核渲染系列基准写成可选 null", () => {
    const migration = readFileSync(reviewRenderSeriesBaselineNullMigration, "utf8");
    expect(migration).toContain("current_episode.series_version_id is null then null");
    expect(migration).toContain("review render null series baseline patch has unknown or partial state");
    expect(migration).toContain("review render null series baseline patch produced an invalid state");
  });

  it("只恢复缺少系列版本的 blocked 审核渲染任务并保留旧证据", () => {
    const migration = readFileSync(malformedReviewRenderRecoveryMigration, "utf8");
    expect(migration).toContain("task.task_type = 'generate_review_render'");
    expect(migration).toContain("task.status = 'blocked'");
    expect(migration).toContain("not (task.input_snapshot -> 'series_baseline' ? 'version')");
    expect(migration).toContain("blocker ->> 'code' = 'task_package_invalid'");
    expect(migration).toContain("recovered_from_task_id");
    expect(migration).toContain("'version', series_row.version");
    expect(migration).toContain("'composition_revision_id', new_composition.id");
    expect(migration).toContain("'project_revision', next_revision");
    expect(migration).toContain("'relative_path', render_path");
    expect(migration).toContain("malformed review render task has an unexpected series version");
    expect(migration).toContain("malformed review render task has no matching composition revision");
    expect(migration).not.toContain("update public.tasks");
  });

  it("只恢复精确时长判定 blocker 的有效系列审核渲染任务", () => {
    const migration = readFileSync(durationDecisionReviewRenderRecoveryMigration, "utf8");
    expect(migration).toContain("jsonb_typeof(task.input_snapshot #> '{series_baseline,version}') = 'number'");
    expect(migration).toContain("blocker ->> 'code' = 'task_package_invalid'");
    expect(migration).toContain("blocker ->> 'detail' = '镜头时长判定格式无效。'");
    expect(migration).toContain("jsonb_typeof(task.last_result -> 'blockers') = 'array'");
    expect(migration).toContain("jsonb_typeof(task.input_snapshot #> '{review_render,project_revision}') = 'number'");
    expect(migration).toContain("source_composition.revision_number <> (source_task.input_snapshot #>> '{review_render,project_revision}')::integer");
    expect(migration).toContain("duration-invalid review render task has inconsistent frozen paths");
    expect(migration).toContain("recovered_from_task_id");
    expect(migration).toContain("duration-invalid review render task has an unexpected series version");
    expect(migration).toContain("create or replace function public.recover_duration_decision_review_render_tasks()");
    expect(migration).toContain("revoke all on function public.recover_duration_decision_review_render_tasks() from public, anon, authenticated");
    expect(migration).not.toContain("update public.tasks");
  });

  it("只把有匹配 blocked task_run 的 asset root 预检任务重新排队", () => {
    const migration = readFileSync(assetRootReviewRenderRecoveryMigration, "utf8");
    expect(migration).toContain("task.task_type = 'generate_review_render'");
    expect(migration).toContain("task.status = 'blocked'::public.task_status");
    expect(migration).toContain("task.invalidated_at is null");
    expect(migration).toContain("episode.stage = 'render_ready'::public.episode_stage");
    expect(migration).toContain("jsonb_typeof(task.last_result -> 'blockers') = 'array'");
    expect(migration).toContain("blocker ->> 'code' = 'asset_root_unavailable'");
    expect(migration).toContain("blocker ->> 'check' = 'asset_root'");
    expect(migration).toContain("blocker ->> 'phase' = 'preflight'");
    expect(migration).toContain("task_run.task_id = task.id");
    expect(migration).toContain("task_run.attempt = task.attempt - 1");
    expect(migration).toContain("task_run.status = 'blocked'::public.task_status");
    expect(migration).toContain("status = 'ready'::public.task_status");
    expect(migration).toContain("max_attempts = task.max_attempts + 1");
    expect(migration).toContain("claimed_at = null");
    expect(migration).toContain("completed_at = null");
    expect(migration).not.toContain("set attempt =");
    expect(migration).not.toContain("task_run.attempt = task.attempt\n");
    expect(migration).not.toContain("update public.task_runs");
    expect(migration).not.toContain("input_snapshot =");
    expect(migration).not.toContain("last_result =");
  });

  it("修复审核视频冻结更新的 PL/pgSQL 变量别名冲突并安全重放", () => {
    const migration = readFileSync(shotReviewDraftUpdateAliasMigration, "utf8");
    const source = "update public.shot_preparation_drafts draft\n  set frozen_at = now(),";
    const replacement = "update public.shot_preparation_drafts as target\n  set frozen_at = now(),";
    const previous = extractFunctionDefinition(readFileSync(shotReviewVideoMigration, "utf8"), "generate_shot_review_video");

    expect(migration).toContain("pg_get_functiondef('public.generate_shot_review_video(uuid, uuid, jsonb, boolean, text)'::regprocedure)");
    expect(migration).toContain("draft update alias patch target has unknown state");
    expect(migration).toContain("has_old_update := position(old_update_block in definition) > 0;");
    expect(migration).toContain("has_old_where := position(old_where_block in definition) > 0;");
    expect(migration).toContain("if has_old_update = has_new_update or has_old_where = has_new_where then");
    expect(migration).toContain("draft update alias patch target has partial state");
    expect(migration).toContain("draft update alias patch produced an invalid state");
    expect(previous).toContain(source);
    const patched = previous.replace(source, replacement).replace(
      "  where draft.episode_id = p_episode_id\n    and draft.review_package_id = p_review_package_id;",
      "  where target.episode_id = p_episode_id\n    and target.review_package_id = p_review_package_id;",
    );
    expect(patched).toContain(replacement);
    expect(patched).toContain("where target.episode_id = p_episode_id");
    expect(patched).not.toContain("where draft.episode_id = p_episode_id");
    expect(migration).toContain("elsif not has_old_update and not has_old_where and has_new_update and has_new_where then");

    const patchDecision = (oldUpdate: boolean, newUpdate: boolean, oldWhere: boolean, newWhere: boolean) => {
      if (oldUpdate === newUpdate || oldWhere === newWhere) return "unknown";
      if (oldUpdate && oldWhere) return "patch";
      if (!oldUpdate && !oldWhere && newUpdate && newWhere) return "skip";
      return "partial";
    };
    expect(patchDecision(true, false, true, false)).toBe("patch");
    expect(patchDecision(false, true, false, true)).toBe("skip");
    expect(patchDecision(true, false, false, true)).toBe("partial");
  });

  it("补齐镜头工作台输入指纹并安全重放函数补丁", () => {
    const migration = readFileSync(shotWorkbenchInputFingerprintMigration, "utf8");
    const source = "set selected_material_revision_id = p_material_revision_id,\n      clip_segments = p_clip_segments,";
    const replacement = "set input_fingerprint = md5(selected_shot::text),\n      selected_material_revision_id = p_material_revision_id,\n      clip_segments = p_clip_segments,";

    expect(migration).toContain("set input_fingerprint = md5(shot.value::text)");
    expect(migration).toContain("draft.input_fingerprint is null");
    expect(migration).toContain("if position('set selected_material_revision_id = p_material_revision_id,");
    expect(migration).toContain("elsif position('set input_fingerprint = md5(selected_shot::text),");
    expect(migration).toContain("input fingerprint patch target has unknown state");
    const previous = extractFunctionDefinition(readFileSync(frozenMultiSegmentShotDraftMigration, "utf8"), "save_shot_workbench_draft");
    expect(previous).toContain(source);
    const patched = previous.replace(source, replacement);
    expect(patched).toContain(replacement);
    expect(patched).not.toContain(source);
    expect(migration).not.toContain("if patched = definition then");
  });

  it("保留历史冻结记录，同时允许当前分镜工作台继续编辑", () => {
    const migration = readFileSync(editableShotWorkbenchMigration, "utf8");

    expect(migration).toContain("current_stage is distinct from 'storyboard_approved'");
    expect(migration).toContain("save_shot_workbench_draft");
    expect(migration).toContain("save_shot_tts_override");
    expect(migration).toContain("episode.stage = ''storyboard_approved''");
    expect(migration).not.toContain("drop table");
  });

  it("可重放历史 TTS 覆盖函数的可编辑守卫补丁", () => {
    const previous = extractFunctionDefinition(readFileSync(shotTtsConfirmationMigration, "utf8"), "save_shot_tts_override");
    const restore = readFileSync(editableShotWorkbenchMigration, "utf8");
    const frozenGuard = "if draft.frozen_at is not null then raise exception 'Frozen shot drafts cannot be edited' using errcode = '22023'; end if;";
    const editableGuard = "if draft.frozen_at is not null and not exists (select 1 from public.episodes episode where episode.id = p_episode_id and episode.stage = 'storyboard_approved') then raise exception 'Frozen shot drafts cannot be edited' using errcode = '22023'; end if;";
    const replayed = previous.replace(frozenGuard, editableGuard);

    expect(previous).toContain(frozenGuard);
    expect(restore).toContain("pg_get_functiondef('public.save_shot_tts_override(uuid, uuid, text, text, numeric)'::regprocedure)");
    expect(replayed).toContain(editableGuard);
    expect(replayed).not.toContain(frozenGuard);
  });

  it("只在统一确认时冻结多片段草稿并创建镜头任务", () => {
    const migration = readFileSync(frozenMultiSegmentShotDraftMigration, "utf8");

    expect(migration).toContain("create function public.save_shot_workbench_draft");
    expect(migration).toContain("clip_segments jsonb");
    expect(migration).toContain("create function public.freeze_shot_preparation_batch");
    expect(migration).toContain("'video_clips'");
    expect(migration).toContain("create trigger protect_frozen_shot_preparation_inputs");
    expect(migration).toContain("create trigger zz_queue_source_audio_after_frozen_clip");
  });

  it("冻结时把原片和标记直接交给 Studio，不提前创建裁剪任务", () => {
    const migration = readFileSync(deferredStudioTrimmingMigration, "utf8");

    expect(migration).toContain("source_material_revision_id");
    expect(migration).toContain("create or replace function public.record_pre_render_member_dependencies");
    expect(migration).toContain("new.source_material_revision_id");
    expect(migration).toContain("'clip_segments', draft.clip_segments");
    expect(migration).toContain("'source_material', jsonb_build_object");
    expect(migration).toContain("perform public.orchestrate_review_render_tasks(p_episode_id)");
    expect(migration).not.toContain("'ffmpeg_trim_video'");
    expect(migration).not.toContain("'extract_embedded_audio'");
  });

  it("只从当前已确认镜头创建不可变 Studio 输入，并让生产门禁先创建快照", () => {
    const migration = readFileSync(confirmedStudioSnapshotMigration, "utf8");

    expect(migration).toContain("has_current_shot_preparation_snapshot");
    expect(migration).toContain("draft.confirmation_status = 'confirmed'");
    expect(migration).toContain("draft.input_fingerprint = md5(required.value::text)");
    expect(migration).toContain("video_task.status = 'completed'");
    expect(migration).toContain("audio_track.id = draft.current_audio_track_id");
    expect(migration).toContain("package.context_snapshot ->> 'confirmation_mode' is distinct from 'shot_preparation'");
    expect(migration).toContain("package.context_snapshot ->> 'storyboard_review_package_id' is distinct from p_storyboard_review_package_id::text");
    expect(migration).toContain("if not exists (select 1 from public.create_shot_preparation_review_package(candidate.id, candidate.storyboard_review_package_id)) then continue; end if;");
    expect(migration).toContain("'confirmation_mode', 'shot_preparation'");
    expect(migration).toContain("'input_fingerprint', draft.input_fingerprint");
  });

  it("视觉审核允许冻结后的资产清单通过，同时保留后续生产门禁", () => {
    const migration = readFileSync(visualManifestApprovalRestoreMigration, "utf8");

    expect(migration).toContain("artifact_type in ('visual_brief', 'visual_asset_manifest')");
    expect(migration).toContain("when 'production_ready'::public.episode_stage then exists");
    expect(migration).toContain("public.has_current_shot_preparation_snapshot");
    expect(migration).toContain("security definer set search_path = ''");
  });

  it("将镜头结构操作冻结为幂等的分镜审核修订", () => {
    const migration = readFileSync(shotStructureRevisionMigration, "utf8");

    expect(migration).toContain("request_shot_structure_revision");
    expect(migration).toContain("structure_revision_hash");
    expect(migration).toContain("create_storyboard_revision_review_package");
    expect(migration).toContain("storyboard_approved', 'storyboard_review");
    expect(migration).toContain("input_fingerprint");
    expect(migration).toContain("draft.input_fingerprint = md5(shot::text)");
    expect(migration).toContain("previous.current_video_artifact_id");
    expect(migration).toContain("'id', 'shot-' || gen_random_uuid()::text");
    expect(migration).toContain("on conflict (episode_id, review_package_id, shot_id) do nothing");
  });

  it("为分镜结构修订规范化幂等键并只复用有效历史", () => {
    const migration = readFileSync(storyboardRevisionHardeningMigration, "utf8");

    expect(migration).toContain("canonical_storyboard_structure_revision_operation");
    expect(migration).toContain("The storyboard review package is stale");
    expect(migration).toContain("substr(md5(request_hash || ':split:' || ordinality::text), 1, 24)");
    expect(migration).toContain("indexes[1] + position - 1");
    expect(migration).toContain("task.status = 'completed'");
    expect(migration).toContain("task.invalidated_at is null");
    expect(migration).toContain("frozen_at = null");
    expect(migration).toContain("zz_reuse_shot_preparation_history_after_storyboard_approval");
  });

  it("不依赖已移除的跨审核包音轨唯一约束", () => {
    const migration = readFileSync(storyboardRevisionAudioTrackIdempotencyMigration, "utf8");

    expect(migration).toContain("create or replace function public.seed_shot_preparation_drafts_after_storyboard_approval()");
    expect(migration).toContain("public.reuse_shot_preparation_history_after_storyboard_approval()");
    expect(migration).toContain("and existing.source_review_package_id = package_record.id");
    expect(migration).toContain("select episode_record.id, old_track.source_task_id");
    expect(migration).toContain("position(new_audio_insert in definition) = 0");
    expect(migration).toContain("if patched <> definition then execute patched");
  });

  it("确定性结构修订留在分镜工作台，并只复用安全的镜头配置", () => {
    const migration = readFileSync(workbenchStructureRevisionMigration, "utf8");

    expect(migration).toContain("A storyboard structure revision is already running");
    expect(migration).toContain("Storyboard structure revision base package is stale");
    expect(migration).toContain("Owner applied a deterministic storyboard structure revision.");
    expect(migration).toContain("storyboard_structure_revision_applied");
    expect(migration).not.toContain("update public.episodes set stage = 'storyboard_review'");
    expect(migration).toContain("preserve_duration_inputs := operation_kind = 'change_duration'");
    expect(migration).toContain("preserve_type_inputs := operation_kind = 'change_type'");
    expect(migration).toContain("confirmation_status = case when preserve_duration_inputs or preserve_type_inputs then 'pending'");
    expect(migration).toContain("where (not preserve_type_inputs or previous.audio_mode = 'tts')");
    expect(migration).toContain("warning_decision = case when preserve_duration_inputs or preserve_type_inputs then 'not_required'");
    expect(migration).toContain("selected_material_revision_id = case when preserve_type_inputs then null");
    expect(migration).toContain("storyboard_structure_revision_backfilled");
    expect(migration).toContain("episode.id = '92b3067d-ced9-4e85-bc44-1968fa83695a'::uuid");
    expect(migration).toContain("Recovered completed deterministic storyboard structure revision in the workbench.");
  });

  it("发布输入登记允许 JPG、PNG 和 WebP 封面", () => {
    const migration = readFileSync(publishCoverFormatsMigration, "utf8");

    expect(migration).toContain("create or replace function public.record_publish_input");
    expect(migration).toContain("cover-v1\\.(jpg|png|webp)$");
    expect(migration).toContain("metadata-v1.json");
  });

  it("发布包校验通过后进入生产完成终态，并移除发布及复盘数据结构", () => {
    const enumMigration = readFileSync(productionCompletionEnumMigration, "utf8");
    const migration = readFileSync(productionCompletionMigration, "utf8");

    expect(enumMigration).toContain("add value if not exists 'production_completed'");
    expect(migration).toContain("stage = 'production_completed'");
    expect(migration).toContain("create or replace function public.record_publish_package_verification");
    expect(migration).toContain("drop table if exists public.publication_records");
    expect(migration).toContain("drop table if exists public.learning_reports");
    expect(migration).toContain("drop table if exists public.metric_snapshots");
    expect(migration).toContain("drop table if exists public.experiments");
  });

  it("QC 批准只接受当前审核包对应成功任务的完整审核证据", () => {
    const migration = readFileSync(qcApprovalArtifactGateMigration, "utf8");
    const qcClause = migration.slice(
      migration.indexOf("when 'qc_passed'"),
      migration.indexOf("when 'production_completed'"),
    );

    expect(qcClause).toContain("package.stage = 'qc_review'");
    expect(qcClause).toContain("package.invalidated_at is null");
    expect(qcClause).toContain("order by current_package.revision_number desc, current_package.created_at desc");
    expect(qcClause).toContain("task.task_type = 'generate_review_render'");
    expect(qcClause).toContain("task.status = 'completed'");
    expect(qcClause).toContain("artifact.producer_task_id = task.id");
    expect(qcClause).toContain("select count(distinct artifact.artifact_type) = 4");
    expect(qcClause).toContain("'render'");
    expect(qcClause).toContain("'review_render_project'");
    expect(qcClause).toContain("'review_render_runtime'");
    expect(qcClause).toContain("'review_qc_report'");
    expect(qcClause).not.toContain("'final_render'");
    expect(migration.slice(migration.indexOf("when 'production_completed'"))).toContain("'final_render'");
  });

  it("保存已被生产单引用的蓝图时，为旧规则分配独立快照版本", () => {
    const migration = readFileSync(blueprintSnapshotVersionMigration, "utf8");

    expect(migration).toContain("next_snapshot_version integer");
    expect(migration).toContain("select coalesce(max(version), 0) + 1 into next_snapshot_version");
    expect(migration).toContain("values (updated_blueprint.account_id, next_snapshot_version");
  });

  it("保持已部署迁移内容不变", () => {
    for (const [filename, expectedHash] of Object.entries(deployedMigrations)) {
      const migration = readFileSync(resolve("supabase/migrations", filename), "utf8");
      expect(createHash("sha256").update(migration).digest("hex")).toBe(expectedHash);
    }
  });

  it("在旧迁移前后安装并移除历史版本保护", () => {
    expect(migrationNames).toContain("20260822095959_guard_legacy_b_roll_history.sql");
    expect(migrationNames).toContain("20260822112024_remove_legacy_b_roll_history_guard.sql");
  });

  it("以账号蓝图而非系列规则冻结 B-roll 技术配置", () => {
    const technicalConfig = readFileSync(technicalConfigMigration, "utf8");

    expect(technicalConfig).toContain("create or replace function public.orchestrate_b_roll_tasks_legacy");
    expect(technicalConfig).toContain("selected_config := candidate.blueprint_policy -> 'b_roll';");
    expect(technicalConfig).not.toContain("series_version.rules as series_rules");
  });

  it("以 bigint 累计 B-roll 预算，避免上限值在多镜头时溢出", () => {
    const migration = readFileSync(bRollBudgetOverflowMigration, "utf8");

    expect(migration).toContain("committed_budget bigint");
    expect(migration).toContain("coalesce(sum(task.budget_limit_cents), 0)::bigint into committed_budget");
  });

  it("将默认的最大预算值按不限预算处理", () => {
    const migration = readFileSync(unrestrictedBRollBudgetMigration, "utf8");

    expect(migration).toContain("total_budget < 2147483647");
  });

  it("只允许 Worker 调用内部 B-roll 编排函数", () => {
    const permissions = readFileSync(legacyOrchestrationPermissionsMigration, "utf8");

    expect(permissions).toContain("revoke all on function public.orchestrate_b_roll_tasks_legacy(uuid) from public, anon, authenticated;");
    expect(permissions).toContain("grant execute on function public.orchestrate_b_roll_tasks_legacy(uuid) to service_role;");
  });

  it("分镜任务冻结已登记 Adapter 与不可变 Prompt Harness", () => {
    const migration = readFileSync(storyboardHarnessMigration, "utf8");

    expect(migration).toContain("and harness.capability = 'storyboard_planning'");
    expect(migration).toContain("'harness', jsonb_build_object(");
    expect(migration).toContain("'adapter', 'codex'");
    expect(migration).toContain("grant execute on function public.orchestrate_storyboard_tasks() to service_role;");
  });

  it("旁白与配乐任务冻结已选择的非秘密连接引用", () => {
    const migration = readFileSync(audioAdapterConnectionsMigration, "utf8");

    expect(migration).toContain("'google-tts-default'");
    expect(migration).toContain("'freesound-default'");
    expect(migration).toContain("orchestrate_narration_tasks_without_connection_ref");
    expect(migration).toContain("orchestrate_soundtrack_tasks_without_connection_ref");
    expect(migration).toContain("set input_snapshot = jsonb_set(task.input_snapshot, '{credential_ref}'");
  });

  it("只保留账号实际授予的音频工具", () => {
    const migration = readFileSync(audioToolPermissionsMigration, "utf8");

    expect(migration).toContain("'{narration,allowed_tools}'");
    expect(migration).toContain("'{soundtrack,allowed_tools}'");
    expect(migration).not.toContain("'network'");
  });

  it("分镜只冻结 Owner 已批准的视觉资产清单", () => {
    const migration = readFileSync(approvedVisualManifestMigration, "utf8");

    expect(migration).toContain("visual_package.artifact_id as approved_visual_artifact_id");
    expect(migration).toContain("artifact.id = candidate.approved_visual_artifact_id");
    expect(migration).not.toContain("artifact.producer_task_id = candidate.visual_task_id and artifact.artifact_type = 'visual_asset_manifest'");
  });

  it("人工 A-roll 独立于自动能力开关，并冻结到已批准的分镜镜头", () => {
    const migration = readFileSync(manualArollMigration, "utf8");

    expect(migration).toContain("'a_roll'");
    expect(migration).toContain("create function public.register_manual_a_roll");
    expect(migration).toContain("'manual_upload'");
    expect(migration).toContain("'a_roll_video'");
    expect(migration).not.toContain("credential_ref");
    expect(readFileSync(manualArollFixMigration, "utf8")).toContain("as shot(value)");
    expect(readFileSync(manualArollTakeoverMigration, "utf8")).toContain("task.status in ('ready', 'blocked', 'failed')");
    expect(readFileSync(resolve("supabase/migrations/20260826095500_fix_manual_media_task_type_ambiguity.sql"), "utf8")).toContain("task.task_type = v_task_type");
    const reusableAroll = readFileSync(manualArollReuseMigration, "utf8");
    expect(reusableAroll).toContain("artifacts_episode_id_artifact_type_relative_path_producer_task_key");
    expect(reusableAroll).not.toContain("This A-roll material is already bound to another storyboard shot");
    expect(readFileSync(manualBrollReuseMigration, "utf8")).not.toContain("This B-roll material is already bound to another storyboard shot");
    expect(readFileSync(scopedEmbeddedAudioMigration, "utf8")).toContain("p_episode_id uuid default null");
    const manualMedia = readFileSync(manualMediaBindingsMigration, "utf8");
    expect(manualMedia).toContain("create function public.register_manual_b_roll");
    expect(manualMedia).toContain("create function public.register_manual_audio");
    expect(manualMedia).toContain("if has_approved_video and exists");
  });

  it("允许 Owner 在合成前替换已确认的人工镜头素材并保留旧任务", () => {
    const migration = readFileSync(replaceManualShotMediaMigration, "utf8");

    expect(migration).toContain("create function public.replace_manual_shot_media");
    expect(migration).toContain("task.status = 'completed'");
    expect(migration).toContain("task.provider = 'manual_upload'");
    expect(migration).toContain("set status = 'superseded'");
    expect(migration).toContain("public.register_manual_a_roll");
    expect(migration).toContain("public.register_manual_b_roll");
  });

  it("允许镜头素材重复替换，并冻结 Studio 前的裁剪区间", () => {
    const migration = readFileSync(prepareManualShotClipsMigration, "utf8");

    expect(migration).toContain("drop index if exists public.tasks_one_a_roll_per_storyboard_shot_configuration_idx");
    expect(migration).toContain("status <> 'superseded'::public.task_status");
    expect(migration).toContain("create function public.save_manual_shot_clip");
    expect(migration).toContain("p_clip_start_seconds numeric");
    expect(migration).toContain("p_clip_end_seconds numeric");
    expect(migration).toContain("'clip_selection'");
  });

  it("声轨编排只处理已开启该能力的指定生产单", () => {
    const migration = readFileSync(scopedSoundtrackMigration, "utf8");

    expect(migration).toContain("p_episode_id uuid default null");
    expect(migration).toContain("blueprint.policy -> 'soundtrack'");
    expect(migration).toContain("p_episode_id is null or episode.id = p_episode_id");
    expect(migration).toContain("'credential_ref', frozen_credential_ref");
  });

  it("关闭声轨能力时不把可选声轨提示当成生产门槛", () => {
    const migration = readFileSync(disabledSoundtrackCueMigration, "utf8");

    expect(migration).toContain("candidate.blueprint_policy -> 'soundtrack'");
    expect(migration).toContain("advance_production_ready_episodes");
    expect(migration).toContain("create_pre_render_review_packages");
  });

  it("分段旁白保留冻结镜头起点，不再按实际音频长度紧密重排", () => {
    const migration = readFileSync(narrationShotStartMigration, "utf8");

    expect(migration).toContain("set start_seconds = (task.input_snapshot #>> '{audio_track,start_seconds}')::numeric");
    expect(migration).toContain("create or replace function public.register_completed_audio_track()");
    expect(migration).not.toContain("sum(track.duration_seconds)");
  });

  it("Studio 结构返工同时作废旧 QC 与旧预渲染清单", () => {
    const migration = readFileSync(studioPreRenderInvalidationMigration, "utf8");

    expect(migration).toContain("request_studio_storyboard_revision(uuid, text)");
    expect(migration).toContain("where id = selected_qc_package.id");
    expect(migration).toContain("where id = selected_pre_render_package.id");
  });

  it("冻结 Studio 工程使用可匹配实际相对路径的数据库正则", () => {
    const migration = readFileSync(frozenStudioProjectPathMigration, "utf8");

    expect(migration).toContain("/studio-frozen/[0-9a-f-]{36}/index[.]html$");
    expect(migration).not.toContain("/index\\\\.html$");
  });

  it("人工路径不进入媒体 Worker 编排", () => {
    const migration = readFileSync(manualPathOrchestrationMigration, "utf8");

    expect(migration).toContain("execution_path}', 'external') <> 'manual");
    expect(migration).toContain("orchestrate_soundtrack_tasks_without_manual_path");
    expect(migration).toContain("orchestrate_a_roll_tasks_without_manual_path");
  });

  it("人工 A-roll 按 Episode 隔离，旁白保留原声模式门槛", () => {
    const migration = readFileSync(scopedManualPathCorrectionMigration, "utf8");

    expect(migration).toContain("orchestrate_a_roll_tasks_for_episode");
    expect(migration).toContain("p_episode_id is null or episode.id = p_episode_id");
    expect(migration).toContain("episode.audio_source_mode = 'tts'");
    expect(migration).toContain("blueprint.policy #>> ''{a_roll,execution_path}'' in (''external'', ''local'')");
    expect(migration).toContain("blueprint.policy #>> '{a_roll,execution_path}' in ('external', 'local')");
    expect(migration).toContain("blueprint.policy #>> '{narration,execution_path}' in ('external', 'local')");
    expect(migration).not.toContain("coalesce(blueprint.policy #>> '{a_roll,execution_path}', 'external')");
    expect(migration).not.toContain("coalesce(blueprint.policy #>> '{narration,execution_path}', 'external')");
    expect(migration).not.toContain("if exists (\n    select 1\n    from public.episodes episode\n    join public.account_blueprint_versions blueprint");
  });

  it("人工旁白使用 Episode 级绑定入口", () => {
    const migration = readFileSync(scopedManualPathCorrectionMigration, "utf8");

    expect(migration).toContain("register_manual_episode_narration");
    expect(migration).toContain("p_episode_id uuid");
    expect(migration).toContain("track.cue_id = candidate.id::text");
  });

  it("只允许 service_role 调用动态创建的 A-roll Episode 编排函数", () => {
    const migration = readFileSync(scopedManualPathCorrectionMigration, "utf8");

    expect(migration).toContain("revoke all on function public.orchestrate_a_roll_tasks_for_episode(uuid) from public, anon, authenticated;");
    expect(migration).toContain("grant execute on function public.orchestrate_a_roll_tasks_for_episode(uuid) to service_role;");
  });

  it("按 Episode 的本地 HyperFrames A-roll 会进入 ready 队列", () => {
    const migration = readFileSync(resolve("supabase/migrations/20260826101000_enable_scoped_local_hyperframes_a_roll.sql"), "utf8");

    expect(migration).toContain("orchestrate_a_roll_tasks_for_episode_without_card_adapter");
    expect(migration).toContain("set status = 'ready'::public.task_status");
    expect(migration).toContain("hyperframes_card_video");
  });

  it("B-roll 与 soundtrack 只调度显式 external 或 local 路径", () => {
    const migration = readFileSync(explicitMediaPathMigration, "utf8");
    const bRollPredicate = "coalesce(blueprint.policy #>> '{b_roll,execution_path}', 'external') <> 'manual'";
    const soundtrackPredicate = "coalesce(blueprint.policy #>> '{soundtrack,execution_path}', 'external') <> 'manual'";
    const bRollReplacement = "blueprint.policy #>> '{b_roll,execution_path}' in ('external', 'local')";
    const soundtrackReplacement = "blueprint.policy #>> '{soundtrack,execution_path}' in ('external', 'local')";
    const sqlString = (value: string) => value.replaceAll("'", "''");

    expect(migration).toContain(`execute replace(definition, '${sqlString(bRollPredicate)}', '${sqlString(bRollReplacement)}')`);
    expect(migration).toContain(`execute replace(definition, '${sqlString(soundtrackPredicate)}', '${sqlString(soundtrackReplacement)}')`);
    const simulatedBrollDefinition = `where ${bRollPredicate}`.replace(bRollPredicate, bRollReplacement);
    const simulatedSoundtrackDefinition = `where ${soundtrackPredicate}`.replace(soundtrackPredicate, soundtrackReplacement);
    expect(simulatedBrollDefinition).not.toContain("<> 'manual'");
    expect(simulatedSoundtrackDefinition).not.toContain("<> 'manual'");
    expect(simulatedBrollDefinition).toContain(bRollReplacement);
    expect(simulatedSoundtrackDefinition).toContain(soundtrackReplacement);
    expect(migration).toContain("revoke all on function public.orchestrate_b_roll_tasks(uuid) from public, anon, authenticated;");
    expect(migration).toContain("grant execute on function public.orchestrate_b_roll_tasks(uuid) to service_role;");
    expect(migration).toContain("revoke all on function public.orchestrate_soundtrack_tasks(uuid) from public, anon, authenticated;");
    expect(migration).toContain("grant execute on function public.orchestrate_soundtrack_tasks(uuid) to service_role;");
  });

  it("定向调度只会创建指定生产单的视觉与分镜任务", () => {
    const migration = readFileSync(scopedCoreOrchestrationMigration, "utf8");

    expect(migration).toContain("orchestrate_provided_script_tasks_for_episode(p_episode_id uuid)");
    expect(migration).toContain("orchestrate_storyboard_tasks_for_episode(p_episode_id uuid)");
    expect(migration).toContain("where episode.id = p_episode_id");
    expect(migration).toContain("grant execute on function public.orchestrate_provided_script_tasks_for_episode(uuid) to service_role;");
    expect(migration).toContain("grant execute on function public.orchestrate_storyboard_tasks_for_episode(uuid) to service_role;");
  });

  it("视觉准备与分镜任务冻结同一套 Adapter、模型和 Harness", () => {
    const migration = readFileSync(sharedPlanningMigration, "utf8");

    expect(migration).toContain("'visual_planning', normalized.planning_executor, 'storyboard_planning', normalized.planning_executor");
    expect(migration).toContain("and not blueprint.is_snapshot");
    expect(migration).toContain("inserted_snapshots as");
    expect(migration).toContain("set blueprint_version_id = snapshot.id");
    expect(migration).toContain("planning_capability := case when candidate.blueprint_is_snapshot then 'visual_planning' else 'storyboard_planning' end");
    expect(migration).toContain("case when blueprint.is_snapshot then 'visual_planning' else 'storyboard_planning' end");
    expect(migration).toContain("'capability', 'visual_planning'");
    expect(migration).toContain("create trigger freeze_shared_planning_harness_before_insert");
    expect(migration).toContain("create or replace function public.apply_episode_configuration_repair_v2");
    expect(migration).toContain("'分镜规划修复配置必须选择已启用的 Harness'");
    expect(migration).toContain("planning_task.input_snapshot - 'prompt_context'");
  });

  it("视觉素材准备改为 Worker 内部步骤，蓝图只保留静态视觉与分镜配置", () => {
    const migration = readFileSync(internalVisualPreparationMigration, "utf8");

    expect(migration).toContain("and exists (select 1 from public.episodes episode where episode.blueprint_version_id = blueprint.id)");
    expect(migration).toContain("coalesce(blueprint.policy -> 'executors', '{}'::jsonb) - 'visual_planning'");
    expect(migration).toContain("coalesce(blueprint.policy -> 'budgets', '{}'::jsonb) - 'visual_planning_cents'");
    expect(migration).toContain("'visual-preparation-v1'");
    expect(migration).toContain("'execution_mode', case when selected_harness.id is null then 'worker_default' else 'legacy_frozen' end");
    expect(migration).toContain("drop trigger if exists freeze_shared_planning_harness_before_insert on public.tasks;");
  });

  it("全局视觉准备调度复用按生产单编排入口", () => {
    const migration = readFileSync(uploadedVisualDispatchMigration, "utf8");

    expect(migration).toContain("create or replace function public.orchestrate_provided_script_tasks()");
    expect(migration).toContain("public.orchestrate_provided_script_tasks_for_episode(candidate_id)");
    expect(migration).not.toContain("invalid visual planning budget");
    expect(migration).not.toContain("invalid visual planning executor");
  });

  it("视觉准备冻结已批准的上传视频且不要求图片生成配置", () => {
    const migration = readFileSync(uploadedVisualDispatchMigration, "utf8");

    expect(migration).toContain("create or replace function public.orchestrate_provided_script_tasks_for_episode(p_episode_id uuid)");
    expect(migration).toContain("join public.material_revision_approvals approval on approval.material_revision_id = material.id");
    expect(migration).toContain("material.material_purpose in ('visual_reference', 'a_roll', 'b_roll')");
    expect(migration).toContain("'materialPurpose', material.material_purpose");
    expect(migration).toContain("'image_generation', image_generation");
    expect(migration).toContain("'model', candidate.policy #>> '{static_visual,executor,model}'");
  });

  it("按生产单的明确选择决定保留上传视频原声还是生成 TTS", () => {
    const migration = readFileSync(episodeAudioSourceMigration, "utf8");

    expect(migration).toContain("audio_source_mode in ('source', 'tts')");
    expect(migration).toContain("create function public.set_episode_audio_source_mode");
    expect(migration).toContain("episode.audio_source_mode = 'tts'");
    expect(migration).toContain("episode.audio_source_mode = 'source'");
    expect(migration).not.toContain("and not exists (select 1 from public.production_material_revisions material");
  });

  it("让豆包语音旁白进入创建、领取与连接修复链路", () => {
    const migration = readFileSync(volcengineTtsExecutionMigration, "utf8");

    expect(migration).toContain("executor ->> 'provider' = 'volcengine_tts'");
    expect(migration).toContain("'codex','google_tts','volcengine_tts','pexels'");
    expect(migration).toContain("then blocked_task.provider");
    expect(migration).toContain("blocked_task.input_snapshot #>> '{executor,adapter}'");
  });

  it("口播音频完成后立即可用，并把声学对齐排为独立后台任务", () => {
    const migration = readFileSync(decoupledTtsAlignmentMigration, "utf8");

    expect(migration).toContain("new.status <> 'completed'");
    expect(migration).toContain("audio.source_task_id = new.id");
    expect(migration).toContain("'align_shot_captions', 'ready'");
    expect(migration).toContain("口播音频已可试听；声学对齐正在后台排队。");
    expect(migration).not.toContain("new.last_result -> 'acousticAlignment'");
  });

  it("自动进入审核渲染，并只在 QC 台阻塞最终批准", () => {
    const migration = readFileSync(qcEditorMigration, "utf8");

    expect(migration).toContain("''approval_mode'',''qc_only''");
    expect(migration).toContain("create table public.qc_review_issues");
    expect(migration).toContain("create or replace function public.create_qc_review_issue");
    expect(migration).toContain("create or replace function public.request_qc_member_revision");
    expect(migration).toContain("Open blocking QC issues must be resolved before approval");
  });

  it("自动审核渲染推进状态，并拒绝对陈旧或人工 QC 成员返工", () => {
    const migration = readFileSync(qcEditorCompletionMigration, "utf8");

    expect(migration).toContain("'production_ready','render_ready'");
    expect(migration).toContain("QC review package is no longer current");
    expect(migration).toContain("selected_task.provider = 'manual_upload'");
  });

  it("将 HyperFrames 合成参数迁出蓝图，并冻结系列默认或生产单调整", () => {
    const migration = readFileSync(editingDeskMigration, "utf8");

    expect(migration).toContain("set policy = policy - 'hyperframes_composition'");
    expect(migration).toContain("create or replace function public.save_series_composition_default");
    expect(migration).toContain("coalesce(candidate.series_rules -> 'hyperframes_composition'");
    expect(migration).toContain("create function public.request_review_render_revision(p_review_package_id uuid, p_composition jsonb, p_reason text)");
  });

  it("清除系列高级规则，并让审核渲染只使用系统初始配置或 Studio 修订", () => {
    const migration = readFileSync(removeSeriesAdvancedRulesMigration, "utf8");

    expect(migration).toContain("drop function if exists public.save_series_composition_default(uuid, jsonb)");
    expect(migration).toContain("Series rules must contain only supported creative baseline fields");
    expect(migration).toContain("'系统初始合成配置。'");
    expect(migration).not.toContain("series_rules");
  });

  it("仅允许 Owner 把本地冻结的 Studio 工程提交为审核修订", () => {
    const migration = readFileSync(hyperframesStudioRevisionMigration, "utf8");

    expect(migration).toContain("'studio_project'");
    expect(migration).toContain("'Invalid frozen Studio project'");
    expect(migration).toContain("grant execute on function public.request_review_render_revision(uuid, jsonb, text) to authenticated");
  });

  it("Studio 结构修改会返回分镜返工，而不是直接重渲染", () => {
    const migration = readFileSync(studioStructuralRevisionMigration, "utf8");
    expect(migration).toContain("create function public.request_studio_storyboard_revision");
    expect(migration).toContain("'qc_review', 'visual_approved'");
    expect(migration).toContain("perform public.orchestrate_storyboard_tasks_for_episode(selected_episode.id)");
    expect(migration).toContain("'storyboard_review', 'changes_requested'");
    expect(migration).toContain("selected_pre_render_package.context_snapshot ->> 'storyboard_review_package_id'");
    expect(migration).toContain("grant execute on function public.request_studio_storyboard_revision(uuid, text) to authenticated");
  });

  it("Studio 结构返工不会给已批准的分镜包重复绑定审批记录", () => {
    const migration = readFileSync(studioStructuralReworkApprovalMigration, "utf8");

    expect(migration).not.toContain("insert into public.approvals");
    expect(migration).toContain("'studio_storyboard_revision_requested'");
  });

  it("两类审核修订共享当前包与 Owner 前置条件，但保留各自编排", () => {
    const migration = readFileSync(reviewRevisionPreconditionsMigration, "utf8");

    expect(migration).toContain("create function public.current_hyperframes_review_package");
    expect(migration).toContain("for update");
    expect(migration).toContain("membership_role is distinct from 'owner'");
    expect(migration).toContain("revoke all on function public.current_hyperframes_review_package(uuid, boolean) from public, anon, authenticated");
    expect(migration).toContain("select * into selected_package from public.current_hyperframes_review_package(p_review_package_id, true)");
    expect(migration).toContain("select * into selected_qc_package from public.current_hyperframes_review_package(p_review_package_id, false)");
    expect(migration).toContain("perform public.orchestrate_storyboard_tasks_for_episode(selected_episode.id)");
  });

  it("逐镜头准备草稿只允许 Owner 保存当前已批准分镜的镜头", () => {
    const migration = readFileSync(shotPreparationDraftMigration, "utf8");

    expect(migration).toContain("create table public.shot_preparation_drafts");
    expect(migration).toContain("unique (episode_id, review_package_id, shot_id)");
    expect(migration).toContain("current_episode.stage <> 'storyboard_approved'");
    expect(migration).toContain("membership.role = 'owner'");
    expect(migration).toContain("The shot does not belong to the approved storyboard");
    expect(migration).toContain("on conflict (episode_id, review_package_id, shot_id) do update");
    expect(migration).toContain("seed_shot_preparation_drafts_after_storyboard_approval");
  });

  it("逐镜头 TTS 只在显式请求时创建冻结任务，并在成功后切换版本", () => {
    const migration = readFileSync(shotTtsMigration, "utf8");

    expect(migration).toContain("create function public.generate_shot_tts");
    expect(migration).toContain("p_retry boolean default false");
    expect(migration).toContain("shot_preparation");
    expect(migration).toContain("current_audio_track_id");
    expect(migration).toContain("pending_tts_task_id");
    expect(migration).toContain("sync_shot_tts_audio_after_insert");
    expect(migration).toContain("tts_error");
  });

  it("逐镜头 TTS 复用已完成任务时恢复当前音轨，否则创建新任务", () => {
    const migration = readFileSync(reusedShotTtsTrackMigration, "utf8");

    expect(migration).toContain("create or replace function public.restore_completed_shot_tts_track");
    expect(migration).toContain("candidate.episode_id = draft.episode_id");
    expect(migration).toContain("candidate.source_review_package_id = draft.review_package_id");
    expect(migration).toContain("candidate.cue_id = draft.shot_id");
    expect(migration).toContain("candidate.source_task_id = p_task_id");
    expect(migration).toContain("current_audio_track_id = track.id");
    expect(migration).toContain("pending_tts_task_id = null");
    expect(migration).toContain("audio_status = 'ready'");
    expect(migration).toContain("existing_task.status in (''ready'', ''running'')");
    expect(migration).toContain("existing_task.status = ''completed'' and public.restore_completed_shot_tts_track");
    expect(migration).toContain("shot_tts_completed_track_reused");
    expect(migration).toContain("revoke all on function public.restore_completed_shot_tts_track(uuid,uuid) from public,anon,authenticated");
  });

  it("逐镜头 TTS 使用 Owner 归属字段校验连接版本", () => {
    const migration = readFileSync(shotTtsConnectionOwnershipFixMigration, "utf8");

    expect(migration).toContain("connection.account_id = current_episode.account_id");
    expect(migration).toContain("connection.created_by = auth.uid()");
    expect(migration).toContain("if patched_definition = definition then");
  });

  it("逐镜头 TTS 明确使用局部配置变量", () => {
    const migration = readFileSync(shotTtsVariableConflictFixMigration, "utf8");

    expect(migration).toContain("#variable_conflict use_variable");
    expect(migration).toContain("pg_get_functiondef('public.generate_shot_tts(uuid,uuid,text,boolean)'::regprocedure)");
  });

  it("逐镜头 TTS 只接受已完成且匹配当前镜头的音轨", () => {
    const migration = readFileSync(shotTtsTrackSyncHardeningMigration, "utf8");

    expect(migration).toContain("if not found then return new; end if;");
    expect(migration).toContain("source_task.status <> 'completed'");
    expect(migration).toContain("new.track_kind <> 'narration'");
    expect(migration).toContain("and episode_id = source_task.episode_id");
    expect(migration).toContain("and audio_mode = 'tts'");
    expect(migration).toContain("new.source_review_package_id is not distinct from review_package_id");
    expect(migration).toContain("new.cue_id is not distinct from shot_id");
  });

  it("逐镜头 TTS 以已确认正文驱动生成，并保留历史音轨与单镜头覆盖", () => {
    const migration = readFileSync(shotTtsConfirmationMigration, "utf8");

    expect(migration).toContain("tts_text_confirmation_fingerprint");
    expect(migration).toContain("tts_text_confirmed_by");
    expect(migration).toContain("set_shot_tts_confirmation");
    expect(migration).toContain("save_shot_tts_override");
    expect(migration).toContain("tts_override_voice");
    expect(migration).toContain("reset_shot_tts_confirmation_after_text_change");
    expect(migration).toContain("Episode TTS settings must preserve shot overrides");
    expect(migration).toContain("create or replace function public.assert_current_storyboard_shot");
    expect(migration).toContain("package.episode_id = p_episode_id");
    expect(migration).toContain("package.stage = 'storyboard_review'");
    expect(migration).toContain("package.invalidated_at is null");
    expect(migration).toContain("approval.stage = 'storyboard_approved'");
    expect(migration).toContain("approval.decision = 'approved'");
    expect(migration).toContain("The shot does not belong to the approved storyboard");
    expect(migration.match(/perform public\.assert_current_storyboard_shot\(/g)).toHaveLength(2);
    expect(migration).toContain("口播内容必须先保存并确认");
    expect(migration).toContain("current_audio_track_id = null");
    expect(migration).toContain("Shot TTS override changed.");
  });

  it("逐镜头 TTS 可直接使用已保存正文生成，同时保留原有输入校验", () => {
    const migration = readFileSync(perShotTtsGenerationMigration, "utf8");

    expect(migration).toContain("pg_get_functiondef('public.generate_shot_tts(uuid,uuid,text,boolean)'::regprocedure)");
    expect(migration).toContain("tts_text_confirmation_fingerprint");
    expect(migration).toContain("replace(definition, confirmation_guard, '')");
  });

  it("逐镜头裁剪只在显式请求时创建幂等 Worker 任务，并保留旧片段", () => {
    const migration = readFileSync(shotClipMigration, "utf8");

    expect(migration).toContain("create or replace function public.save_shot_clip_draft");
    expect(migration).toContain("create function public.generate_shot_clip");
    expect(migration).toContain("p_retry boolean default false");
    expect(migration).toContain("ffmpeg_trim_video");
    expect(migration).toContain("pending_video_task_id");
    expect(migration).toContain("current_video_artifact_id");
    expect(migration).toContain("sync_shot_clip_task_after_update");
    expect(migration).toContain("status in ('ready', 'running', 'completed')");
    expect(migration).toContain("where id = draft_id and pending_video_task_id = new.id");
  });

  it("裁剪生成允许计划时长差异，并完整替代旧的单段生成定义", () => {
    const migration = readFileSync(editableShotClipGenerationMigration, "utf8");
    const segments = [{ start_seconds: 0, end_seconds: 5.8 }];
    const totalDuration = segments.reduce((total, segment) => total + segment.end_seconds - segment.start_seconds, 0);

    expect(totalDuration).toBe(5.8);
    expect(Math.abs(totalDuration - 5)).toBeGreaterThan(0.05);
    expect(migration).toContain("create or replace function public.generate_shot_clip");
    expect(migration).toContain("jsonb_array_elements(draft.clip_segments)");
    expect(migration).toContain("'target_duration_seconds', total_duration");
    expect(migration).not.toContain("abs(total_duration - (selected_shot ->> 'durationSeconds')::numeric) > 0.05");
    expect(migration).not.toContain("Clip duration must match the approved storyboard duration");
  });

  it("逐镜头原声与无口播模式保留可追溯版本，并在当前片段变化后失效", () => {
    const migration = readFileSync(shotAudioModesMigration, "utf8");

    expect(migration).toContain("track_kind in ('narration', 'source', 'derived', 'bgm', 'sfx')");
    expect(migration).toContain("create function public.generate_shot_source_audio");
    expect(migration).toContain("source_video_artifact");
    expect(migration).toContain("shot_source_audio");
    expect(migration).toContain("audio_mode = 'none'");
    expect(migration).toContain("create trigger invalidate_shot_source_audio_after_clip_change");
    expect(migration).toContain("status = 'superseded'");
    expect(migration).toContain("source_audio_error");
  });

  it("最新镜头音频模式不创建原声任务，并清除旧音频引用", () => {
    const migration = readFileSync(enforcedShotAudioModesMigration, "utf8");

    expect(migration).toContain("p_audio_mode in (''none'', ''source'') then ''ready''");
    expect(migration).toContain("excluded.audio_mode in (''none'', ''source'')");
    expect(migration).toContain("audio_mode in (''none'', ''source'') then ''ready''");
    expect(migration).toContain("source_audio_duration_seconds = null");
    expect(migration).toContain("pending_source_audio_task_id = null");
    expect(migration).toContain("source_audio_error = null");
    expect(migration).not.toContain("update public.shot_preparation_drafts");
    expect(migration).not.toContain("delete from public.audio_tracks");
    expect(migration).not.toContain("delete from public.tasks");
    expect(migration).toContain("revoke all on function public.generate_shot_source_audio");
  });

  it("source 模式的三端时长判定都只使用当前片段时长", () => {
    const migration = readFileSync(enforcedShotAudioModesMigration, "utf8");
    const durationMigration = readFileSync(durationDecisionMigration, "utf8");
    const reviewVideoMigration = readFileSync(shotReviewVideoMigration, "utf8");
    const app = readFileSync(resolve("src/episodes/EpisodeProduction.tsx"), "utf8");

    expect(migration).toContain("draft.audio_mode = ''source'' then draft.video_duration_seconds");
    expect(migration).toContain("elsif draft.audio_mode = ''source'' then");
    expect(migration).toContain("audio_duration := video_duration;");
    expect(durationMigration).toContain("draft.audio_mode = ''source'' then coalesce(draft.source_audio_duration_seconds, draft.video_duration_seconds)");
    expect(reviewVideoMigration).toContain("draft.audio_mode = 'source' then coalesce(draft.source_audio_duration_seconds, draft.video_duration_seconds)");
    expect(app).toContain('draft.audio_mode === "source" ? draft.video_duration_seconds ?? null');
    expect(app).toContain('audioMode === "source" ? (segmentsValid ? totalClipDuration : null)');
  });

  it("051300 回放后每个 current/source 字段只保留一个 UPDATE 赋值", () => {
    const enforcedMigration = readFileSync(enforcedShotAudioModesMigration, "utf8");
    const shotAudioModes = readFileSync(shotAudioModesMigration, "utf8");
    const ttsSettings = readFileSync(shotTtsEpisodeSettingsMigration, "utf8");
    const ttsConfirmation = readFileSync(shotTtsConfirmationMigration, "utf8");
    const editableWorkbench = readFileSync(editableShotWorkbenchMigration, "utf8");

    let saveDefinition = extractFunctionDefinition(shotAudioModes, "save_shot_preparation_draft");
    const saveSignature = "save_shot_preparation_draft(uuid,uuid,text,text,text,boolean,text,text,numeric)";
    saveDefinition = applyMigrationPatches(saveDefinition, extractDollarReplacePatches(ttsSettings, saveSignature));
    saveDefinition = applyMigrationPatches(saveDefinition, extractLiteralReplacePatches(ttsConfirmation, saveSignature));
    saveDefinition = applyMigrationPatches(saveDefinition, extractLiteralReplacePatches(enforcedMigration, saveSignature));
    for (const column of ["current_audio_track_id", "pending_source_audio_task_id", "source_audio_duration_seconds", "source_audio_error"]) {
      expect(assignmentCount(saveDefinition, column), column).toBe(1);
    }
    expect(saveDefinition).toContain("existing_draft.tts_override_voice");
    expect(ttsConfirmation).toContain("tts_text_confirmation_fingerprint");

    let workbenchDefinition = extractFunctionDefinition(readFileSync(frozenMultiSegmentShotDraftMigration, "utf8"), "save_shot_workbench_draft");
    const workbenchSignature = "save_shot_workbench_draft(uuid, uuid, text, uuid, jsonb, text, text, boolean, text, text, numeric)";
    workbenchDefinition = applyMigrationPatches(workbenchDefinition, extractLiteralReplacePatches(editableWorkbench, workbenchSignature));
    workbenchDefinition = applyMigrationPatches(workbenchDefinition, extractLiteralReplacePatches(enforcedMigration, "save_shot_workbench_draft(uuid,uuid,text,uuid,jsonb,text,text,boolean,text,text,numeric)"));
    for (const column of ["current_audio_track_id", "pending_source_audio_task_id", "source_audio_duration_seconds", "source_audio_error"]) {
      expect(assignmentCount(workbenchDefinition, column), column).toBe(1);
    }
  });

  it("逐镜头确认要求同步证据、显式警告接受，并在输入变化后撤销", () => {
    const migration = readFileSync(shotConfirmationMigration, "utf8");

    expect(migration).toContain("create function public.confirm_shot_preparation");
    expect(migration).toContain("Duration mismatch must be explicitly accepted before confirmation");
    expect(migration).toContain("shot_duration_warning_accepted");
    expect(migration).toContain("create function public.skip_shot_preparation");
    expect(migration).toContain("create trigger reset_shot_preparation_confirmation_after_input_change");
    expect(migration).toContain("confirmation_status = 'confirmed'");
    expect(migration).toContain("create_shot_preparation_review_package");
  });

  it("Studio 只冻结当前确认镜头，并把确认快照传入 HyperFrames", () => {
    const migration = readFileSync(confirmedStudioSnapshotMigration, "utf8");

    expect(migration).toContain("draft.input_fingerprint is distinct from md5(shot::text)");
    expect(migration).toContain("Superseded by the current confirmed storyboard snapshot");
    expect(migration).toContain("'confirmation_mode', candidate.context_snapshot -> 'confirmation_mode'");
    expect(migration).toContain("'confirmed_shots', candidate.context_snapshot -> 'confirmed_shots'");
    expect(migration).toContain("'artifact_id', member.artifact_id");
    expect(migration).toContain("'audio_track_id', member.audio_track_id");
    expect(migration).toContain("'approval_mode', 'qc_only'");
  });

  it("Worker 由平台计算并发、声明文件能力，并持续记录实际成本", () => {
    const migration = readFileSync(workerRuntimeConstraintsMigration, "utf8");

    expect(migration).toContain("create or replace function public.worker_runtime_constraints");
    expect(migration).toContain("least(coalesce(provider_limit, adapter_limit), adapter_limit, worker_limit)");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("drop trigger if exists guard_b_roll_task_claim_before_running on public.tasks");
    expect(migration).toContain("worker_required_tools");
    expect(migration).toContain("p_worker_capacity");
    expect(migration).toContain("Actual cost is recorded after execution");
    expect(migration).not.toContain("budget_limit_cents = 2147483647");
  });

  it("Episode 拥有本期 TTS 设置，并以完整指纹判定当前音轨", () => {
    const migration = readFileSync(resolve("supabase/migrations/20260904160000_move_tts_settings_to_episode.sql"), "utf8");

    expect(migration).toContain("add column if not exists tts_language_code text");
    expect(migration).toContain("create or replace function public.save_episode_tts_settings");
    expect(migration).toContain("Episode TTS settings changed.");
    expect(migration).toContain("create or replace function public.shot_tts_configuration_hash");
    expect(migration).toContain("configuration_hash' = public.shot_tts_configuration_hash(p_episode_id, draft.id)");
    expect(migration).toContain("grant execute on function public.save_episode_tts_settings");
  });

  it("批量 TTS 只读取持久化草稿，并逐项幂等归类", () => {
    const migration = readFileSync(batchShotTtsMigration, "utf8");

    expect(migration).toContain("create function public.generate_confirmed_shot_tts_batch");
    expect(migration).toContain("join public.account_memberships membership");
    expect(migration).toContain("draft.tts_text_confirmation_fingerprint");
    expect(migration).toContain("public.shot_tts_configuration_hash");
    expect(migration).toContain("draft.tts_speaking_rate <= 0");
    expect(migration).toContain("credential_ref !~");
    expect(migration).toContain("version.id::text = credential_ref");
    expect(migration).not.toContain("or case when credential_ref ~");
    expect(migration).toContain("order by task.created_at desc\n    limit 1\n    for update;");
    expect(migration).toContain("status in ('ready', 'running', 'completed')");
    expect(migration).toContain("public.generate_shot_tts");
    expect(migration).toContain("exception when others");
    expect(migration).toContain("shot_tts_batch_generation_requested");
    expect(migration).toContain("grant execute on function public.generate_confirmed_shot_tts_batch");
  });

  it("批量 TTS 前向迁移只接受旧态或已修复态，并按 Owner 归属连接", () => {
    const migration = readFileSync(batchShotTtsConnectionOwnershipFixMigration, "utf8");

    expect(migration).toContain("pg_get_functiondef('public.generate_confirmed_shot_tts_batch(uuid,uuid)'::regprocedure)");
    expect(migration).toContain("ownership_state := 'new';");
    expect(migration).toContain("elsif position(old_block in definition) > 0 then");
    expect(migration).toContain("join public.account_memberships connection_owner");
    expect(migration).toContain("connection_owner.user_id = connection.created_by");
    expect(migration).toContain("connection_owner.role = 'owner'");
    expect(migration).toContain("old_variable_block text := E'AS $function$\\ndeclare';");
    expect(migration).toContain("new_variable_block text := E'AS $function$\\n#variable_conflict use_variable\\ndeclare';");
    expect(migration).toContain("variable_conflict_state := 'new';");
    expect(migration).toContain("elsif position(old_variable_block in definition) > 0 then");
    expect(migration).toContain("if ownership_state = 'old' then patched := replace(patched, old_block, new_block); end if;");
    expect(migration).toContain("if variable_conflict_state = 'old' then patched := replace(patched, old_variable_block, new_variable_block); end if;");
    expect(migration).toContain("if patched = definition then");
    expect(migration).toContain("and connection.account_id = current_episode.account_id");
    expect(migration).toContain("connection ownership clauses were neither the old nor new form");
    expect(migration).toContain("variable conflict declaration was neither the old nor new form");
    expect(migration.match(/\bexecute patched;/g)).toHaveLength(1);
  });

  it("准备片段前向迁移允许替换已完成的旧 A-roll 任务", () => {
    const migration = readFileSync(completedShotClipReplacementMigration, "utf8");

    expect(migration).toContain("pg_get_functiondef('public.generate_shot_clip(uuid,uuid,text,boolean)'::regprocedure)");
    expect(migration).toContain("old_block text := $old$");
    expect(migration).toContain("new_block text := $new$");
    expect(migration).toContain("and task.input_snapshot ->> 'storyboard_review_package_id' = p_review_package_id::text");
    expect(migration).toContain("and task.input_snapshot #>> '{shot,id}' = draft.shot_id");
    expect(migration).toContain("and coalesce(task.input_snapshot ->> 'pre_render_revision', '') = ''");
    expect(migration).toContain("old_running_block text := $old_running$");
    expect(migration).toContain("and task.status <> 'superseded';$new$");
    expect(migration).toContain("if position(new_block in definition) > 0 then return; end if;");
    expect(migration).toContain("if position(old_block in definition) = 0 and position(old_running_block in definition) = 0 then");
    expect(migration).toContain("patched := replace(definition, old_block, new_block);");
    expect(migration).toContain("patched := replace(definition, old_running_block, new_block);");
    expect(migration).toContain("if patched = definition then");
    expect(migration.match(/\bexecute patched;/g)).toHaveLength(1);
  });

  it("历史 Episode 固化旧声音兼容值，新 Episode 不再从蓝图读取声音默认", () => {
    const migration = readFileSync(episodeTtsOwnershipMigration, "utf8");
    const app = readFileSync(resolve("src/episodes/EpisodeProduction.tsx"), "utf8");

    expect(migration).toContain("update public.episodes episode");
    expect(migration).toContain("Episode TTS settings must preserve shot confirmation");
    expect(migration).toContain("existing_draft.tts_override_voice");
    expect(migration).toContain("New Episode TTS defaults must not read blueprint voice fields");
    expect(app).toContain('voice: episode.tts_voice ?? ""');
    expect(app).toContain('speakingRate: episode.tts_speaking_rate == null ? ""');
    expect(app).not.toContain("legacyNarrationSettings");
  });

  it("按 041600→041700→051100→051300→051500 逐项重放 TTS 动态补丁", () => {
    const ttsSettings = readFileSync(shotTtsEpisodeSettingsMigration, "utf8");
    const ttsConfirmation = readFileSync(shotTtsConfirmationMigration, "utf8");
    const editableWorkbench = readFileSync(editableShotWorkbenchMigration, "utf8");
    const enforcedAudioModes = readFileSync(enforcedShotAudioModesMigration, "utf8");
    const ownership = readFileSync(episodeTtsOwnershipMigration, "utf8");

    const episodeSignature = "save_episode_tts_settings(uuid,text,text,numeric)";
    let episodeDefinition = extractFunctionDefinition(ttsSettings, "save_episode_tts_settings");
    episodeDefinition = applyMigrationPatchesExactly(episodeDefinition, extractLiteralReplacePatches(ttsConfirmation, episodeSignature));
    episodeDefinition = applyMigrationPatchesExactly(episodeDefinition, extractDollarReplacePatches(ownership, episodeSignature, "if patched = definition"));
    expect(episodeDefinition).toContain("update public.tasks task");
    expect(episodeDefinition).toContain("status = 'superseded'");
    expect(episodeDefinition).toContain("current_audio_track_id = null");
    expect(episodeDefinition).toContain("current_tts_task_id = null");
    expect(episodeDefinition).toContain("pending_tts_task_id = null");
    expect(episodeDefinition).not.toContain("confirmation_status = 'pending'");
    expect(episodeDefinition).not.toContain("confirmed_at = null");
    expect(episodeDefinition).not.toContain("confirmed_by = null");

    const shotSignature = "save_shot_preparation_draft(uuid,uuid,text,text,text,boolean,text,text,numeric)";
    let shotDefinition = extractFunctionDefinition(readFileSync(shotAudioModesMigration, "utf8"), "save_shot_preparation_draft");
    shotDefinition = applyMigrationPatchesExactly(shotDefinition, extractDollarReplacePatches(ttsSettings, shotSignature, "if patched_definition = definition"));
    shotDefinition = applyMigrationPatchesExactly(shotDefinition, extractLiteralReplacePatches(ttsConfirmation, shotSignature));
    shotDefinition = applyMigrationPatchesExactly(shotDefinition, extractLiteralReplacePatches(enforcedAudioModes, shotSignature));
    shotDefinition = applyMigrationPatchesExactly(shotDefinition, extractDollarReplacePatches(ownership, shotSignature, "if patched = definition"));
    expect(shotDefinition).toContain("next_tts_voice := coalesce(existing_draft.tts_override_voice, current_episode.tts_voice, nullif(btrim(p_tts_voice), ''), existing_draft.tts_voice);");
    expect(shotDefinition).toContain("next_tts_rate := coalesce(existing_draft.tts_override_speaking_rate, current_episode.tts_speaking_rate, p_tts_speaking_rate, existing_draft.tts_speaking_rate);");
    expect(shotDefinition).toContain("next_language_code := coalesce(current_episode.tts_language_code, existing_draft.tts_language_code, 'zh-CN');");
    expect(shotDefinition).not.toContain("blueprint_policy #>> '{narration,voice");

    const overrideSignature = "save_shot_tts_override(uuid, uuid, text, text, numeric)";
    let overrideDefinition = extractFunctionDefinition(ttsConfirmation, "save_shot_tts_override");
    overrideDefinition = applyMigrationPatchesExactly(overrideDefinition, extractLiteralReplacePatches(editableWorkbench, overrideSignature));
    overrideDefinition = applyMigrationPatchesExactly(overrideDefinition, extractDollarReplacePatches(ownership, "save_shot_tts_override(uuid,uuid,text,text,numeric)", "if patched = definition"));
    expect(overrideDefinition).toContain("default_voice := current_episode.tts_voice;");
    expect(overrideDefinition).toContain("default_rate := current_episode.tts_speaking_rate;");
    expect(overrideDefinition).not.toContain("blueprint_policy #>> '{narration,voice");

    let hashDefinition = extractFunctionDefinition(ttsSettings, "shot_tts_configuration_hash");
    hashDefinition = applyMigrationPatchesExactly(hashDefinition, extractDollarReplacePatches(ownership, "shot_tts_configuration_hash(uuid,uuid)", "if patched = definition"));
    expect(hashDefinition).toContain("'provider', provider");
    expect(hashDefinition).toContain("'adapter', adapter");
    expect(hashDefinition).toContain("'model', model");
    expect(hashDefinition).toContain("'prompt_version', prompt_version");
    expect(hashDefinition).toContain("'connection_version_id', credential_ref");
    expect(hashDefinition).not.toContain("narration_config #>> '{voice");
  });

  it("镜头时长迁移使用系列合成设置并拒绝静默替换", () => {
    const migration = readFileSync(durationDecisionMigration, "utf8");

    expect(migration).toContain("create or replace function public.shot_duration_settings");
    expect(migration).toContain("create or replace function public.shot_duration_decision");
    expect(migration).toContain("public._required_text_replace");
    expect(migration).toContain("request_review_render_revision");
    expect(migration).toContain("Studio duration settings must match the frozen shot duration settings");
    expect(migration).not.toContain("shot_duration_frame_rate");
  });

  it("时长函数固定空 search_path", () => {
    const migration = readFileSync(durationSearchPathMigration, "utf8");

    expect(migration).toContain("alter function public.shot_duration_settings(uuid)\nset search_path = '';");
    expect(migration).toContain("alter function public.shot_duration_decision(text, numeric, numeric, numeric, numeric, integer, numeric)\nset search_path = '';");
  });

  it("按迁移顺序重放时长补丁，并保留最终函数与 TTS 指纹门禁", () => {
    const migration = readFileSync(durationDecisionMigration, "utf8");
    const definitions = new Map<string, string>([
      [
        "request_review_render_revision(uuid, jsonb, text)",
        extractFunctionDefinition(readFileSync(frozenStudioProjectPathMigration, "utf8"), "request_review_render_revision"),
      ],
      [
        "create_shot_preparation_review_package(uuid, uuid)",
        extractFunctionDefinition(readFileSync(deferredStudioTrimmingMigration, "utf8"), "create_shot_preparation_review_package"),
      ],
      [
        "freeze_shot_preparation_batch(uuid, uuid)",
        extractFunctionDefinition(readFileSync(deferredStudioTrimmingMigration, "utf8"), "freeze_shot_preparation_batch"),
      ],
      [
        "confirm_shot_preparation(uuid, uuid, text, text, boolean)",
        extractFunctionDefinition(readFileSync(shotConfirmationMigration, "utf8"), "confirm_shot_preparation"),
      ],
      [
        "orchestrate_review_render_tasks(uuid)",
        extractFunctionDefinition(readFileSync(deferredStudioTrimmingMigration, "utf8"), "orchestrate_review_render_tasks"),
      ],
    ]);

    const ttsGuardSource = "and task.input_snapshot #>> '{media,narration,text}' = draft.tts_text";
    const ttsGuardReplacement = `${ttsGuardSource}\n        and task.input_snapshot ->> 'configuration_hash' = public.shot_tts_configuration_hash(p_episode_id, draft.id)`;
    const freezeDefinition = definitions.get("freeze_shot_preparation_batch(uuid, uuid)");
    expect(freezeDefinition).toContain(ttsGuardSource);
    definitions.set("freeze_shot_preparation_batch(uuid, uuid)", freezeDefinition!.replace(ttsGuardSource, ttsGuardReplacement));

    const patches = extractRequiredMigrationPatches(migration);
    expect(patches).not.toHaveLength(0);
    for (const patch of patches) {
      const definition = definitions.get(patch.signature);
      expect(definition, patch.label).toBeDefined();
      expect(definition, patch.label).toContain(patch.source);
      definitions.set(patch.signature, definition!.replace(patch.source, patch.replacement));
    }

    expect(definitions.get("request_review_render_revision(uuid, jsonb, text)")).toContain("'studio_project'");
    expect(definitions.get("freeze_shot_preparation_batch(uuid, uuid)")).toContain("configuration_hash' = public.shot_tts_configuration_hash");
    expect(definitions.get("create_shot_preparation_review_package(uuid, uuid)")).toContain("'duration_decision', duration_decision");
    expect(definitions.get("confirm_shot_preparation(uuid, uuid, text, text, boolean)")).toContain("audio_video_delta_seconds");
    expect(definitions.get("orchestrate_review_render_tasks(uuid)")).toContain("'duration_decision', member.evidence_snapshot -> 'duration_decision'");
  });

  it("审核视频只在显式 Owner 操作时冻结整单，并把不可变输入交给 Worker", () => {
    const migration = readFileSync(shotReviewVideoMigration, "utf8");
    const editableWorkbench = readFileSync(editableShotWorkbenchMigration, "utf8");
    const definition = extractFunctionDefinition(migration, "generate_shot_review_video");
    const packageDefinition = extractFunctionDefinition(readFileSync(deferredStudioTrimmingMigration, "utf8"), "create_shot_preparation_review_package");
    const orchestrationDefinition = extractFunctionDefinition(readFileSync(deferredStudioTrimmingMigration, "utf8"), "orchestrate_review_render_tasks");

    expect(definition).toContain("p_studio_project jsonb");
    expect(definition).toContain("membership.role = 'owner'");
    expect(definition).toContain("for update of episode");
    expect(definition).toContain("tts_text_confirmation_fingerprint");
    expect(definition).toContain("public.shot_tts_configuration_hash(p_episode_id, draft.id)");
    expect(definition).toContain("public.shot_duration_decision");
    expect(definition).toContain("p_accept_duration_risk");
    expect(definition).toContain("p_risk_reason");
    expect(definition).toContain("p_studio_project ->> 'relative_path'");
    expect(definition).toContain("public.create_shot_preparation_review_package");
    expect(definition).toContain("public.review_render_composition_revisions");
    expect(definition).toContain("public.orchestrate_review_render_tasks");
    expect(definition).toContain("effective_runtime_constraints");
    expect(definition).toContain("blueprint_version_id");
    expect(definition).toContain("series_version_id");
    expect(definition).toContain("studio_project_revision");
    expect(definition).toContain("default_composition || coalesce(series_rules -> 'hyperframes_composition'");
    expect(definition).toContain("'frame_rate', (duration_settings ->> 'frame_rate')::numeric");
    expect(packageDefinition).toContain("'source_material_revision_id'");
    expect(packageDefinition).toContain("'clip_segments'");
    expect(orchestrationDefinition).toContain("'source_material_revision_id'");
    expect(orchestrationDefinition).toContain("'clip_segments'");
    expect(definition.indexOf("if risk_count = 0 and p_accept_duration_risk")).toBeLessThan(definition.indexOf("update public.shot_preparation_drafts"));
    expect(definition.indexOf("insert into public.review_render_composition_revisions")).toBeLessThan(definition.indexOf("public.orchestrate_review_render_tasks"));
    expect(migration).toContain("revoke all on function public.freeze_shot_preparation_batch(uuid, uuid) from authenticated");
    expect(editableWorkbench).not.toContain("freeze_shot_preparation_batch");
  });

  it("审核视频和修订同时接受 OpenChatCut JSON 与历史 Studio HTML 冻结工程", () => {
    const migration = readFileSync(openChatCutFrozenPathMigration, "utf8");

    expect(migration).toContain("pg_get_functiondef('public.generate_shot_review_video(uuid, uuid, jsonb, boolean, text)'::regprocedure)");
    expect(migration).toContain("pg_get_functiondef('public.request_review_render_revision(uuid, jsonb, text)'::regprocedure)");
    expect(migration).toContain("studio-frozen/[0-9a-f-]{36}/index[.]html|openchatcut-frozen/[0-9a-f-]{36}/project[.]json");
    expect(migration).toContain("/openchatcut-frozen/([^/]+)/project[.]json$");
    expect(migration).toContain("OpenChatCut path patch has unknown or partial state");
    expect(migration).toContain("OpenChatCut path patch produced an invalid state");
  });

  it("审核提交后保留可编辑草稿，并从当前保存输入创建下一版冻结快照", () => {
    const migration = readFileSync(editableSubmittedWorkbenchMigration, "utf8");

    expect(migration).toContain("current_episode.stage not in (''storyboard_approved'', ''render_ready'', ''qc_review'')");
    expect(migration).toContain("episode.stage in (''storyboard_approved'', ''render_ready'', ''qc_review'')");
    expect(migration).toContain("current_stage not in (''storyboard_approved'', ''render_ready'', ''qc_review'')");
    expect(migration).toContain("task.status in (''ready'', ''running'')");
    expect(migration).toContain("A review render is already queued or running for this Episode");
    expect(migration).toContain("values (p_episode_id, current_episode.stage, ''production_ready''");
    expect(migration).toContain("old_draft_update");
    expect(migration).toContain("replace(patched, old_draft_update, '')");
    expect(migration).toContain("current shot snapshot editable-draft patch");
    expect(migration).not.toContain("update public.shot_preparation_drafts set frozen_at = now()");
  });

  it("预渲染审核期间继续允许修改镜头工作版本", () => {
    const migration = readFileSync(editablePreRenderWorkbenchMigration, "utf8");

    expect(migration).toContain("(''storyboard_approved'', ''production_ready'', ''render_ready'', ''qc_review'')");
    expect(migration).toContain("public.generate_shot_review_video(uuid, uuid, jsonb, boolean, text)");
    expect(migration).toContain("public.protect_frozen_shot_preparation_inputs()");
    expect(migration).toContain("pre-render editable-stage patch has unknown or partial state");
    expect(migration).toContain("pre-render editable-stage patch produced an invalid state");
  });

  it("生成审核视频复用已就绪口播，不再重复要求逐镜确认", () => {
    const migration = readFileSync(shotReviewVideoActionMigration, "utf8");
    expect(migration).toContain("pg_get_functiondef('public.generate_shot_review_video(uuid, uuid, jsonb, boolean, text)'::regprocedure)");
    expect(migration).toContain("if coalesce(btrim(draft.tts_text), '''') = '''' then");
    expect(migration).not.toContain("new_guard constant text := '      if coalesce(btrim(draft.tts_text), '''') = ''''\n        or draft.tts_text_confirmation_fingerprint");
  });

  it("生成审核视频只在字幕开启时要求字幕正文", () => {
    const migration = readFileSync(disabledSubtitleReviewVideoMigration, "utf8");
    expect(migration).toContain("pg_get_functiondef('public.generate_shot_review_video(uuid, uuid, jsonb, boolean, text)'::regprocedure)");
    expect(migration).toContain("or coalesce(btrim(draft.subtitle_text), '''') = ''''");
    expect(migration).toContain("or (draft.subtitles_enabled and coalesce(btrim(draft.subtitle_text), '''') = '''')");
  });

  it("不可变镜头快照只在字幕开启时要求字幕正文", () => {
    const migration = readFileSync(disabledSubtitleShotSnapshotMigration, "utf8");
    expect(migration).toContain("pg_get_functiondef('public.has_current_shot_preparation_snapshot(uuid, uuid)'::regprocedure)");
    expect(migration).toContain("and draft.input_fingerprint = md5(required.value::text) and draft.subtitle_text <> ''");
    expect(migration).toContain("and draft.input_fingerprint = md5(required.value::text) and (not draft.subtitles_enabled or coalesce(btrim(draft.subtitle_text), '''') <> '''')");
  });

  it("只重新排队因旧字幕契约阻塞的审核渲染任务", () => {
    const migration = readFileSync(disabledSubtitleReviewRenderRetryMigration, "utf8");
    expect(migration).toContain("task.task_type = 'generate_review_render'");
    expect(migration).toContain("blocker ->> 'detail' = '确认快照缺少字幕文本。'");
    expect(migration).toContain("shot -> 'subtitles_enabled' = 'false'::jsonb");
    expect(migration).toContain("max_attempts = greatest(task.max_attempts, task.attempt + 1)");
  });

  it("事务模型回放会拒绝非 Owner、无风险却接受风险，并保留每次 Studio 证据", () => {
    const studioV1 = { file_size: 10, relative_path: "episodes/episode-1/studio-frozen/v1/index.html", sha256: "a".repeat(64) };
    const studioV2 = { file_size: 20, relative_path: "episodes/episode-1/studio-frozen/v2/index.html", sha256: "b".repeat(64) };
    const initial: ShotGenerationReplayState = { drafts: [{ id: "draft-1", frozen: false, sourceMaterialRevisionId: "material-1", clipSegments: [{ startSeconds: 1, endSeconds: 3 }] }], packages: [], revisions: [], tasks: [] };
    expect(() => replayShotGeneration(initial, { acceptDurationRisk: false, isOwner: false, riskCount: 0, riskReason: "", studioProject: studioV1 })).toThrow("Owner");
    expect(() => replayShotGeneration(initial, { acceptDurationRisk: true, isOwner: true, riskCount: 0, riskReason: "误点", studioProject: studioV1 })).toThrow("duration risk");
    expect(initial).toEqual({ drafts: [{ id: "draft-1", frozen: false, sourceMaterialRevisionId: "material-1", clipSegments: [{ startSeconds: 1, endSeconds: 3 }] }], packages: [], revisions: [], tasks: [] });

    const first = replayShotGeneration(initial, { acceptDurationRisk: false, isOwner: true, riskCount: 0, riskReason: "", studioProject: studioV1 });
    const second = replayShotGeneration(first, { acceptDurationRisk: true, isOwner: true, riskCount: 1, riskReason: "保留表演停顿", studioProject: studioV2 });
    expect(second.drafts[0]).toMatchObject({ frozen: false, sourceMaterialRevisionId: "material-1", clipSegments: [{ startSeconds: 1, endSeconds: 3 }] });
    expect(second.revisions).toEqual([{ revision: 1, studioProject: studioV1 }, { revision: 2, studioProject: studioV2 }]);
    expect(second.packages[0].studioProject).toEqual(studioV1);
    expect(second.tasks[1].studioProject).toEqual(studioV2);
  });

  it("迁移回放只给最新 QC 完成函数补 Studio 字段，不丢失 QC 门禁和证据", () => {
    const latest = extractFunctionDefinition(readFileSync(resolve("supabase/migrations/20260815213000_add_qc_final_render.sql"), "utf8"), "register_completed_review_render");
    const migration = readFileSync(shotReviewVideoMigration, "utf8");
    const source = "'frozen_input_artifacts',new.input_snapshot -> 'input_artifacts'";
    const replacement = "'studio_project',new.input_snapshot #> '{review_render,adjustments,studio_project}',\n    'studio_project_revision',new.input_snapshot #>> '{review_render,adjustments,studio_project_revision}',\n    'frozen_input_artifacts',new.input_snapshot -> 'input_artifacts'";
    const replayed = latest.replace(source, replacement);
    expect(migration).toContain("pg_get_functiondef('public.register_completed_review_render()'::regprocedure)");
    expect(migration).not.toContain("create or replace function public.register_completed_review_render()");
    expect(replayed).toContain("select * into qc_artifact");
    expect(replayed).toContain("qc_artifact.id is null");
    expect(replayed).toContain("'composition_revision_id'");
    expect(replayed).toContain("'composition_adjustments'");
    expect(replayed).toContain("'qc_report'");
    expect(replayed).toContain("'studio_project'");
    expect(replayed).toContain("'studio_project_revision'");
    expect(replayed).toContain("'relative_path',qc_artifact.relative_path");
  });

  it("为长 Worker 任务提供同一尝试的租约心跳", () => {
    const migration = readFileSync(workerLeaseHeartbeatMigration, "utf8");

    expect(migration).toContain("create or replace function public.refresh_worker_task_lease(p_task_id uuid, p_attempt integer)");
    expect(migration).toContain("status = 'running'");
    expect(migration).toContain("attempt = p_attempt + 1");
    expect(migration).toContain("set claimed_at = now()");
    expect(migration).toContain("grant execute on function public.refresh_worker_task_lease(uuid, integer) to service_role;");
  });

  it("Studio 修订使用冻结 HTML 提供的合成配置", () => {
    const migration = readFileSync(frozenStudioCompositionMigration, "utf8");

    expect(migration).toContain("canonical_composition jsonb;");
    expect(migration).toContain("p_composition -> 'studio_project' -> 'composition'");
    expect(migration).toContain("canonical_composition ->> 'transition'");
    expect(migration).toContain("canonical_composition ->> 'caption_style'");
    expect(migration).toContain("grant execute on function public.request_review_render_revision(uuid, jsonb, text) to authenticated;");
  });

  it("关闭字幕时允许保存空字幕正文", () => {
    const rpcMigration = readFileSync(resolve("supabase/migrations/20260907144500_allow_empty_disabled_subtitles.sql"), "utf8");
    const constraintMigration = readFileSync(resolve("supabase/migrations/20260907151000_align_disabled_subtitle_constraint.sql"), "utf8");

    expect(rpcMigration).toContain("or (p_subtitles_enabled and coalesce(btrim(p_subtitle_text)");
    expect(constraintMigration).toContain("drop constraint if exists shot_preparation_drafts_subtitle_text_check");
    expect(constraintMigration).toContain("check (not subtitles_enabled or char_length(btrim(subtitle_text)) > 0)");
  });

  it("旧旁白编排不再自动建任务，历史阻塞会失效", () => {
    const migration = readFileSync(stopLegacyNarrationMigration, "utf8");

    expect(migration).toContain("create or replace function public.orchestrate_narration_tasks(p_episode_id uuid default null)");
    expect(migration).toContain("returns setof public.tasks");
    expect(migration).not.toContain("orchestrate_narration_tasks_configured");
    expect(migration).toContain("invalidate_superseded_storyboard_narration_tasks_after_approval");
    expect(migration).toContain("task.invalidated_at is null");
    expect(migration).toContain("task.status in ('blocked', 'failed')");
    expect(migration).toContain("task.input_snapshot ->> 'storyboard_review_package_id' <> new.review_package_id::text");
    expect(migration).toContain("task.input_snapshot #>> '{shot_preparation,draft_id}' is null");
  });

  it("把现行 HyperFrames 路径迁移为 OpenChatCut", () => {
    const migration = readFileSync(replaceHyperframesMigration, "utf8");
    expect(migration).toContain("'hyperframes_card_video', 'openchatcut_card_video'");
    expect(migration).toContain("'hyperframes@0.7.109', 'openchatcut@0.2.14'");
    expect(migration).toContain("'hyperframes_review_render', 'openchatcut_review_render'");
    expect(migration).toContain("where provider = 'hyperframes'");
  });

  it("OpenChatCut 内部审核 helper 不向 API 角色暴露 SECURITY DEFINER 权限", () => {
    const migration = readFileSync(restrictOpenChatCutReviewHelperMigration, "utf8");

    expect(migration).toContain(
      "revoke all on function public.current_openchatcut_review_package(uuid, boolean)",
    );
    expect(migration).toContain("from public, anon, authenticated;");
  });

  it("逐镜头同步预览以同一输入指纹登记真实代理和可编辑工程，并保留失败前代理", () => {
    const migration = readFileSync(shotSyncPreviewMigration, "utf8");
    expect(migration).toContain("'generate_review_render','generate_shot_sync_preview','generate_final_render'");
    expect(migration).toContain("create function public.generate_shot_sync_preview(");
    expect(migration).toContain("'preview_input_fingerprint', draft.preparation_input_fingerprint");
    expect(migration).toContain("jsonb_build_array('shot_preview_proxy', 'shot_editable_project', 'shot_preview_runtime', 'shot_preview_qc_report')");
    expect(migration).toContain("current_preview_input_fingerprint is distinct from draft.preparation_input_fingerprint");
    expect(migration).toContain("preview_error = coalesce(new.last_result");
    expect(migration).not.toContain("set current_preview_artifact_id = null");
    expect(migration).toContain("coalesce((audio_member #>> '{audio_track,start_seconds}')::numeric, 0) - shot_offset_seconds");
    expect(migration).toContain("replace(definition, 'order by ordinal', 'order by ordinality')");
  });

  it("保留原声直接使用视频内嵌音轨，不再等待独立提取任务", () => {
    const migration = readFileSync(embeddedSourceAudioPreviewMigration, "utf8");

    expect(migration).toContain("pg_get_functiondef('public.generate_shot_sync_preview(uuid,uuid,text)'::regprocedure)");
    expect(migration).toContain("pg_get_functiondef('public.confirm_shot_sync_preview(uuid,uuid,text,text,text)'::regprocedure)");
    expect(migration).toContain("The source-audio shot needs its current extracted audio evidence");
    expect(migration).toContain("draft.audio_mode = \\'tts\\' and not exists");
    expect(migration).toContain("when draft.audio_mode = \\'source\\' then duration_seconds");
    expect(migration).toContain("from public, anon;");
    expect(migration).toContain("to authenticated;");
  });

  it("审核渲染组包保留镜头准备契约中的显式空音频字段", () => {
    const migration = readFileSync(preserveNestedShotAudioMixNullsMigration, "utf8");

    expect(migration).toContain("pg_get_functiondef('public.orchestrate_review_render_tasks(uuid)'::regprocedure)");
    expect(migration).toContain("jsonb_build_object('preparation_contract', member.evidence_snapshot -> 'preparation_contract')");
    expect(migration).toContain("when member.evidence_snapshot -> 'preparation_contract' is null then '{}'::jsonb");
    expect(migration).toContain("if patched = definition or position(replacement in patched) = 0 then");
  });

  it("重叠片段的时长在保存、生成和确认链路都按区间并集计算", () => {
    const migration = readFileSync(clipIntervalUnionDurationMigration, "utf8");
    expect(migration).toContain("create or replace function public.clip_segment_union_duration(p_clip_segments jsonb)");
    expect(migration).toContain("segment_start <= current_end");
    expect(migration).toContain("pg_get_functiondef('public.save_shot_workbench_draft(uuid,uuid,text,uuid,jsonb,text,text,boolean,text,text,numeric)'::regprocedure)");
    expect(migration).toContain("pg_get_functiondef('public.generate_shot_sync_preview(uuid,uuid,text)'::regprocedure)");
    expect(migration).toContain("pg_get_functiondef('public.confirm_shot_sync_preview(uuid,uuid,text,text,text)'::regprocedure)");
    expect(migration).toContain("from public, anon, authenticated;");
  });

  it("按全屏顺序与分屏并行两种构图语义计算镜头播放时长", () => {
    const migration = readFileSync(compositionAwareClipDurationMigration, "utf8");
    expect(migration).toContain("create or replace function public.shot_composition_playback_duration(p_clip_segments jsonb, p_composition jsonb)");
    expect(migration).toContain("coalesce(p_composition ->> 'layout', 'full') = 'full'");
    expect(migration).toContain("least(playback_duration, segment_duration)");
    expect(migration).toContain("public.shot_composition_playback_duration(draft.clip_segments, draft.composition)");
    expect(migration).toContain("video_duration_seconds = public.shot_composition_playback_duration(p_clip_segments, p_composition)");
    expect(migration).toContain("from public, anon, authenticated;");
  });

  it("源素材范围与镜头播放时长分别保存并分别校验", () => {
    const migration = readFileSync(sourceAndPlaybackDurationMigration, "utf8");
    expect(migration).toContain("add column source_video_duration_seconds numeric");
    expect(migration).toContain("p_source_video_duration_seconds numeric");
    expect(migration).toContain("source_video_duration_seconds = p_source_video_duration_seconds");
    expect(migration).toContain("(segment ->> ''end_seconds'')::numeric > draft.source_video_duration_seconds");
    expect(migration).toContain("source duration presence");
  });

  it("账号归档可恢复、受 Owner 权限保护并阻止新建生产单", () => {
    const migration = readFileSync(accountArchivingMigration, "utf8");

    expect(migration).toContain("add column archived_at timestamptz");
    expect(migration).toContain("membership_role is distinct from 'owner'");
    expect(migration).toContain("create trigger prevent_episode_for_archived_account_before_insert");
    expect(migration).toContain("where id = new.account_id and archived_at is not null");
    expect(migration).toContain("revoke execute on function public.set_account_archived(uuid, boolean) from public, anon;");
    expect(migration).toContain("grant execute on function public.set_account_archived(uuid, boolean) to authenticated;");
  });

  it("字幕安全区 v2 校验画布比例与四边边距，同时兼容 v1 快照", () => {
    const migration = readFileSync(captionSafeAreaV2Migration, "utf8");
    expect(migration).toContain("shot-caption-space/v1");
    expect(migration).toContain("shot-caption-space/v2");
    expect(migration).toContain("('9:16', '16:9', '1:1')");
    expect(migration).toContain("array['top', 'right', 'bottom', 'left']");
    expect(migration).toContain("not between 0 and 0.4");
    expect(migration).toContain("revoke all on function public.is_valid_shot_caption_contract(jsonb) from public, anon, authenticated");
  });

  it("按生产单冻结蓝图执行五个审批关卡", () => {
    const migration = readFileSync(approvalGatesMigration, "utf8");

    expect(migration).toContain("join public.account_blueprint_versions blueprint on blueprint.id = episode.blueprint_version_id");
    expect(migration).toContain("('draft_script', 'script', 'script_review'::public.episode_stage, 'script_approved'::public.episode_stage)");
    expect(migration).toContain("('prepare_visual_brief', 'visual', 'visual_review'::public.episode_stage, 'visual_approved'::public.episode_stage)");
    expect(migration).toContain("('draft_storyboard_revision', 'storyboard', 'storyboard_review'::public.episode_stage, 'storyboard_approved'::public.episode_stage)");
    expect(migration).toContain("('generate_review_render', 'qc', 'qc_review'::public.episode_stage, 'qc_passed'::public.episode_stage)");
    expect(migration).toContain("new.task_type = 'verify_publish_package'");
    expect(migration).toContain("issue.severity = 'blocking'");
    expect(migration).toContain("zz_auto_advance_disabled_approval_gate_after_task");
    expect(migration).toContain("'approval_gate_auto_advanced'");
  });
});
