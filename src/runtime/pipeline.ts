import { getEffectiveFlows } from "./char-flows";
import { getChatId } from "./compat/character";
import { FlowTriggerV1 } from "./contracts";
import { renderControllerTemplate } from "./controller-renderer";
import { dispatchFlows, DispatchFlowsError } from "./dispatcher";
import { uuidv4 } from "./helpers";
import { injectReplyInstructionOnce } from "./injection";
import { mergeFlowResults } from "./merger";
import { redactDebugPayload } from "./redaction";
import { getSettings, setLastIo, setLastRun } from "./settings";
import { commitMergedPlan } from "./transaction";
import {
  CommitSummary,
  ContextCursor,
  ControllerTemplateSlot,
  EwFlowConfig,
  EwFlowConfigSchema,
  WorkflowFailure,
  DispatchFlowAttempt,
  DispatchFlowResult,
  RunSummarySchema,
  WorkflowWarning,
  WorkflowCapsuleMode,
  WorkflowJobType,
  WorkflowProgressUpdate,
  WorkflowWritebackPolicy,
} from "./types";
import {
  createWorkflowRuntimeError,
  extractHttpStatusFromErrorText,
  getWorkflowFailureFromError,
  getWorkflowFailureSuggestion,
} from "./workflow-error";
import { getWorkflowSupportStatus } from "./workflow-support";

type RunWorkflowInput = {
  message_id: number;
  user_input?: string;
  trigger?: FlowTriggerV1;
  mode: "auto" | "manual";
  inject_reply?: boolean;
  flow_ids?: string[];
  selected_flows?: EwFlowConfig[];
  timing_filter?: "before_reply" | "after_reply";
  preserved_results?: DispatchFlowResult[];
  job_type?: WorkflowJobType;
  context_cursor?: ContextCursor;
  writeback_policy?: WorkflowWritebackPolicy;
  rederive_options?: {
    legacy_approx?: boolean;
    capsule_mode?: WorkflowCapsuleMode;
  };
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean;
  onProgress?: (update: WorkflowProgressUpdate) => void;
};

export type RunWorkflowOutput = {
  ok: boolean;
  reason?: string;
  request_id: string;
  diagnostics?: Record<string, any>;
  attempts: DispatchFlowAttempt[];
  results: DispatchFlowResult[];
};

function toPreview(value: unknown, maxLen = 3000): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxLen) {
      return text;
    }
    return `${text.slice(0, maxLen)}\n...truncated`;
  } catch {
    return String(value);
  }
}

function buildAttemptRequestPreview(attempt: DispatchFlowAttempt): string {
  return toPreview(
    redactDebugPayload(
      attempt.request_debug ?? {
        flow_request: attempt.request,
      },
    ) ?? {
      flow_request: attempt.request,
    },
    20000,
  );
}

function buildAttemptResponsePreview(attempt: DispatchFlowAttempt): string {
  if (!attempt.response) {
    return "";
  }

  return toPreview(redactDebugPayload(attempt.response));
}

function saveIoSummary(
  requestId: string,
  chatId: string,
  mode: "auto" | "manual",
  attempts: DispatchFlowAttempt[],
) {
  setLastIo({
    at: Date.now(),
    request_id: requestId,
    chat_id: chatId,
    mode,
    flows: attempts.map((attempt) => ({
      flow_id: attempt.flow.id,
      flow_name: attempt.flow.name,
      priority: attempt.flow.priority,
      api_preset_name: attempt.api_preset_name,
      api_url: attempt.api_url,
      ok: attempt.ok,
      elapsed_ms: attempt.elapsed_ms,
      error: attempt.error ?? "",
      error_code: attempt.error_code,
      error_stage: attempt.error_stage,
      error_status: extractHttpStatusFromErrorText(attempt.error ?? ""),
      error_suggestion: getWorkflowFailureSuggestion(
        attempt.error_code,
        attempt.error_stage,
      ),
      request_preview: buildAttemptRequestPreview(attempt),
      response_preview: buildAttemptResponsePreview(attempt),
    })),
  });
}

function buildFailureFromAttempts(
  requestId: string,
  attempts: DispatchFlowAttempt[],
  overrides: Partial<WorkflowFailure> = {},
): WorkflowFailure | null {
  const failedAttempts = attempts.filter(attempt => !attempt.ok);
  if (failedAttempts.length === 0) {
    return null;
  }

  const failedAttempt = failedAttempts[0];
  const successfulFlowCount = attempts.filter(attempt => attempt.ok).length;
  const attemptedFlowCount = attempts.length;
  const partialSuccess =
    overrides.partial_success ?? (successfulFlowCount > 0);
  const wholeWorkflowFailed =
    overrides.whole_workflow_failed ?? !partialSuccess;
  const detail = failedAttempts
    .map((attempt) => attempt.error ?? `[${attempt.flow.id}] failed`)
    .join("\n");
  const failedNames = failedAttempts.map((attempt) =>
    attempt.flow.name?.trim() || attempt.flow.id,
  );
  const summary =
    overrides.summary ??
    (partialSuccess
      ? `部分工作流执行失败：${failedNames.join("、")}。成功结果已保留，但本轮仍按失败记录。`
      : failedAttempt.error ?? "工作流分发失败。");

  return {
    code: failedAttempt.error_code ?? "unknown",
    stage: failedAttempt.error_stage ?? "dispatch",
    detail,
    summary,
    flow_id: failedAttempt.flow.id,
    flow_name: failedAttempt.flow.name,
    conflict_entries: overrides.conflict_entries ?? [],
    target_worldbook_name: overrides.target_worldbook_name ?? "",
    request_id: requestId,
    api_preset_name: failedAttempt.api_preset_name,
    attempted_flow_count: attemptedFlowCount,
    successful_flow_count: successfulFlowCount,
    failed_flow_count: failedAttempts.length,
    partial_success: partialSuccess,
    whole_workflow_failed: wholeWorkflowFailed,
    http_status:
      overrides.http_status ??
      extractHttpStatusFromErrorText(failedAttempt.error ?? ""),
    retry_count: overrides.retry_count ?? 0,
    suggestion:
      overrides.suggestion ??
      getWorkflowFailureSuggestion(
        failedAttempt.error_code,
        failedAttempt.error_stage,
      ),
  };
}

function buildRunWarningFromCommitSummary(
  commitSummary: CommitSummary | null,
): WorkflowWarning | null {
  if (!commitSummary) {
    return null;
  }

  const dynChangeCount =
    commitSummary.dyn_entries_created +
    commitSummary.dyn_entries_updated +
    commitSummary.dyn_entries_removed;
  if (
    commitSummary.dyn_entries_requested > 0 &&
    dynChangeCount === 0 &&
    commitSummary.controller_entries_updated > 0
  ) {
    return {
      code: "dyn_not_updated",
      summary: "本轮请求了动态条目，但最终只有控制器仓库发生变化。",
      detail:
        `目标世界书：${commitSummary.target_worldbook_name || "(none)"}；` +
        `动态条目请求=${commitSummary.dyn_entries_requested}，动态条目变化=${dynChangeCount}，` +
        `控制器变化=${commitSummary.controller_entries_updated}。`,
    };
  }

  return null;
}

export function buildRunWarningFromCommitSummaryForTest(
  commitSummary: CommitSummary | null,
): WorkflowWarning | null {
  return buildRunWarningFromCommitSummary(commitSummary);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`workflow timeout (${timeoutMs}ms)`)),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitWithCancellation(
  delayMs: number,
  input: Pick<RunWorkflowInput, "abortSignal" | "isCancelled">,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    throwIfWorkflowCancelled(input);
    const remaining = delayMs - (Date.now() - startedAt);
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 200)));
  }

  throwIfWorkflowCancelled(input);
}

function isWorkflowCancelled(
  input: Pick<RunWorkflowInput, "abortSignal" | "isCancelled">,
): boolean {
  return Boolean(input.abortSignal?.aborted || input.isCancelled?.());
}

function throwIfWorkflowCancelled(
  input: Pick<RunWorkflowInput, "abortSignal" | "isCancelled">,
): void {
  if (isWorkflowCancelled(input)) {
    throw new Error("workflow cancelled by user");
  }
}

export async function runWorkflow(
  input: RunWorkflowInput,
): Promise<RunWorkflowOutput> {
  const startedAt = Date.now();
  const settings = getSettings();
  const requestId = uuidv4();
  const preservedResults = [...(input.preserved_results ?? [])];
  const currentChatId = String(getChatId() ?? "unknown");
  let attempts: DispatchFlowAttempt[] = [];
  let diagnostics: Record<string, any> = {};
  let targetWorldbookName = "";
  let commitSummary: import("./types").CommitSummary | null = null;
  let runWarning: WorkflowWarning | null = null;
  let attemptedFlowCount = 0;

  try {
    const supportStatus = getWorkflowSupportStatus();
    if (!supportStatus.ok) {
      throw new Error(supportStatus.message);
    }

    throwIfWorkflowCancelled(input);
    input.onProgress?.({
      phase: "preparing",
      request_id: requestId,
      message: "正在准备工作流上下文…",
    });
    const explicitFlows = Array.isArray(input.selected_flows)
      ? input.selected_flows
          .filter(
            (flow): flow is EwFlowConfig =>
              Boolean(flow && typeof flow === "object"),
          )
          .map((flow) => EwFlowConfigSchema.parse(flow))
      : [];

    let enabledFlows: EwFlowConfig[];
    if (explicitFlows.length > 0) {
      enabledFlows = explicitFlows;
    } else {
      // Merge global flows + per-character flows (from EW/Flows worldbook entry).
      const allEnabledFlows = await getEffectiveFlows(settings);
      const selectedFlowIds = new Set((input.flow_ids ?? []).filter(Boolean));
      enabledFlows =
        selectedFlowIds.size > 0
          ? allEnabledFlows.filter((flow) => selectedFlowIds.has(flow.id))
          : allEnabledFlows;
    }

    // Per-flow timing filter: resolve 'default' to global workflow_timing, then keep only matching.
    if (input.timing_filter) {
      enabledFlows = enabledFlows.filter((f) => {
        const effective =
          f.timing === "default" ? settings.workflow_timing : f.timing;
        return effective === input.timing_filter;
      });
    }
    attemptedFlowCount = enabledFlows.length;

    if (enabledFlows.length === 0) {
      // If timing filter caused 0 flows, this is a no-op — not an error.
      if (input.timing_filter) {
        return {
          ok: true,
          reason: `no flows match timing '${input.timing_filter}'`,
          request_id: requestId,
          attempts: [],
          results: [],
        };
      }
      throw new Error("no enabled flows");
    }

    const afterReplyDelayMs = Math.max(0, Math.round((settings.after_reply_delay_seconds ?? 0) * 1000));
    if (input.timing_filter === "after_reply" && afterReplyDelayMs > 0) {
      input.onProgress?.({
        phase: "dispatching",
        request_id: requestId,
        message: `AI 回复已完成，等待 ${settings.after_reply_delay_seconds} 秒后开始执行工作流…`,
      });
      await waitWithCancellation(afterReplyDelayMs, input);
    }

    throwIfWorkflowCancelled(input);
    input.onProgress?.({
      phase: "dispatching",
      request_id: requestId,
      message: `已装载 ${enabledFlows.length} 条工作流，正在请求模型…`,
    });

    const dispatchOutput = await withTimeout(
      dispatchFlows({
        settings,
        flows: enabledFlows,
        message_id: input.message_id,
        user_input: input.user_input,
        trigger: input.trigger,
        request_id: requestId,
        context_cursor: input.context_cursor,
        job_type: input.job_type,
        writeback_policy: input.writeback_policy,
        rederive_options: input.rederive_options,
        abortSignal: input.abortSignal,
        isCancelled: input.isCancelled,
        onProgress: input.onProgress,
      }),
      settings.total_timeout_ms,
    );
    attempts = dispatchOutput.attempts;
    saveIoSummary(requestId, currentChatId, input.mode, attempts);

    throwIfWorkflowCancelled(input);

    const results = [...preservedResults, ...dispatchOutput.results];

    input.onProgress?.({
      phase: "merging",
      request_id: requestId,
      message: "模型响应已返回，正在合并条目结果…",
    });
    const mergedPlan = mergeFlowResults(results, settings);
    diagnostics = mergedPlan.diagnostics;
    throwIfWorkflowCancelled(input);

    // Render each flow's controller_model into an EJS template.
    const controllerTemplates: ControllerTemplateSlot[] = [];
    for (const slot of mergedPlan.controller_models) {
      controllerTemplates.push({
        flow_id: slot.flow_id,
        flow_name: slot.flow_name,
        entry_name: slot.entry_name,
        content: await renderControllerTemplate(
          slot.model,
          settings.dynamic_entry_prefix,
        ),
      });
    }
    throwIfWorkflowCancelled(input);
    input.onProgress?.({
      phase: "committing",
      request_id: requestId,
      message: "正在写回世界书与控制器…",
    });

    const commitResult = await commitMergedPlan(
      settings,
      mergedPlan,
      controllerTemplates,
      requestId,
      input.message_id,
    );
    targetWorldbookName = commitResult.target_worldbook_name;
    commitSummary = {
      target_worldbook_name: commitResult.target_worldbook_name,
      dyn_entries_requested: commitResult.dyn_entries_requested,
      dyn_entries_created: commitResult.dyn_entries_created,
      dyn_entries_updated: commitResult.dyn_entries_updated,
      dyn_entries_removed: commitResult.dyn_entries_removed,
      controller_entries_requested: commitResult.controller_entries_requested,
      controller_entries_updated: commitResult.controller_entries_updated,
      write_scope: commitResult.write_scope,
      worldbook_verified: commitResult.worldbook_verified,
      effective_change_count: commitResult.effective_change_count,
    };
    runWarning = buildRunWarningFromCommitSummary(commitSummary);
    throwIfWorkflowCancelled(input);

    if (commitResult.effective_change_count === 0 && !mergedPlan.reply_instruction.trim()) {
      throw createWorkflowRuntimeError("no_effective_write", "commit", {
        message: "本轮执行没有产生任何有效写入或回复指令，已按失败处理。",
        detail: `target_worldbook=${commitResult.target_worldbook_name || "(none)"}`,
        target_worldbook_name: commitResult.target_worldbook_name,
      });
    }

    if (input.inject_reply !== false) {
      injectReplyInstructionOnce(mergedPlan.reply_instruction);
    }

    const dispatchFailure = buildFailureFromAttempts(requestId, attempts, {
      target_worldbook_name: commitResult.target_worldbook_name,
      summary:
        "部分工作流执行失败，但成功工作流的写回结果已保留；本轮仍按失败记录，方便你继续排查。",
      whole_workflow_failed: false,
      partial_success: true,
    });

    if (dispatchFailure) {
      const reason = dispatchFailure.summary;
      input.onProgress?.({
        phase: "failed",
        request_id: requestId,
        message: reason,
      });

      const partialFailureSummary = RunSummarySchema.parse({
        at: Date.now(),
        ok: false,
        reason,
        request_id: requestId,
        chat_id: commitResult.chat_id,
        flow_count: attemptedFlowCount || attempts.length,
        elapsed_ms: Date.now() - startedAt,
        mode: input.mode,
        target_worldbook_name: commitResult.target_worldbook_name,
        commit: commitSummary,
        warning: runWarning,
        failure: dispatchFailure,
        diagnostics,
      });
      setLastRun(partialFailureSummary);

      return {
        ok: false,
        reason,
        request_id: requestId,
        diagnostics,
        attempts,
        results,
      };
    }

    const summary = RunSummarySchema.parse({
      at: Date.now(),
      ok: true,
      reason: "",
      request_id: requestId,
      chat_id: commitResult.chat_id,
      flow_count: attemptedFlowCount || results.length,
      elapsed_ms: Date.now() - startedAt,
      mode: input.mode,
      target_worldbook_name: commitResult.target_worldbook_name,
      commit: commitSummary,
      warning: runWarning,
      failure: null,
      diagnostics,
    });
    setLastRun(summary);

    input.onProgress?.({
      phase: "completed",
      request_id: requestId,
      message: "工作流处理完成。",
    });

    return {
      ok: true,
      request_id: requestId,
      diagnostics,
      attempts,
      results,
    };
  } catch (error) {
    const failure =
      getWorkflowFailureFromError(error) ??
      (error instanceof DispatchFlowsError
        ? buildFailureFromAttempts(requestId, error.attempts)
        : null);
    const reason = failure?.summary || (error instanceof Error ? error.message : String(error));
    input.onProgress?.({
      phase: "failed",
      request_id: requestId,
      message: reason,
    });
    if (error instanceof DispatchFlowsError) {
      attempts = error.attempts;
      saveIoSummary(requestId, currentChatId, input.mode, attempts);
    } else if (attempts.length === 0) {
      saveIoSummary(requestId, currentChatId, input.mode, []);
    }

    const summary = RunSummarySchema.parse({
      at: Date.now(),
      ok: false,
      reason,
      request_id: requestId,
      chat_id: currentChatId,
      flow_count:
        attemptedFlowCount > 0
          ? attemptedFlowCount
          : (input.flow_ids?.length ?? 0) > 0
            ? (input.flow_ids?.length ?? 0)
            : settings.flows.filter((flow) => flow.enabled).length,
      elapsed_ms: Date.now() - startedAt,
      mode: input.mode,
      target_worldbook_name: failure?.target_worldbook_name || targetWorldbookName,
      commit: commitSummary,
      warning: runWarning,
      failure,
      diagnostics,
    });
    setLastRun(summary);

    return {
      ok: false,
      reason,
      request_id: requestId,
      attempts,
      results: preservedResults,
    };
  }
}
