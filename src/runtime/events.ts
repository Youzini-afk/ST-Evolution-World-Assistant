import {
  getEventTypes,
  getSTContext,
  onSTEvent,
  onSTEventFirst,
} from "../st-adapter";
import { klona } from "klona";
import { EwWorkflowNoticeInput, showManagedWorkflowNotice } from "../ui/notice";
import { getEffectiveFlows } from "./char-flows";
import {
  getChatId,
  getChatMessages,
  getCurrentCharacterName,
  getLastMessageId,
  setChatMessages,
} from "./compat/character";
import { stopGeneration } from "./compat/generation";
import { clearReplyInstruction } from "./compat/injection";
import {
  applySnapshotDiffToCurrentWorldbook,
  disposeFloorBindingEvents,
  initFloorBindingEvents,
  pinMessageSnapshotToCurrentVersion,
  repairCurrentChatSuspiciousEmptySnapshots,
  readFloorSnapshotByMessageId,
  rebindFloorSnapshotToMessage,
  rollbackBeforeFloor,
} from "./floor-binding";
import {
  resetBeforeReplySource,
  setBeforeReplySource,
  setSendIntentHookStatus,
} from "./host-status";
import { runIncrementalHideCheck } from "./hide-engine";
import {
  markIntercepted,
  resetInterceptGuard,
  wasRecentlyIntercepted,
} from "./intercept-guard";
import { getMessageVersionInfo, simpleHash } from "./helpers";
import { runWorkflow } from "./pipeline";
import { getSettings } from "./settings";
import {
  buildArchivedArtifactVersionKey,
  buildFileName,
  buildLegacyFileName,
  buildSnapshotStoreOwner,
  createEmptySnapshotStore,
  deleteSnapshot,
  hasSnapshotStorePayload,
  pruneAllVersionedEntries,
  pruneArchivedVersionedEntries,
  readSnapshotStore,
  type SnapshotVersionStore,
  writeSnapshotStore,
} from "./snapshot-storage";
import {
  clearAfterReplyPending,
  clearAfterReplyPendingIfMatches,
  clearBeforeReplyBindingPending,
  clearDryRunPromptPreview,
  clearSendIntent,
  clearSendContext,
  clearSendContextIfMatches,
  consumeDryRunPromptPreview,
  markBeforeReplyBindingMigrated,
  markDryRunPromptPreview,
  getRuntimeState,
  isMvuExtraAnalysisGuardActive,
  pruneExpiredBeforeReplyBindingPending,
  isQuietLike,
  markAfterReplyHandled,
  recordGeneration,
  recordUserSend,
  recordUserSendIntent,
  resetRuntimeState,
  setBeforeReplyBindingPending,
  setProcessing,
  shouldSkipTavernHelperPromptViewerSyntheticGeneration,
  shouldHandleAfterReply,
  shouldHandleGenerationAfter,
  wasAfterReplyHandled,
} from "./state";
import {
  ContextCursor,
  DispatchFlowResult,
  EwSettings,
  WorkflowCapsuleMode,
  WorkflowJobType,
  WorkflowProgressUpdate,
  WorkflowWritebackPolicy,
} from "./types";
import { getWorkflowSupportStatus } from "./workflow-support";

type StopFn = () => void;

const EW_FLOOR_WORKFLOW_EXECUTION_KEY = "ew_workflow_execution";
const EW_BEFORE_REPLY_BINDING_KEY = "ew_before_reply_binding";
const EW_REDERIVE_META_KEY = "ew_rederive_meta";
const EW_WORKFLOW_REPLAY_CAPSULE_KEY = "ew_workflow_replay_capsule";
const EW_SNAPSHOT_FILE_KEY = "ew_snapshot_file";
const EW_SWIPE_ID_KEY = "ew_snapshot_swipe_id";
const EW_CONTENT_HASH_KEY = "ew_snapshot_content_hash";

type FloorWorkflowStoredResult = {
  flow_id: string;
  response: Record<string, any>;
};

type FloorWorkflowExecutionVersionedMap = Record<string, FloorWorkflowExecutionState>;

type FloorWorkflowExecutionState = {
  at: number;
  request_id: string;
  swipe_id?: number;
  content_hash?: string;
  attempted_flow_ids: string[];
  successful_results: FloorWorkflowStoredResult[];
  successful_flow_ids?: string[];
  failed_flow_ids: string[];
  workflow_failed: boolean;
  execution_status: "executed" | "skipped";
  skip_reason?: string;
  details_externalized?: boolean;
};

type BeforeReplyBindingMigrationResult = {
  migrated: boolean;
  snapshot_migrated: boolean;
  execution_migrated: boolean;
  capsule_migrated: boolean;
  snapshot_reason?: string;
  execution_reason?: string;
  capsule_reason?: string;
  reason?: string;
};

type FailedAfterReplyQueueJob = {
  chat_key: string;
  message_id: number;
  user_message_id?: number;
  user_input: string;
  generation_type: string;
  failed_at: number;
};

type WorkflowReplayCapsule = {
  at: number;
  request_id: string;
  job_type: WorkflowJobType;
  timing: "before_reply" | "after_reply" | "manual";
  source: string;
  generation_type: string;
  target_message_id: number;
  target_version_key: string;
  target_role: "user" | "assistant" | "other";
  flow_ids: string[];
  flow_ids_hash: string;
  capsule_mode: WorkflowCapsuleMode;
  legacy_approx: boolean;
  assembled_messages?: Array<{ role: string; content: string; name?: string }>;
  request_preview?: Array<Record<string, unknown>>;
  details_externalized?: boolean;
};

const listenerStops: StopFn[] = [];
const domCleanup: Array<() => void> = [];
const HOOK_RETRY_DELAY_MS = 1200;
const EW_GENERATE_INTERCEPTOR_KEY = "ew_generation_interceptor";
let sendIntentRetryTimer: ReturnType<typeof setTimeout> | null = null;
const managedRuntimeTimeouts = new Set<ReturnType<typeof setTimeout>>();
const workflowTaskQueue: Array<{
  label: string;
  priority: number;
  seq: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];
const queuedBeforeReplyJobKeys = new Set<string>();
const queuedAfterReplyJobKeys = new Set<string>();
const queuedAfterReplyDedupKeys = new Set<string>();
const processedAfterReplyIdentityKeys = new Set<string>();
const pendingAfterReplyMessageReceivedFallbacks = new Map<
  number,
  ReturnType<typeof setTimeout>
>();
const failedAfterReplyJobsByChat = new Map<string, FailedAfterReplyQueueJob[]>();
let workflowTaskDrainPromise: Promise<void> | null = null;
let workflowTaskSeq = 0;
const lastBeforeReplyTriggerByIdentityKey = new Map<string, number>();
const lastAfterReplyTriggerByIdentityKey = new Map<string, number>();
let lastObservedGenerationEndedSeq = 0;
const MIN_BEFORE_REPLY_INTERVAL_MS = 2500;
const MIN_AFTER_REPLY_INTERVAL_MS = 3000;
const AFTER_REPLY_MESSAGE_RECEIVED_FALLBACK_POLL_MS = 250;
const AFTER_REPLY_MESSAGE_RECEIVED_FALLBACK_TIMEOUT_MS = 12000;
let runtimeEventsInitialized = false;
const NON_SEND_GENERATION_TYPES = new Set(["continue", "regenerate", "swipe"]);
const WORKFLOW_NOTICE_COLLAPSE_MS = 5000;
const artifactCompactionInFlightByChat = new Map<
  string,
  Promise<{ compacted: number; warnings: string[] }>
>();

function scheduleManagedRuntimeTimeout(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const handle = setTimeout(() => {
    managedRuntimeTimeouts.delete(handle);
    callback();
  }, delayMs);
  managedRuntimeTimeouts.add(handle);
  return handle;
}

function clearManagedRuntimeTimeouts(): void {
  for (const handle of managedRuntimeTimeouts) {
    clearTimeout(handle);
  }
  managedRuntimeTimeouts.clear();
}

// ST 扩展直接运行在主页面，无需 getHostWindow/getChatDocument
function getChatDocument(): Document {
  return document;
}

function getCurrentChatKey(): string {
  return String(getChatId() ?? "unknown");
}

function resolveWorkflowJobPriority(jobType: WorkflowJobType): number {
  if (jobType === "live_auto") {
    return 0;
  }
  return 1;
}

function resolveAfterReplyContextWindowMs(settings: EwSettings): number {
  return Math.max(
    settings.total_timeout_ms + 10000,
    settings.gate_ttl_ms,
    600000,
  );
}

function clearQueuedWorkflowTasks(reason: string) {
  for (const task of workflowTaskQueue.splice(0, workflowTaskQueue.length)) {
    task.reject(new Error(reason));
  }
  queuedBeforeReplyJobKeys.clear();
  queuedAfterReplyJobKeys.clear();
  queuedAfterReplyDedupKeys.clear();
  processedAfterReplyIdentityKeys.clear();
  for (const handle of pendingAfterReplyMessageReceivedFallbacks.values()) {
    clearTimeout(handle);
  }
  pendingAfterReplyMessageReceivedFallbacks.clear();
  lastBeforeReplyTriggerByIdentityKey.clear();
  lastAfterReplyTriggerByIdentityKey.clear();
  lastObservedGenerationEndedSeq = 0;
}

function enqueueWorkflowTask<T>(
  label: string,
  run: () => Promise<T>,
  priority = 1,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    workflowTaskQueue.push({
      label,
      priority,
      seq: workflowTaskSeq++,
      run: run as () => Promise<unknown>,
      resolve: (value) => resolve(value as T),
      reject,
    });
    workflowTaskQueue.sort(
      (left, right) => left.priority - right.priority || left.seq - right.seq,
    );

    if (!workflowTaskDrainPromise) {
      workflowTaskDrainPromise = (async () => {
        while (workflowTaskQueue.length > 0) {
          const task = workflowTaskQueue.shift();
          if (!task) {
            continue;
          }

          try {
            task.resolve(await task.run());
          } catch (error) {
            task.reject(error);
          }
        }
      })().finally(() => {
        workflowTaskDrainPromise = null;
      });
    }
  });
}

function enqueueWorkflowJob<T>(
  jobType: WorkflowJobType,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  return enqueueWorkflowTask(label, run, resolveWorkflowJobPriority(jobType));
}

function getFailedAfterReplyJobs(chatKey: string): FailedAfterReplyQueueJob[] {
  return [...(failedAfterReplyJobsByChat.get(chatKey) ?? [])].sort(
    (left, right) => left.failed_at - right.failed_at,
  );
}

function upsertFailedAfterReplyJob(job: FailedAfterReplyQueueJob): void {
  const current = failedAfterReplyJobsByChat.get(job.chat_key) ?? [];
  const next = current.filter((item) => item.message_id !== job.message_id);
  next.push(job);
  failedAfterReplyJobsByChat.set(
    job.chat_key,
    next.sort((left, right) => left.failed_at - right.failed_at),
  );
}

function removeFailedAfterReplyJob(chatKey: string, messageId: number): void {
  const current = failedAfterReplyJobsByChat.get(chatKey);
  if (!current?.length) {
    return;
  }

  const next = current.filter((item) => item.message_id !== messageId);
  if (next.length > 0) {
    failedAfterReplyJobsByChat.set(chatKey, next);
  } else {
    failedAfterReplyJobsByChat.delete(chatKey);
  }
}

function scheduleSendIntentHooksRetry() {
  if (sendIntentRetryTimer) {
    return;
  }

  sendIntentRetryTimer = setTimeout(() => {
    sendIntentRetryTimer = null;
    installSendIntentHooks();
  }, HOOK_RETRY_DELAY_MS);
}

function registerGenerationAfterCommands(
  handler: (
    type: string,
    params: Record<string, any>,
    dryRun: boolean,
  ) => Promise<void>,
): StopFn {
  const eventTypes = getEventTypes();
  return onSTEventFirst(eventTypes.GENERATION_AFTER_COMMANDS, handler);
}

function registerBeforeCombinePrompts(
  handler: (promptData?: Record<string, any>) => Promise<void> | void,
): StopFn {
  const eventTypes = getEventTypes();
  const eventName =
    eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS ??
    "generate_before_combine_prompts";
  return onSTEventFirst(eventName, handler);
}

function getSendTextareaValue(): string {
  const textarea = getChatDocument().getElementById(
    "send_textarea",
  ) as HTMLTextAreaElement | null;
  return String(textarea?.value ?? "");
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "");
    if (text.trim()) {
      return text;
    }
  }

  return "";
}

function getLatestUserMessageText(): string {
  try {
    const msgs = getChatMessages(`0-${getLastMessageId()}`, {
      hide_state: "unhidden",
    });
    const lastUserMsg = [...msgs]
      .reverse()
      .find((message: any) => message.role === "user");
    return String(lastUserMsg?.message ?? "");
  } catch {
    return "";
  }
}

function getInterceptedUserInput(options: Record<string, any>): string {
  const runtimeState = getRuntimeState();
  return firstNonEmptyText(
    options.user_input,
    options.prompt,
    runtimeState.last_send_intent?.user_input,
    options.injects?.[0]?.content,
  );
}

function resolveWorkflowUserInput(
  options: Record<string, any>,
  generationType: string,
): string {
  const interceptedInput = getInterceptedUserInput(options);
  if (interceptedInput) {
    return interceptedInput;
  }

  if (NON_SEND_GENERATION_TYPES.has(generationType)) {
    return getLatestUserMessageText();
  }

  return "";
}

function resolveFallbackWorkflowUserInput(generationType: string): string {
  const runtimeState = getRuntimeState();
  const interceptedInput = firstNonEmptyText(
    runtimeState.last_send?.user_input,
    runtimeState.last_send_intent?.user_input,
  );
  if (interceptedInput) {
    return interceptedInput;
  }

  if (NON_SEND_GENERATION_TYPES.has(generationType)) {
    return getLatestUserMessageText();
  }

  return "";
}

function resolvePrimaryWorkflowUserInput(generationType: string): string {
  const textareaInput = getSendTextareaValue();
  if (textareaInput.trim()) {
    return textareaInput;
  }

  return resolveFallbackWorkflowUserInput(generationType);
}

function resolveAfterReplyUserInput(): string {
  const runtimeState = getRuntimeState();
  return firstNonEmptyText(
    runtimeState.after_reply.pending_user_input,
    runtimeState.last_send?.user_input,
    runtimeState.last_send_intent?.user_input,
    getLatestUserMessageText(),
  );
}

function installSendIntentHooks() {
  for (const cleanup of domCleanup.splice(0, domCleanup.length)) {
    cleanup();
  }

  const doc = getChatDocument();
  const sendButton = doc.getElementById("send_but");
  if (sendButton) {
    const onSendIntent = () => {
      recordUserSendIntent(getSendTextareaValue());
    };
    sendButton.addEventListener("click", onSendIntent, true);
    sendButton.addEventListener("pointerup", onSendIntent, true);
    sendButton.addEventListener("touchend", onSendIntent, true);
    domCleanup.push(() => {
      sendButton.removeEventListener("click", onSendIntent, true);
      sendButton.removeEventListener("pointerup", onSendIntent, true);
      sendButton.removeEventListener("touchend", onSendIntent, true);
    });
  }

  const sendTextarea = doc.getElementById("send_textarea");
  if (sendTextarea) {
    const onKeyDown = (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (
        (keyboardEvent.key === "Enter" ||
          keyboardEvent.key === "NumpadEnter") &&
        !keyboardEvent.shiftKey
      ) {
        recordUserSendIntent(getSendTextareaValue());
      }
    };
    sendTextarea.addEventListener("keydown", onKeyDown, true);
    domCleanup.push(() =>
      sendTextarea.removeEventListener("keydown", onKeyDown, true),
    );
  }

  if (sendButton && sendTextarea) {
    setSendIntentHookStatus("ready");
  } else {
    setSendIntentHookStatus("degraded");
    console.warn(
      "[Evolution World] send intent hooks degraded: send_but or send_textarea is unavailable",
    );
    scheduleSendIntentHooksRetry();
  }
}

function stopGenerationNow() {
  try {
    stopGeneration();
  } catch {
    // ignore
  }
}

function formatReasonForDisplay(
  reason: string | undefined,
  maxLen = 160,
): string {
  const text = String(reason ?? "unknown")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}...`;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildExecutionVersionKey(state: {
  swipe_id?: number;
  content_hash?: string;
}): string {
  return `sw:${Math.max(0, Math.trunc(Number(state.swipe_id ?? 0) || 0))}|${String(state.content_hash ?? "").trim()}`;
}

function getCurrentCharacterNameSafe(): string {
  return getCurrentCharacterName?.() ?? "unknown";
}

function buildArtifactFileCandidates(
  messageId: number,
  message?: Record<string, any>,
): string[] {
  const candidates: string[] = [];
  const explicit =
    typeof message?.data?.[EW_SNAPSHOT_FILE_KEY] === "string"
      ? String(message.data[EW_SNAPSHOT_FILE_KEY]).trim()
      : "";
  if (explicit) {
    candidates.push(explicit);
  }

  const chatId = getCurrentChatKey();
  const charName = getCurrentCharacterNameSafe();
  const currentNamed = buildFileName(charName, chatId, messageId);
  if (!candidates.includes(currentNamed)) {
    candidates.push(currentNamed);
  }
  const legacyNamed = buildLegacyFileName(charName, chatId, messageId);
  if (!candidates.includes(legacyNamed)) {
    candidates.push(legacyNamed);
  }
  return candidates;
}

async function resolveArtifactStoreForMessage(
  messageId: number,
): Promise<{ message: any; fileName: string; store: SnapshotVersionStore } | null> {
  const message = getChatMessages(messageId)[0];
  if (!message) {
    return null;
  }

  const chatId = getCurrentChatKey();
  const charName = getCurrentCharacterNameSafe();
  const currentNamed = buildFileName(charName, chatId, messageId);
  const legacyNamed = buildLegacyFileName(charName, chatId, messageId);
  const expectedOwner = buildSnapshotStoreOwner(charName, chatId);
  for (const candidate of buildArtifactFileCandidates(messageId, message)) {
    const store = await readSnapshotStore(candidate);
    if (store) {
      const ownerMatches =
        store.owner &&
        store.owner.char_name === expectedOwner.char_name &&
        store.owner.chat_id === expectedOwner.chat_id &&
        store.owner.chat_fingerprint === expectedOwner.chat_fingerprint;
      const nameMatches =
        candidate === currentNamed || candidate === legacyNamed;
      if (store.owner) {
        if (!ownerMatches) {
          continue;
        }
      } else if (!nameMatches) {
        continue;
      }
      return {
        message,
        fileName: candidate,
        store,
      };
    }
  }

  return {
    message,
    fileName: currentNamed,
    store: createEmptySnapshotStore(buildSnapshotStoreOwner(charName, chatId)),
  };
}

function normalizeFloorWorkflowExecutionState(
  raw: unknown,
): FloorWorkflowExecutionState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const successfulResults = Array.isArray(obj.successful_results)
    ? obj.successful_results
        .filter(
          (item) => item && typeof item === "object" && !Array.isArray(item),
        )
        .map((item) => {
          const result = item as Record<string, unknown>;
          return {
            flow_id: String(result.flow_id ?? "").trim(),
            response:
              result.response && typeof result.response === "object"
                ? (result.response as Record<string, any>)
                : {},
          };
        })
        .filter((item) => item.flow_id)
    : [];

  const failedFlowIds = Array.isArray(obj.failed_flow_ids)
    ? obj.failed_flow_ids
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    : [];

  const attemptedFlowIds = Array.isArray(obj.attempted_flow_ids)
    ? obj.attempted_flow_ids
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    : [];
  const successfulFlowIds = Array.isArray(obj.successful_flow_ids)
    ? obj.successful_flow_ids
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    : successfulResults.map((item) => item.flow_id);
  const executionStatus = obj.execution_status === "skipped" ? "skipped" : "executed";
  const skipReason = typeof obj.skip_reason === "string" ? String(obj.skip_reason).trim() : "";

  return {
    at: Number(obj.at ?? 0),
    request_id: String(obj.request_id ?? "").trim(),
    swipe_id: typeof obj.swipe_id === "number" ? obj.swipe_id : undefined,
    content_hash:
      typeof obj.content_hash === "string"
        ? String(obj.content_hash).trim()
        : undefined,
    attempted_flow_ids: dedupeStrings(attemptedFlowIds),
    successful_results: successfulResults,
    successful_flow_ids: dedupeStrings(successfulFlowIds),
    failed_flow_ids: dedupeStrings(failedFlowIds),
    workflow_failed:
      typeof obj.workflow_failed === "boolean"
        ? Boolean(obj.workflow_failed)
        : failedFlowIds.length > 0,
    execution_status: executionStatus,
    skip_reason: skipReason || undefined,
    details_externalized: Boolean(obj.details_externalized),
  };
}

function normalizeFloorWorkflowExecutionMap(
  raw: unknown,
): FloorWorkflowExecutionVersionedMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const single = normalizeFloorWorkflowExecutionState(raw);
  if (single && (typeof obj.request_id === "string" || Array.isArray(obj.successful_results) || Array.isArray(obj.failed_flow_ids))) {
    return {
      [buildExecutionVersionKey(single)]: single,
    };
  }

  const map: FloorWorkflowExecutionVersionedMap = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalized = normalizeFloorWorkflowExecutionState(value);
    if (normalized) {
      map[key] = normalized;
    }
  }

  return map;
}

function buildFloorWorkflowExecutionSummaryState(
  state: FloorWorkflowExecutionState,
): FloorWorkflowExecutionState {
  return {
    ...state,
    successful_results: [],
    successful_flow_ids: dedupeStrings(
      state.successful_flow_ids ??
        state.successful_results.map((result) => result.flow_id),
    ),
    details_externalized: true,
  };
}

function buildFloorWorkflowExecutionSummaryMap(
  map: FloorWorkflowExecutionVersionedMap,
): FloorWorkflowExecutionVersionedMap {
  const summaryMap: FloorWorkflowExecutionVersionedMap = {};
  for (const [key, value] of Object.entries(map)) {
    const normalized = normalizeFloorWorkflowExecutionState(value);
    if (!normalized) {
      continue;
    }
    summaryMap[key] = buildFloorWorkflowExecutionSummaryState(normalized);
  }
  pruneAllVersionedEntries(summaryMap, 2);
  return summaryMap;
}

function isExecutionSummaryOnlyMap(raw: unknown): boolean {
  const map = normalizeFloorWorkflowExecutionMap(raw);
  const values = Object.values(map);
  return values.length > 0 && values.every((value) => Boolean(value.details_externalized));
}

async function readFloorWorkflowExecutionMapComplete(
  messageId: number,
): Promise<FloorWorkflowExecutionVersionedMap> {
  const message = getChatMessages(messageId)[0];
  const inline = normalizeFloorWorkflowExecutionMap(
    message?.data?.[EW_FLOOR_WORKFLOW_EXECUTION_KEY],
  );
  const resolved = await resolveArtifactStoreForMessage(messageId);
  if (!resolved) {
    return inline;
  }

  const external = normalizeFloorWorkflowExecutionMap(
    resolved.store.workflow_execution,
  );
  if (Object.keys(external).length === 0) {
    return inline;
  }
  if (Object.keys(inline).length === 0) {
    return external;
  }

  return {
    ...inline,
    ...external,
  };
}

function selectExecutionStateForHistory(
  map: FloorWorkflowExecutionVersionedMap,
  versionInfo: { version_key: string; swipe_id?: number },
): FloorWorkflowExecutionState | null {
  const exact = map[versionInfo.version_key];
  if (exact) {
    return exact;
  }

  const entries = Object.entries(map) as Array<
    [string, FloorWorkflowExecutionState]
  >;
  if (entries.length === 0) {
    return null;
  }

  const stableEntries = entries.filter(([key]) => !String(key).includes("@rev:"));
  const effectiveEntries = stableEntries.length > 0 ? stableEntries : entries;
  if (effectiveEntries.length === 1) {
    return effectiveEntries[0][1];
  }

  for (let index = effectiveEntries.length - 1; index >= 0; index -= 1) {
    const [, state] = effectiveEntries[index];
    if (Number(state.swipe_id ?? -1) === Number(versionInfo.swipe_id ?? -1)) {
      return state;
    }
  }

  return effectiveEntries[effectiveEntries.length - 1]?.[1] ?? null;
}

function resolveExecutionEntryForVersion(
  map: FloorWorkflowExecutionVersionedMap,
  versionKey: string,
): { key: string; state: FloorWorkflowExecutionState } | null {
  const exact = map[versionKey];
  if (exact) {
    return { key: versionKey, state: exact };
  }

  const entries = Object.entries(map) as Array<
    [string, FloorWorkflowExecutionState]
  >;
  if (entries.length === 1) {
    const [key, state] = entries[0];
    return { key, state };
  }

  return null;
}

export function readFloorWorkflowExecution(
  messageId: number,
  mode: "strict" | "history" = "strict",
): FloorWorkflowExecutionState | null {
  try {
    const message = getChatMessages(messageId)[0];
    if (!message) {
      return null;
    }

    const map = normalizeFloorWorkflowExecutionMap(message?.data?.[EW_FLOOR_WORKFLOW_EXECUTION_KEY]);
    const versionInfo = getMessageVersionInfo(message);
    const exact = map[buildExecutionVersionKey(versionInfo)];
    if (exact) {
      return exact;
    }

    if (mode === "history") {
      return selectExecutionStateForHistory(map, versionInfo);
    }

    const entries = Object.values(map);
    if (entries.length === 1) {
      const only = entries[0];
      if (!only.content_hash) {
        return only;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function readFloorWorkflowExecutionComplete(
  messageId: number,
  mode: "strict" | "history" = "strict",
): Promise<FloorWorkflowExecutionState | null> {
  const message = getChatMessages(messageId)[0];
  if (!message) {
    return null;
  }

  const versionInfo = getMessageVersionInfo(message);
  const map = await readFloorWorkflowExecutionMapComplete(messageId);
  const exact = map[versionInfo.version_key];
  if (exact) {
    return exact;
  }

  if (mode === "history") {
    return selectExecutionStateForHistory(map, versionInfo);
  }

  const values = Object.values(map);
  if (values.length === 1) {
    const only = values[0];
    if (!only.content_hash) {
      return only;
    }
  }

  return null;
}

function syncArtifactMessageVersionMeta(
  nextData: Record<string, unknown>,
  message: any,
): void {
  const versionInfo = getMessageVersionInfo(message);
  nextData[EW_SWIPE_ID_KEY] = versionInfo.swipe_id;
  if (String(versionInfo.content_hash ?? "").trim()) {
    nextData[EW_CONTENT_HASH_KEY] = versionInfo.content_hash;
  } else {
    delete nextData[EW_CONTENT_HASH_KEY];
  }
}

async function persistFloorWorkflowExecutionMap(
  messageId: number,
  map: FloorWorkflowExecutionVersionedMap,
): Promise<void> {
  const resolved = await resolveArtifactStoreForMessage(messageId);
  if (!resolved) {
    return;
  }

  const normalizedMap = normalizeFloorWorkflowExecutionMap(map);
  pruneAllVersionedEntries(normalizedMap, 2);
  const { message, fileName } = resolved;
  const nextData: Record<string, unknown> = {
    ...(message.data ?? {}),
  };

  if (getSettings().snapshot_storage === "file") {
    try {
      const chatId = getCurrentChatKey();
      const charName = getCurrentCharacterNameSafe();
      const store =
        resolved.store ??
        createEmptySnapshotStore(buildSnapshotStoreOwner(charName, chatId));
      store.owner = buildSnapshotStoreOwner(charName, chatId);
      store.workflow_execution = { ...normalizedMap };
      pruneAllVersionedEntries(store.workflow_execution, 2);

      if (Object.keys(normalizedMap).length > 0) {
        await writeSnapshotStore(fileName, store);
        nextData[EW_SNAPSHOT_FILE_KEY] = fileName;
        nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY] =
          buildFloorWorkflowExecutionSummaryMap(normalizedMap);
        syncArtifactMessageVersionMeta(nextData, message);
      } else {
        delete nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY];
        if (hasSnapshotStorePayload(store)) {
          await writeSnapshotStore(fileName, store);
          nextData[EW_SNAPSHOT_FILE_KEY] = fileName;
        } else {
          delete nextData[EW_SNAPSHOT_FILE_KEY];
          await deleteSnapshot(fileName);
        }
      }
    } catch (error) {
      console.warn(
        "[Evolution World] workflow execution artifact externalization failed, falling back to message data:",
        error,
      );
      if (Object.keys(normalizedMap).length > 0) {
        nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY] = normalizedMap;
      } else {
        delete nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY];
      }
    }
  } else if (Object.keys(normalizedMap).length > 0) {
    nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY] = normalizedMap;
  } else {
    delete nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY];
  }

  await setChatMessages([{ message_id: messageId, data: nextData }], {
    refresh: "none",
  });
}

async function writeFloorWorkflowExecution(
  messageId: number,
  state: FloorWorkflowExecutionState | null,
): Promise<void> {
  if (state) {
    const map = await readFloorWorkflowExecutionMapComplete(messageId);
    const versionKey = buildExecutionVersionKey(state);
    const existing = map[versionKey];
    if (existing) {
      const existingJson = JSON.stringify(existing);
      const nextJson = JSON.stringify(state);
      if (existingJson !== nextJson) {
        map[buildArchivedArtifactVersionKey(versionKey, map)] = existing;
      }
    }
    map[versionKey] = state;
    pruneArchivedVersionedEntries(map, versionKey, 2);
    await persistFloorWorkflowExecutionMap(messageId, map);
    return;
  }

  await persistFloorWorkflowExecutionMap(messageId, {});
}

function normalizeWorkflowReplayCapsuleMap(
  raw: unknown,
): Record<string, WorkflowReplayCapsule> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const map: Record<string, WorkflowReplayCapsule> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const obj = value as Record<string, unknown>;
    map[key] = {
      at: Number(obj.at ?? 0),
      request_id: String(obj.request_id ?? "").trim(),
      job_type:
        obj.job_type === "live_auto" ||
        obj.job_type === "live_reroll" ||
        obj.job_type === "historical_rederive"
          ? obj.job_type
          : "live_auto",
      timing:
        obj.timing === "before_reply" ||
        obj.timing === "after_reply" ||
        obj.timing === "manual"
          ? obj.timing
          : "manual",
      source: String(obj.source ?? ""),
      generation_type: String(obj.generation_type ?? ""),
      target_message_id: Number(obj.target_message_id ?? -1),
      target_version_key: String(obj.target_version_key ?? ""),
      target_role:
        obj.target_role === "user" ||
        obj.target_role === "assistant"
          ? obj.target_role
          : "other",
      flow_ids: Array.isArray(obj.flow_ids)
        ? obj.flow_ids.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [],
      flow_ids_hash: String(obj.flow_ids_hash ?? ""),
      capsule_mode: obj.capsule_mode === "full" ? "full" : "light",
      legacy_approx: Boolean(obj.legacy_approx),
      assembled_messages: Array.isArray(obj.assembled_messages)
        ? obj.assembled_messages
            .filter(
              (item) =>
                item && typeof item === "object" && !Array.isArray(item),
            )
            .map((item) => ({
              role: String((item as Record<string, unknown>).role ?? ""),
              content: String((item as Record<string, unknown>).content ?? ""),
              name:
                typeof (item as Record<string, unknown>).name === "string"
                  ? String((item as Record<string, unknown>).name)
                  : undefined,
            }))
        : undefined,
      request_preview: Array.isArray(obj.request_preview)
        ? obj.request_preview
            .filter(
              (item) =>
                item && typeof item === "object" && !Array.isArray(item),
            )
            .map((item) => ({ ...(item as Record<string, unknown>) }))
        : undefined,
      details_externalized: Boolean(obj.details_externalized),
    };
  }

  return map;
}

function buildWorkflowReplayCapsuleSummary(
  capsule: WorkflowReplayCapsule,
): WorkflowReplayCapsule {
  return {
    ...capsule,
    assembled_messages: undefined,
    request_preview: undefined,
    details_externalized: true,
  };
}

function buildWorkflowReplayCapsuleSummaryMap(
  map: Record<string, WorkflowReplayCapsule>,
): Record<string, WorkflowReplayCapsule> {
  const summaryMap: Record<string, WorkflowReplayCapsule> = {};
  for (const [key, value] of Object.entries(map)) {
    summaryMap[key] = buildWorkflowReplayCapsuleSummary(value);
  }
  pruneAllVersionedEntries(summaryMap, 2);
  return summaryMap;
}

function isWorkflowReplayCapsuleSummaryMap(raw: unknown): boolean {
  const map = normalizeWorkflowReplayCapsuleMap(raw);
  const values = Object.values(map);
  return values.length > 0 && values.every((value) => Boolean(value.details_externalized));
}

async function readWorkflowReplayCapsuleMapComplete(
  messageId: number,
): Promise<Record<string, WorkflowReplayCapsule>> {
  const message = getChatMessages(messageId)[0];
  const inline = normalizeWorkflowReplayCapsuleMap(
    message?.data?.[EW_WORKFLOW_REPLAY_CAPSULE_KEY],
  );
  const resolved = await resolveArtifactStoreForMessage(messageId);
  if (!resolved) {
    return inline;
  }

  const external = normalizeWorkflowReplayCapsuleMap(
    resolved.store.replay_capsules,
  );
  if (Object.keys(external).length === 0) {
    return inline;
  }
  if (Object.keys(inline).length === 0) {
    return external;
  }

  return {
    ...inline,
    ...external,
  };
}

async function writeWorkflowReplayCapsule(
  messageId: number,
  capsule: WorkflowReplayCapsule,
  versionInfo?: { version_key: string },
): Promise<void> {
  const resolved = await resolveArtifactStoreForMessage(messageId);
  if (!resolved) {
    return;
  }

  const message = resolved.message;
  const effectiveVersion = versionInfo?.version_key
    ? versionInfo
    : getMessageVersionInfo(message);
  const key = String(effectiveVersion.version_key ?? "").trim();
  if (!key) {
    return;
  }

  const map = await readWorkflowReplayCapsuleMapComplete(messageId);
  const existing = map[key];
  if (existing) {
    const existingJson = JSON.stringify(existing);
    const nextJson = JSON.stringify(capsule);
    if (existingJson !== nextJson) {
      map[buildArchivedArtifactVersionKey(key, map)] = existing;
    }
  }
  map[key] = capsule;
  pruneArchivedVersionedEntries(map, key, 2);

  const normalizedMap = normalizeWorkflowReplayCapsuleMap(map);
  pruneAllVersionedEntries(normalizedMap, 2);
  const nextData: Record<string, unknown> = {
    ...(message.data ?? {}),
  };

  if (getSettings().snapshot_storage === "file") {
    try {
      const chatId = getCurrentChatKey();
      const charName = getCurrentCharacterNameSafe();
      const store =
        resolved.store ??
        createEmptySnapshotStore(buildSnapshotStoreOwner(charName, chatId));
      store.owner = buildSnapshotStoreOwner(charName, chatId);
      store.replay_capsules = { ...normalizedMap };
      pruneAllVersionedEntries(store.replay_capsules, 2);

      if (Object.keys(normalizedMap).length > 0) {
        await writeSnapshotStore(resolved.fileName, store);
        nextData[EW_SNAPSHOT_FILE_KEY] = resolved.fileName;
        nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] =
          buildWorkflowReplayCapsuleSummaryMap(normalizedMap);
        syncArtifactMessageVersionMeta(nextData, message);
      } else {
        delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
        if (hasSnapshotStorePayload(store)) {
          await writeSnapshotStore(resolved.fileName, store);
          nextData[EW_SNAPSHOT_FILE_KEY] = resolved.fileName;
        } else {
          delete nextData[EW_SNAPSHOT_FILE_KEY];
          await deleteSnapshot(resolved.fileName);
        }
      }
    } catch (error) {
      console.warn(
        "[Evolution World] replay capsule externalization failed, falling back to message data:",
        error,
      );
      if (Object.keys(normalizedMap).length > 0) {
        nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] = normalizedMap;
      } else {
        delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
      }
    }
  } else if (Object.keys(normalizedMap).length > 0) {
    nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] = normalizedMap;
  } else {
    delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
  }

  await setChatMessages([{ message_id: messageId, data: nextData }], {
    refresh: "none",
  });
}

async function migrateFloorWorkflowCapsuleToAssistant(
  sourceMessageId: number,
  assistantMessageId: number,
): Promise<{ migrated: boolean; reason?: string }> {
  if (sourceMessageId === assistantMessageId) {
    return { migrated: false, reason: "same_message" };
  }

  const sourceMsg = getChatMessages(sourceMessageId)[0];
  const assistantMsg = getChatMessages(assistantMessageId)[0];
  if (!sourceMsg || !assistantMsg) {
    return { migrated: false, reason: "message_not_found" };
  }

  const sourceMap = await readWorkflowReplayCapsuleMapComplete(sourceMessageId);
  const sourceVersionInfo = getMessageVersionInfo(sourceMsg);
  const sourceCapsule = sourceMap[sourceVersionInfo.version_key];
  if (!sourceCapsule) {
    return { migrated: false, reason: "source_capsule_missing" };
  }

  const assistantMap = await readWorkflowReplayCapsuleMapComplete(
    assistantMessageId,
  );
  const assistantVersionInfo = getMessageVersionInfo(assistantMsg);
  assistantMap[assistantVersionInfo.version_key] = {
    ...sourceCapsule,
    target_message_id: assistantMessageId,
    target_version_key: assistantVersionInfo.version_key,
    target_role: "assistant",
  };
  delete sourceMap[sourceVersionInfo.version_key];
  await writeWorkflowReplayCapsule(
    assistantMessageId,
    assistantMap[assistantVersionInfo.version_key],
    assistantVersionInfo,
  );
  const sourceResolved = await resolveArtifactStoreForMessage(sourceMessageId);
  if (sourceResolved) {
    const sourceNormalizedMap = normalizeWorkflowReplayCapsuleMap(sourceMap);
    pruneAllVersionedEntries(sourceNormalizedMap, 2);
    const nextData: Record<string, unknown> = {
      ...(sourceResolved.message.data ?? {}),
    };

    if (getSettings().snapshot_storage === "file") {
      const store = sourceResolved.store;
      store.replay_capsules = { ...sourceNormalizedMap };
      pruneAllVersionedEntries(store.replay_capsules, 2);
      if (Object.keys(sourceNormalizedMap).length > 0) {
        await writeSnapshotStore(sourceResolved.fileName, store);
        nextData[EW_SNAPSHOT_FILE_KEY] = sourceResolved.fileName;
        nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] =
          buildWorkflowReplayCapsuleSummaryMap(sourceNormalizedMap);
        syncArtifactMessageVersionMeta(nextData, sourceResolved.message);
      } else {
        delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
        if (hasSnapshotStorePayload(store)) {
          await writeSnapshotStore(sourceResolved.fileName, store);
          nextData[EW_SNAPSHOT_FILE_KEY] = sourceResolved.fileName;
        } else {
          delete nextData[EW_SNAPSHOT_FILE_KEY];
          await deleteSnapshot(sourceResolved.fileName);
        }
      }
    } else if (Object.keys(sourceNormalizedMap).length > 0) {
      nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] = sourceNormalizedMap;
    } else {
      delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
    }

    await setChatMessages([{ message_id: sourceMessageId, data: nextData }], {
      refresh: "none",
    });
  }

  return { migrated: true };
}

async function pinFloorWorkflowExecutionToCurrentVersion(
  messageId: number,
  state: FloorWorkflowExecutionState | null,
): Promise<boolean> {
  if (!state) {
    return false;
  }

  const message = getChatMessages(messageId)[0];
  if (!message) {
    return false;
  }

  const versionInfo = getMessageVersionInfo(message);
  const targetKey = buildExecutionVersionKey(versionInfo);
  const map = await readFloorWorkflowExecutionMapComplete(messageId);
  if (map[targetKey]) {
    return false;
  }

  map[targetKey] = {
    ...state,
    swipe_id: versionInfo.swipe_id,
    content_hash: versionInfo.content_hash,
  };

  await persistFloorWorkflowExecutionMap(messageId, map);
  return true;
}

async function migrateFloorWorkflowExecutionToAssistant(
  sourceMessageId: number,
  assistantMessageId: number,
): Promise<{ migrated: boolean; reason?: string }> {
  if (sourceMessageId === assistantMessageId) {
    return { migrated: false, reason: "same_message" };
  }

  const sourceMsg = getChatMessages(sourceMessageId)[0];
  const assistantMsg = getChatMessages(assistantMessageId)[0];
  if (!sourceMsg || !assistantMsg) {
    return { migrated: false, reason: "message_not_found" };
  }

  const sourceVersionInfo = getMessageVersionInfo(sourceMsg);
  const assistantVersionInfo = getMessageVersionInfo(assistantMsg);
  const sourceMap = await readFloorWorkflowExecutionMapComplete(sourceMessageId);
  const sourceResolved = resolveExecutionEntryForVersion(
    sourceMap,
    buildExecutionVersionKey(sourceVersionInfo),
  );
  if (!sourceResolved) {
    return { migrated: false, reason: "source_execution_missing" };
  }

  const targetMap = await readFloorWorkflowExecutionMapComplete(
    assistantMessageId,
  );
  const targetKey = buildExecutionVersionKey(assistantVersionInfo);
  let mutated = false;

  if (!targetMap[targetKey]) {
    targetMap[targetKey] = {
      ...sourceResolved.state,
      swipe_id: assistantVersionInfo.swipe_id,
      content_hash: assistantVersionInfo.content_hash,
    };
    mutated = true;
  }

  if (sourceMap[sourceResolved.key]) {
    delete sourceMap[sourceResolved.key];
    mutated = true;
  }

  if (!mutated) {
    return { migrated: false, reason: "already_migrated" };
  }

  await persistFloorWorkflowExecutionMap(sourceMessageId, sourceMap);
  await persistFloorWorkflowExecutionMap(assistantMessageId, targetMap);

  return { migrated: true };
}

async function writeBeforeReplyBindingMeta(
  sourceMessageId: number,
  assistantMessageId: number,
  requestId: string,
): Promise<void> {
  const sourceMsg = getChatMessages(sourceMessageId)[0];
  const assistantMsg = getChatMessages(assistantMessageId)[0];
  if (!sourceMsg || !assistantMsg) {
    return;
  }

  const migratedAt = Date.now();
  const sourceData: Record<string, unknown> = {
    ...(sourceMsg.data ?? {}),
    [EW_BEFORE_REPLY_BINDING_KEY]: {
      role: "source",
      paired_message_id: assistantMessageId,
      request_id: requestId,
      migrated_at: migratedAt,
    },
  };
  const assistantData: Record<string, unknown> = {
    ...(assistantMsg.data ?? {}),
    [EW_BEFORE_REPLY_BINDING_KEY]: {
      role: "assistant_anchor",
      paired_message_id: sourceMessageId,
      request_id: requestId,
      migrated_at: migratedAt,
    },
  };

  await setChatMessages(
    [
      { message_id: sourceMessageId, data: sourceData },
      { message_id: assistantMessageId, data: assistantData },
    ],
    { refresh: "none" },
  );
}

async function migrateBeforeReplyBindingToAssistant(
  settings: EwSettings,
  assistantMessageId: number,
  pendingUserMessageId: number | null,
): Promise<BeforeReplyBindingMigrationResult> {
  const pending = pruneExpiredBeforeReplyBindingPending();
  if (!pending) {
    return {
      migrated: false,
      capsule_migrated: false,
      snapshot_migrated: false,
      execution_migrated: false,
      reason: "pending_missing_or_expired",
    };
  }

  if (pending.migrated) {
    return {
      migrated: false,
      capsule_migrated: false,
      snapshot_migrated: false,
      execution_migrated: false,
      reason: "already_migrated",
    };
  }

  if (
    !Number.isFinite(pendingUserMessageId) ||
    pending.user_message_id !== pendingUserMessageId
  ) {
    return {
      migrated: false,
      capsule_migrated: false,
      snapshot_migrated: false,
      execution_migrated: false,
      reason: "user_floor_mismatch",
    };
  }

  if (
    !Number.isFinite(pending.source_message_id) ||
    pending.source_message_id < 0
  ) {
    clearBeforeReplyBindingPending();
    return {
      migrated: false,
      capsule_migrated: false,
      snapshot_migrated: false,
      execution_migrated: false,
      reason: "invalid_source_floor",
    };
  }

  const snapshotMove = await rebindFloorSnapshotToMessage(
    settings,
    pending.source_message_id,
    assistantMessageId,
  );
  const executionMove = await migrateFloorWorkflowExecutionToAssistant(
    pending.source_message_id,
    assistantMessageId,
  );
  const capsuleMove = await migrateFloorWorkflowCapsuleToAssistant(
    pending.source_message_id,
    assistantMessageId,
  );
  const migrated =
    snapshotMove.migrated || executionMove.migrated || capsuleMove.migrated;
  const result: BeforeReplyBindingMigrationResult = {
    migrated,
    snapshot_migrated: snapshotMove.migrated,
    execution_migrated: executionMove.migrated,
    capsule_migrated: capsuleMove.migrated,
    snapshot_reason: snapshotMove.reason,
    execution_reason: executionMove.reason,
    capsule_reason: capsuleMove.reason,
    reason: `snapshot:${snapshotMove.reason ?? "migrated"},execution:${executionMove.reason ?? "migrated"},capsule:${capsuleMove.reason ?? "migrated"}`,
  };

  if (migrated) {
    await writeBeforeReplyBindingMeta(
      pending.source_message_id,
      assistantMessageId,
      pending.request_id,
    );
    markBeforeReplyBindingMigrated(assistantMessageId);
    return result;
  }

  return result;
}

function buildFloorWorkflowExecutionState(
  requestId: string,
  attempts: Array<{
    flow: { id: string };
    ok: boolean;
    response?: Record<string, any>;
  }>,
  workflowFailed = false,
  preservedResults: FloorWorkflowStoredResult[] = [],
  versionInfo?: { swipe_id?: number; content_hash?: string },
  meta?: { execution_status?: "executed" | "skipped"; skip_reason?: string },
): FloorWorkflowExecutionState {
  const successfulResults = new Map<string, FloorWorkflowStoredResult>(
    preservedResults.map((result) => [result.flow_id, result]),
  );
  const failedFlowIds = new Set<string>();
  const attemptedFlowIds = new Set<string>();

  for (const attempt of attempts) {
    const flowId = String(attempt.flow.id ?? "").trim();
    if (!flowId) {
      continue;
    }
    attemptedFlowIds.add(flowId);

    if (attempt.ok && attempt.response) {
      successfulResults.set(flowId, {
        flow_id: flowId,
        response: klona(attempt.response),
      });
      failedFlowIds.delete(flowId);
    } else {
      successfulResults.delete(flowId);
      failedFlowIds.add(flowId);
    }
  }

  return {
    at: Date.now(),
    request_id: requestId,
    swipe_id: versionInfo?.swipe_id,
    content_hash: versionInfo?.content_hash,
    attempted_flow_ids: [...attemptedFlowIds],
    successful_results: [...successfulResults.values()],
    successful_flow_ids: [...successfulResults.keys()],
    failed_flow_ids: [...failedFlowIds],
    workflow_failed: workflowFailed || failedFlowIds.size > 0,
    execution_status: meta?.execution_status ?? "executed",
    skip_reason: meta?.skip_reason,
  };
}

async function buildPreservedDispatchResults(
  settings: EwSettings,
  preservedResults: FloorWorkflowStoredResult[],
): Promise<DispatchFlowResult[]> {
  if (preservedResults.length === 0) {
    return [];
  }

  const effectiveFlows = await getEffectiveFlows(settings);
  const flowOrderById = new Map(
    effectiveFlows.map((flow, index) => [flow.id, index]),
  );
  const flowById = new Map(effectiveFlows.map((flow) => [flow.id, flow]));

  return preservedResults
    .map((result) => {
      const flow = flowById.get(result.flow_id);
      if (!flow) {
        return null;
      }

      return {
        flow,
        flow_order: flowOrderById.get(result.flow_id) ?? 0,
        response: result.response as any,
      } satisfies DispatchFlowResult;
    })
    .filter((result): result is DispatchFlowResult => Boolean(result));
}

function collectSuccessfulDispatchResultsFromAttempts(
  attempts: Array<{
    ok: boolean;
    response?: Record<string, any>;
    flow: DispatchFlowResult["flow"];
    flow_order: number;
  }>,
): DispatchFlowResult[] {
  return attempts
    .filter((attempt) => attempt.ok && attempt.response)
    .map((attempt) => ({
      flow: attempt.flow,
      flow_order: attempt.flow_order,
      response: attempt.response as any,
    }));
}

function mergePreservedDispatchResults(
  current: DispatchFlowResult[],
  next: DispatchFlowResult[],
): DispatchFlowResult[] {
  const resultByFlowId = new Map<string, DispatchFlowResult>();

  for (const item of current) {
    resultByFlowId.set(item.flow.id, item);
  }

  for (const item of next) {
    resultByFlowId.set(item.flow.id, item);
  }

  return [...resultByFlowId.values()].sort(
    (left, right) => left.flow_order - right.flow_order,
  );
}

type FailedOnlyRerollResolution =
  | {
      ok: true;
      flowIds: string[];
      preservedResults: FloorWorkflowStoredResult[];
      fallbackToAll?: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

async function resolveFailedOnlyRerollTarget(
  settings: EwSettings,
  messageId: number,
): Promise<FailedOnlyRerollResolution> {
  const executionState = readFloorWorkflowExecution(messageId);
  if (!executionState) {
    return { ok: false, reason: "当前楼还没有可用的失败执行记录" };
  }

  const effectiveFlows = await getEffectiveFlows(settings);
  const flowMap = new Map(effectiveFlows.map((flow) => [flow.id, flow]));

  if (executionState.failed_flow_ids.length === 0) {
    if (
      executionState.workflow_failed &&
      executionState.attempted_flow_ids.length > 0
    ) {
      const flowIds = executionState.attempted_flow_ids.filter((flowId) =>
        flowMap.has(flowId),
      );

      if (flowIds.length === 0) {
        return { ok: false, reason: "当前楼失败时涉及的工作流已被禁用或删除" };
      }

      return {
        ok: true,
        flowIds,
        preservedResults: [],
        fallbackToAll: true,
      };
    }

    return { ok: false, reason: "当前楼没有失败的工作流可供重跑" };
  }

  const flowIds = executionState.failed_flow_ids.filter((flowId) =>
    flowMap.has(flowId),
  );
  if (flowIds.length === 0) {
    return { ok: false, reason: "当前楼记录中的失败工作流已被禁用或删除" };
  }

  return {
    ok: true,
    flowIds,
    preservedResults: executionState.successful_results.filter((result) => {
      return flowMap.has(result.flow_id) && !flowIds.includes(result.flow_id);
    }),
  };
}

function resolveAssistantFloorOrdinal(messageId: number): number {
  const normalizedMessageId = Math.max(0, Math.trunc(Number(messageId) || 0));
  let matchedCount = 0;

  try {
    const messages = getChatMessages(`0-${normalizedMessageId}`);
    for (const message of Array.isArray(messages) ? messages : []) {
      if (String(message?.role ?? "") === "assistant") {
        matchedCount += 1;
      }
      if (Number(message?.message_id) === normalizedMessageId) {
        return Math.max(1, matchedCount);
      }
    }
  } catch {
    // ignore and fall through to safe fallback
  }

  return Math.max(1, matchedCount || 1);
}

function resolveBeforeReplyPair(
  messageId: number,
): { source_message_id: number; assistant_message_id?: number } {
  const message = getChatMessages(messageId)[0];
  if (!message) {
    return { source_message_id: messageId };
  }

  const bindingMeta = message.data?.[EW_BEFORE_REPLY_BINDING_KEY] as
    | { role?: unknown; paired_message_id?: unknown }
    | undefined;
  const role = typeof bindingMeta?.role === "string" ? String(bindingMeta.role) : "";
  const paired = Number(bindingMeta?.paired_message_id);
  const pairedMessageId = Number.isFinite(paired) ? paired : undefined;

  if (message.role === "assistant") {
    if (role === "assistant_anchor" && Number.isFinite(pairedMessageId)) {
      return {
        source_message_id: Number(pairedMessageId),
        assistant_message_id: messageId,
      };
    }
    return { source_message_id: messageId, assistant_message_id: messageId };
  }

  if (message.role === "user") {
    if (role === "source" && Number.isFinite(pairedMessageId)) {
      return {
        source_message_id: messageId,
        assistant_message_id: Number(pairedMessageId),
      };
    }
    const nextMessage = getChatMessages(messageId + 1)[0];
    if (nextMessage?.role === "assistant") {
      return {
        source_message_id: messageId,
        assistant_message_id: Number(nextMessage.message_id),
      };
    }
    return { source_message_id: messageId };
  }

  return { source_message_id: messageId };
}

function resolveAssistantSourceUserMessageId(messageId: number): number | null {
  const pair = resolveBeforeReplyPair(messageId);
  if (
    Number.isFinite(pair.assistant_message_id) &&
    Number(pair.assistant_message_id) === messageId
  ) {
    return Number.isFinite(pair.source_message_id)
      ? Number(pair.source_message_id)
      : null;
  }

  const previousMessage = getChatMessages(messageId - 1)[0];
  if (previousMessage?.role === "user") {
    return Number(previousMessage.message_id);
  }

  return null;
}

function shouldFlowRunOnAfterReplyFloor(
  flow: { timing?: string; run_every_n_floors?: number },
  settings: EwSettings,
  ordinal: number,
): boolean {
  const effectiveTiming = flow?.timing === "default" ? settings.workflow_timing : flow?.timing;
  if (effectiveTiming !== "after_reply") {
    return false;
  }

  const interval = Math.max(1, Math.trunc(Number(flow?.run_every_n_floors ?? 1) || 1));
  if (interval <= 1) {
    return true;
  }

  return ordinal % interval === 0;
}

async function resolveEligibleAfterReplyFlowIds(
  settings: EwSettings,
  messageId: number,
): Promise<string[]> {
  const ordinal = resolveAssistantFloorOrdinal(messageId);
  const effectiveFlows = await getEffectiveFlows(settings);
  return effectiveFlows
    .filter((flow) => shouldFlowRunOnAfterReplyFloor(flow, settings, ordinal))
    .map((flow) => String(flow.id ?? "").trim())
    .filter(Boolean);
}

function resolveAutoRerollTarget(
  result: Awaited<ReturnType<typeof runWorkflow>>,
): { ok: true; flowIds: string[] } | { ok: false; reason: string } {
  const failedFlowIds = dedupeStrings(
    result.attempts
      .filter((attempt) => !attempt.ok)
      .map((attempt) => String(attempt.flow.id ?? "").trim()),
  );

  if (failedFlowIds.length > 0) {
    return { ok: true, flowIds: failedFlowIds };
  }

  return {
    ok: false,
    reason: "未定位到失败工作流；自动重roll已跳过。",
  };
}

async function writeRederiveMeta(
  messageId: number,
  meta: {
    source_job: WorkflowJobType;
    legacy_approx: boolean;
    timing: "before_reply" | "after_reply" | "manual";
    conflicts: number;
    conflict_names: string[];
    writeback_applied: number;
    writeback_ok: boolean;
  },
): Promise<void> {
  const message = getChatMessages(messageId)[0];
  if (!message) {
    return;
  }

  const nextData: Record<string, unknown> = {
    ...(message.data ?? {}),
    [EW_REDERIVE_META_KEY]: {
      at: Date.now(),
      source_job: meta.source_job,
      legacy_approx: meta.legacy_approx,
      timing: meta.timing,
      conflicts: meta.conflicts,
      conflict_names: meta.conflict_names,
      writeback_applied: meta.writeback_applied,
      writeback_ok: meta.writeback_ok,
    },
  };

  await setChatMessages([{ message_id: messageId, data: nextData }], {
    refresh: "none",
  });
}

export async function compactCurrentChatArtifacts(
  settings = getSettings(),
): Promise<{ compacted: number; warnings: string[] }> {
  if (settings.snapshot_storage !== "file") {
    return { compacted: 0, warnings: [] };
  }

  const chatKey = getCurrentChatKey();
  const existing = artifactCompactionInFlightByChat.get(chatKey);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const warnings: string[] = [];
    let compacted = 0;
    const lastId = getLastMessageId();
    if (lastId < 0) {
      return { compacted, warnings };
    }

    const allMessages = getChatMessages(`0-${lastId}`);
    for (const msg of allMessages) {
      const rawExecution = msg?.data?.[EW_FLOOR_WORKFLOW_EXECUTION_KEY];
      const rawCapsule = msg?.data?.[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
      const executionMap = normalizeFloorWorkflowExecutionMap(rawExecution);
      const capsuleMap = normalizeWorkflowReplayCapsuleMap(rawCapsule);
      const shouldCompactExecution =
        Object.keys(executionMap).length > 0 &&
        !isExecutionSummaryOnlyMap(rawExecution);
      const shouldCompactCapsule =
        Object.keys(capsuleMap).length > 0 &&
        !isWorkflowReplayCapsuleSummaryMap(rawCapsule);
      if (!shouldCompactExecution && !shouldCompactCapsule) {
        continue;
      }

      try {
        if (shouldCompactExecution) {
          await persistFloorWorkflowExecutionMap(msg.message_id, executionMap);
        }
        if (shouldCompactCapsule) {
          const versionInfo = getMessageVersionInfo(msg);
          const stableKey = versionInfo.version_key;
          const normalizedCapsules = normalizeWorkflowReplayCapsuleMap(
            capsuleMap,
          );
          const resolved = await resolveArtifactStoreForMessage(msg.message_id);
          if (resolved) {
            const nextData: Record<string, unknown> = {
              ...(resolved.message.data ?? {}),
            };
            const store = resolved.store;
            store.replay_capsules = { ...normalizedCapsules };
            pruneAllVersionedEntries(store.replay_capsules, 2);
            if (Object.keys(normalizedCapsules).length > 0) {
              await writeSnapshotStore(resolved.fileName, store);
              nextData[EW_SNAPSHOT_FILE_KEY] = resolved.fileName;
              nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] =
                buildWorkflowReplayCapsuleSummaryMap(normalizedCapsules);
              if (normalizedCapsules[stableKey]) {
                syncArtifactMessageVersionMeta(nextData, resolved.message);
              }
            } else {
              delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
              if (hasSnapshotStorePayload(store)) {
                await writeSnapshotStore(resolved.fileName, store);
                nextData[EW_SNAPSHOT_FILE_KEY] = resolved.fileName;
              } else {
                delete nextData[EW_SNAPSHOT_FILE_KEY];
                await deleteSnapshot(resolved.fileName);
              }
            }
            await setChatMessages(
              [{ message_id: msg.message_id, data: nextData }],
              { refresh: "none" },
            );
          }
        }
        compacted += 1;
      } catch (error) {
        warnings.push(
          `message #${msg.message_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (warnings.length > 0) {
      console.warn("[Evolution World] artifact compaction warnings:", warnings);
    }

    return { compacted, warnings };
  })();

  artifactCompactionInFlightByChat.set(chatKey, task);
  try {
    return await task;
  } finally {
    artifactCompactionInFlightByChat.delete(chatKey);
  }
}

function syncAfterReplyFailureQueue(
  options: ExecuteWorkflowOptions,
  executionState: FloorWorkflowExecutionState | null,
  workflowSucceeded: boolean,
): void {
  if (options.trigger.timing !== "after_reply") {
    return;
  }

  const chatKey = getCurrentChatKey();
  const assistantMessageId =
    options.trigger.assistant_message_id ?? options.messageId;
  if (
    workflowSucceeded ||
    !executionState ||
    (!executionState.workflow_failed &&
      executionState.failed_flow_ids.length === 0)
  ) {
    removeFailedAfterReplyJob(chatKey, assistantMessageId);
    return;
  }

  upsertFailedAfterReplyJob({
    chat_key: chatKey,
    message_id: assistantMessageId,
    user_message_id: Number.isFinite(options.trigger.user_message_id)
      ? Number(options.trigger.user_message_id)
      : undefined,
    user_input: String(options.userInput ?? ""),
    generation_type: options.trigger.generation_type,
    failed_at: executionState.at || Date.now(),
  });
}

function buildBeforeReplyIdentityKey(
  messageId: number,
  generationType: string,
  userInput: string,
): string {
  const normalizedText = String(userInput ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return `${getCurrentChatKey()}:before_reply:${messageId}:${generationType}:${simpleHash(normalizedText)}`;
}

function buildAfterReplyDedupKey(
  messageText: string,
  pendingUserMessageId: number | null,
): string {
  const normalizedText = String(messageText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const contentHash = simpleHash(normalizedText);
  const userMessagePart = Number.isFinite(pendingUserMessageId)
    ? `user:${pendingUserMessageId}`
    : "user:unknown";
  return `${getCurrentChatKey()}:${userMessagePart}:${contentHash}`;
}

function buildAfterReplyIdentityKey(input: {
  chatKey: string;
  messageId: number;
  generationSeq: number;
  pendingUserMessageId: number | null;
  generationType: string;
}): string {
  const userMessagePart = Number.isFinite(input.pendingUserMessageId)
    ? `user:${input.pendingUserMessageId}`
    : "user:unknown";
  return `${input.chatKey}:assistant:${input.messageId}:gen:${Math.max(
    0,
    Math.trunc(input.generationSeq || 0),
  )}:${userMessagePart}:${String(input.generationType || "normal").trim() || "normal"}`;
}

function createProcessingReminder(onAbort: () => void) {
  let state: EwWorkflowNoticeInput = {
    title: "Evolution World",
    message: "正在读取上下文并处理本轮工作流，请稍后…",
    level: "info",
    persist: true,
    busy: true,
    collapse_after_ms: WORKFLOW_NOTICE_COLLAPSE_MS,
    island: {},
    action: {
      label: "终止处理",
      kind: "danger",
      onClick: onAbort,
    },
  };

  const handle = showManagedWorkflowNotice(state);

  const update = (next: Partial<EwWorkflowNoticeInput>) => {
    state = {
      ...state,
      ...next,
      island: {
        ...(state.island ?? {}),
        ...(next.island ?? {}),
      },
    };
    handle.update(state);
  };

  return {
    update,
    dismiss: handle.dismiss,
    collapse: handle.collapse,
    expand: handle.expand,
  };
}

type WorkflowExecutionOutcome = {
  shouldAbortGeneration: boolean;
  workflowSucceeded: boolean;
  abortedByUser: boolean;
};

type ExecuteWorkflowOptions = {
  messageId: number;
  userInput?: string;
  injectReply: boolean;
  flowIds?: string[];
  timingFilter?: "before_reply" | "after_reply";
  preservedResults?: FloorWorkflowStoredResult[];
  jobType?: WorkflowJobType;
  contextCursor?: ContextCursor;
  writebackPolicy?: WorkflowWritebackPolicy;
  rederiveOptions?: {
    legacy_approx?: boolean;
    capsule_mode?: WorkflowCapsuleMode;
  };
  trigger: {
    timing: "before_reply" | "after_reply" | "manual";
    source: string;
    generation_type: string;
    user_message_id?: number;
    assistant_message_id?: number;
  };
  reminderMessage: string;
  successMessage: string;
};

function setSendTextareaValue(text: string): void {
  const textarea = getChatDocument().getElementById(
    "send_textarea",
  ) as HTMLTextAreaElement | null;
  if (!textarea) {
    return;
  }

  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function restoreOriginalGenerateInput(
  options: Record<string, any>,
  userInput: string,
): void {
  if (
    Array.isArray(options.injects) &&
    options.injects[0] &&
    typeof options.injects[0] === "object"
  ) {
    options.injects[0].content = userInput;
    return;
  }

  if (typeof options.prompt === "string") {
    options.prompt = userInput;
    return;
  }

  options.user_input = userInput;
}

function shouldReleaseInterceptedMessage(
  settings: EwSettings,
  outcome: WorkflowExecutionOutcome,
): boolean {
  if (outcome.abortedByUser) {
    return false;
  }

  const policy = settings.intercept_release_policy ?? "success_only";
  if (policy === "never") {
    return false;
  }
  if (policy === "always") {
    return true;
  }

  return outcome.workflowSucceeded;
}

async function rollbackInterceptedUserMessage(
  messageId: number | null | undefined,
  userInput: string,
  generationType: string,
): Promise<void> {
  if (messageId == null || NON_SEND_GENERATION_TYPES.has(generationType)) {
    return;
  }

  if (messageId !== getLastMessageId()) {
    return;
  }

  const message = getChatMessages(messageId)[0];
  const messageText = String(message?.message ?? "").trim();
  if (!message || message.role !== "user") {
    return;
  }

  if (userInput.trim() && messageText !== userInput.trim()) {
    return;
  }

  try {
    const ctx = getSTContext() as any;
    if (typeof ctx.deleteLastMessage === "function") {
      await ctx.deleteLastMessage();
      clearAfterReplyPending();
      return;
    }
  } catch (error) {
    console.warn(
      "[Evolution World] Failed to rollback intercepted user message:",
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-flow timing gate (fast sync check).
// Returns true if there are potentially matching flows for the given timing.
// This only checks global flows as a fast-path; char-flows are filtered by
// the pipeline's timing_filter after getEffectiveFlows().
// ---------------------------------------------------------------------------

function hasFlowsForTiming(
  settings: EwSettings,
  timing: "before_reply" | "after_reply",
): boolean {
  // Fast path: any global flow explicitly or effectively matches
  const globalMatch = settings.flows.some((f) => {
    if (!f.enabled) return false;
    const effective =
      f.timing === "default" ? settings.workflow_timing : f.timing;
    return effective === timing;
  });
  if (globalMatch) return true;
  // Fallback: if the global default equals the requested timing,
  // char-flows with timing:'default' would resolve to it — proceed
  // and let the pipeline's timing_filter do the authoritative check.
  return settings.workflow_timing === timing;
}

// ---------------------------------------------------------------------------
// Shared workflow execution with failure-policy handling.
// Both the TavernHelper hook and GENERATION_AFTER_COMMANDS fallback call this.
// ---------------------------------------------------------------------------

async function executeWorkflowWithPolicy(
  settings: EwSettings,
  options: ExecuteWorkflowOptions,
): Promise<WorkflowExecutionOutcome> {
  const supportStatus = getWorkflowSupportStatus();
  if (!supportStatus.ok) {
    console.warn(
      `[Evolution World] workflow skipped in unsupported context: ${supportStatus.reason}`,
    );
    showManagedWorkflowNotice({
      title: "Evolution World",
      message: supportStatus.message,
      level: "warning",
      persist: false,
      busy: false,
      duration_ms: 4600,
      collapse_after_ms: 0,
    });
    return {
      shouldAbortGeneration: false,
      workflowSucceeded: true,
      abortedByUser: false,
    };
  }

  // Returns the workflow outcome so the primary interception path can decide
  // whether the original user message should be released after EW processing.
  // Apply incremental hide check before workflow so AI context is up-to-date
  try {
    runIncrementalHideCheck(settings.hide_settings);
  } catch (e) {
    console.warn("[Evolution World] Hide check failed:", e);
  }

  const workflowAbortController = new AbortController();
  let abortedByUser = false;

  const buildAbortableReminder = (
    message: string,
    level: "info" | "warning" = "info",
  ) => ({
    title: "Evolution World",
    message,
    level,
    persist: true,
    busy: true,
    action: {
      label: "终止处理",
      kind: "danger" as const,
      onClick: cancelWorkflow,
    },
  });

  const cancelWorkflow = () => {
    if (abortedByUser) {
      return;
    }
    abortedByUser = true;
    workflowAbortController.abort();
    stopGenerationNow();
    processingReminder.update({
      title: "Evolution World",
      message: "正在终止本轮处理，请稍后…",
      level: "warning",
      persist: true,
      busy: true,
      action: undefined,
    });
  };

  const processingReminder = createProcessingReminder(cancelWorkflow);
  processingReminder.update(buildAbortableReminder(options.reminderMessage));
  let reminderSettled = false;
  let currentPreservedStoredResults = [...(options.preservedResults ?? [])];
  let currentPreservedDispatchResults = await buildPreservedDispatchResults(
    settings,
    currentPreservedStoredResults,
  );
  let lastAfterReplyExecutionState: FloorWorkflowExecutionState | null = null;
  let currentFlowIds = options.flowIds ? [...options.flowIds] : undefined;

  const trimPreview = (text: string | undefined, maxLength: number) => {
    const normalized = String(text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
  };

  // D: multi-flow tracking
  type FlowIslandData = {
    flow_id: string;
    entry_name?: string;
    content?: string;
    flow_order: number;
  };
  const activeFlows = new Map<string, FlowIslandData>();
  let carouselIndex = 0;
  let carouselTimer: ReturnType<typeof setInterval> | null = null;
  let totalFlowCount = 0;
  let completedFlowCount = 0;

  const getRotatedIsland = (): {
    entry_name?: string;
    content?: string;
    extra_count: number;
  } => {
    const flows = [...activeFlows.values()].sort(
      (a, b) => a.flow_order - b.flow_order,
    );
    if (flows.length === 0) {
      return { extra_count: 0 };
    }
    const idx = carouselIndex % flows.length;
    const current = flows[idx];
    return {
      entry_name: current.entry_name,
      content: current.content,
      extra_count: Math.max(0, flows.length - 1),
    };
  };

  const startCarousel = () => {
    if (carouselTimer) return;
    carouselTimer = setInterval(() => {
      if (activeFlows.size > 1) {
        carouselIndex++;
        processingReminder.update({
          island: getRotatedIsland(),
        });
      }
    }, 3000);
  };

  const stopCarousel = () => {
    if (carouselTimer) {
      clearInterval(carouselTimer);
      carouselTimer = null;
    }
  };

  const handleWorkflowProgress = (update: WorkflowProgressUpdate) => {
    if (reminderSettled) {
      return;
    }

    switch (update.phase) {
      case "preparing":
        processingReminder.update({
          message: update.message ?? options.reminderMessage,
          level: "info",
          persist: true,
          busy: true,
        });
        break;
      case "dispatching":
        // extract total flow count from message (e.g. "已装载 3 条工作流")
        {
          const match = update.message?.match(/装载\s*(\d+)\s*条/);
          if (match) {
            totalFlowCount = parseInt(match[1], 10);
          }
        }
        processingReminder.update({
          message: update.message ?? options.reminderMessage,
          level: "info",
          persist: true,
          busy: true,
          flow_progress:
            totalFlowCount > 0
              ? { completed: completedFlowCount, total: totalFlowCount }
              : undefined,
        });
        break;
      case "merging":
      case "committing":
        // All flows complete — clear active flows
        completedFlowCount = activeFlows.size;
        activeFlows.clear();
        stopCarousel();
        processingReminder.update({
          message: update.message ?? options.reminderMessage,
          level: "info",
          persist: true,
          busy: true,
          island: { extra_count: 0 },
          flow_progress:
            totalFlowCount > 0
              ? { completed: completedFlowCount, total: totalFlowCount }
              : undefined,
        });
        break;
      case "flow_started": {
        const flowId = update.flow_id ?? "";
        if (flowId) {
          activeFlows.set(flowId, {
            flow_id: flowId,
            entry_name: update.flow_name?.trim() || undefined,
            content: undefined,
            flow_order: update.flow_order ?? 0,
          });
          if (activeFlows.size > 1) {
            startCarousel();
          }
        }
        processingReminder.update({
          message: update.message ?? options.reminderMessage,
          persist: true,
          busy: true,
          level: "info",
          island: getRotatedIsland(),
          workflow_name: update.flow_name?.trim() || undefined,
          flow_progress:
            totalFlowCount > 0
              ? { completed: completedFlowCount, total: totalFlowCount }
              : undefined,
        });
        break;
      }
      case "streaming": {
        const flowId = update.flow_id ?? "";
        const previewName = trimPreview(update.stream_preview?.entry_name, 28);
        const previewContent = trimPreview(update.stream_preview?.content, 54);

        // Update the active flow's data
        if (flowId && activeFlows.has(flowId)) {
          const flow = activeFlows.get(flowId)!;
          flow.entry_name = previewName || flow.entry_name;
          flow.content = previewContent || flow.content;
        }

        processingReminder.update({
          message: update.flow_name?.trim()
            ? `正在流式读取「${update.flow_name}」输出…`
            : "正在流式读取工作流输出…",
          persist: true,
          busy: true,
          level: "info",
          island: getRotatedIsland(),
          workflow_name: update.flow_name?.trim() || undefined,
          flow_progress:
            totalFlowCount > 0
              ? { completed: completedFlowCount, total: totalFlowCount }
              : undefined,
        });
        break;
      }
      case "completed":
      case "failed":
      default:
        break;
    }
  };

  const finalizeUserAbort = () => {
    clearReplyInstruction();
    reminderSettled = true;
    stopCarousel();
    processingReminder.update({
      title: "Evolution World",
      message: "已终止本轮处理。",
      level: "warning",
      persist: false,
      busy: false,
      action: undefined,
      island: {
        entry_name: "",
        content: "",
        extra_count: 0,
      },
      collapse_after_ms: 0,
      duration_ms: 3500,
    });
    return {
      shouldAbortGeneration: true,
      workflowSucceeded: false,
      abortedByUser: true,
    } satisfies WorkflowExecutionOutcome;
  };

  const runWorkflowAttempt = async () => {
    const nextResult = await runWorkflow({
      message_id: options.messageId,
      user_input: options.userInput,
      trigger: options.trigger,
      mode: options.jobType === "live_auto" ? "auto" : "manual",
      inject_reply: options.injectReply,
      flow_ids: currentFlowIds,
      timing_filter: options.timingFilter,
      preserved_results: currentPreservedDispatchResults,
      job_type: options.jobType,
      context_cursor: options.contextCursor,
      writeback_policy: options.writebackPolicy,
      rederive_options: options.rederiveOptions,
      abortSignal: workflowAbortController.signal,
      isCancelled: () => abortedByUser,
      onProgress: handleWorkflowProgress,
    });

    currentPreservedDispatchResults = mergePreservedDispatchResults(
      currentPreservedDispatchResults,
      collectSuccessfulDispatchResultsFromAttempts(nextResult.attempts),
    );

    if (options.trigger.timing === "after_reply") {
      const assistantMessageId =
        options.trigger.assistant_message_id ?? options.messageId;
      const assistantMessage = getChatMessages(assistantMessageId)[0];
      const executionState = buildFloorWorkflowExecutionState(
        nextResult.request_id,
        nextResult.attempts,
        !nextResult.ok,
        currentPreservedStoredResults,
        assistantMessage ? getMessageVersionInfo(assistantMessage) : undefined,
      );
      await writeFloorWorkflowExecution(assistantMessageId, executionState);
      lastAfterReplyExecutionState = executionState;
      currentPreservedStoredResults = executionState.successful_results;
      currentPreservedDispatchResults = await buildPreservedDispatchResults(
        settings,
        currentPreservedStoredResults,
      );
    }

    return nextResult;
  };

  const waitForAutoRerollInterval = async (delayMs: number) => {
    const remainingDelayMs = Math.max(0, delayMs);
    if (remainingDelayMs <= 0) {
      return;
    }

    const deadline = Date.now() + remainingDelayMs;
    while (Date.now() < deadline) {
      if (abortedByUser || workflowAbortController.signal.aborted) {
        throw new Error("workflow cancelled by user");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(200, deadline - Date.now())),
      );
    }
  };

  let result;
  try {
    result = await runWorkflowAttempt();
  } catch (error) {
    if (abortedByUser) {
      return finalizeUserAbort();
    }
    processingReminder.dismiss();
    throw error;
  }

  if (abortedByUser) {
    return finalizeUserAbort();
  }

  if (!result.ok) {
    const policy = settings.failure_policy ?? "stop_generation";
    const autoRerollMaxAttempts = Math.max(
      1,
      Math.trunc(Number(settings.auto_reroll_max_attempts ?? 1) || 1),
    );
    const autoRerollIntervalMs = Math.max(
      0,
      Math.round((settings.auto_reroll_interval_seconds ?? 0) * 1000),
    );
    let autoRerollCount = 0;
    let autoRerollSkippedReason = "";

    if (policy === "retry_once") {
      while (!result.ok && autoRerollCount < autoRerollMaxAttempts) {
        const rerollTarget = resolveAutoRerollTarget(result);
        if (!rerollTarget.ok) {
          autoRerollSkippedReason = rerollTarget.reason;
          console.warn(`[EW] auto reroll skipped: ${rerollTarget.reason}`);
          break;
        }

        currentFlowIds = rerollTarget.flowIds;
        const nextAttemptNumber = autoRerollCount + 1;
        const retryReason = formatReasonForDisplay(result.reason, 120);
        processingReminder.update(
          buildAbortableReminder(
            autoRerollIntervalMs > 0
              ? `首轮未通过，${settings.auto_reroll_interval_seconds} 秒后开始第 ${nextAttemptNumber}/${autoRerollMaxAttempts} 次自动重roll… ${retryReason}`
              : `首轮未通过，准备开始第 ${nextAttemptNumber}/${autoRerollMaxAttempts} 次自动重roll… ${retryReason}`,
            "info",
          ),
        );
        toastr.info(
          `首轮未通过，准备进行第 ${nextAttemptNumber}/${autoRerollMaxAttempts} 次自动重roll：${retryReason}`,
          "Evolution World",
        );

        try {
          await waitForAutoRerollInterval(autoRerollIntervalMs);
          result = await runWorkflowAttempt();
          autoRerollCount = nextAttemptNumber;
        } catch (error) {
          if (abortedByUser) {
            return finalizeUserAbort();
          }
          processingReminder.dismiss();
          throw error;
        }

        if (abortedByUser) {
          return finalizeUserAbort();
        }
      }
    }

    if (!result.ok) {
      const displayReason = `${formatReasonForDisplay(result.reason)}${
        policy === "retry_once" && autoRerollSkippedReason
          ? `\n${autoRerollSkippedReason}`
          : policy === "retry_once" && autoRerollCount > 0
            ? `\n已自动重roll ${autoRerollCount} 次，仍未成功。`
            : ""
      }`;
      switch (policy) {
        case "continue_generation":
          reminderSettled = true;
          stopCarousel();
          processingReminder.update({
            title: "Evolution World",
            message: `工作流失败：${displayReason}。原消息是否继续发送取决于放行策略。`,
            level: "warning",
            persist: false,
            busy: false,
            action: undefined,
            collapse_after_ms: 0,
            duration_ms: 5500,
          });
          toastr.warning(
            `工作流失败，原消息是否继续发送取决于放行策略: ${displayReason}`,
            "Evolution World",
          );
          break;
        case "allow_partial_success":
        case "notify_only":
          reminderSettled = true;
          stopCarousel();
          processingReminder.update({
            title: "Evolution World",
            message: `工作流失败：${displayReason}`,
            level: "warning",
            persist: false,
            busy: false,
            action: undefined,
            collapse_after_ms: 0,
            duration_ms: 5500,
          });
          toastr.info(`工作流失败: ${displayReason}`, "Evolution World");
          break;
        case "stop_generation":
        case "retry_once":
        default:
          syncAfterReplyFailureQueue(
            options,
            lastAfterReplyExecutionState,
            false,
          );
          clearReplyInstruction();
          reminderSettled = true;
          stopCarousel();
          processingReminder.update({
            title: "Evolution World",
            message: `动态世界流程失败，本轮已中止：${displayReason}`,
            level: "error",
            persist: false,
            busy: false,
            action: undefined,
            collapse_after_ms: 0,
            duration_ms: 5500,
          });
          stopGenerationNow();
          toastr.error(
            `动态世界流程失败，本轮已中止: ${displayReason}`,
            "Evolution World",
          );
          return {
            shouldAbortGeneration: true,
            workflowSucceeded: false,
            abortedByUser: false,
          };
      }

      syncAfterReplyFailureQueue(options, lastAfterReplyExecutionState, false);

      return {
        shouldAbortGeneration: false,
        workflowSucceeded: false,
        abortedByUser: false,
      };
    }
  }

  if (options.trigger.timing === "before_reply") {
    const sourceMessageId = Number(
      options.trigger.user_message_id ?? options.messageId,
    );
    const userMessageId = Number(
      options.trigger.user_message_id ?? options.messageId,
    );
    if (
      Number.isFinite(sourceMessageId) &&
      sourceMessageId >= 0 &&
      Number.isFinite(userMessageId) &&
      userMessageId >= 0
    ) {
      setBeforeReplyBindingPending({
        request_id: result.request_id,
        user_message_id: userMessageId,
        source_message_id: sourceMessageId,
        generation_type: options.trigger.generation_type,
        window_ms: resolveAfterReplyContextWindowMs(settings),
      });
    } else {
      clearBeforeReplyBindingPending();
    }
  }

  if (options.trigger.timing === "after_reply") {
    const assistantMessageId =
      options.trigger.assistant_message_id ?? options.messageId;
    try {
      await pinMessageSnapshotToCurrentVersion(assistantMessageId);
      await pinFloorWorkflowExecutionToCurrentVersion(
        assistantMessageId,
        lastAfterReplyExecutionState,
      );
    } catch (error) {
      console.warn(
        "[Evolution World] Failed to pin after_reply artifacts to current visible version:",
        error,
      );
    }
  }

  {
    const capsuleMessageId =
      options.trigger.timing === "after_reply"
        ? Number(options.trigger.assistant_message_id ?? options.messageId)
        : Number(options.messageId);
    const capsuleMessage = getChatMessages(capsuleMessageId)[0];
    if (capsuleMessage) {
      const versionInfo = getMessageVersionInfo(capsuleMessage);
      const flowIds = dedupeStrings(
        result.attempts.map((attempt) => String(attempt.flow.id ?? "").trim()),
      );
      const capsuleMode: WorkflowCapsuleMode =
        options.rederiveOptions?.capsule_mode === "full"
          ? "full"
          : options.jobType === "historical_rederive"
            ? "full"
            : "light";
      const replayCapsule: WorkflowReplayCapsule = {
        at: Date.now(),
        request_id: result.request_id,
        job_type: options.jobType ?? "live_auto",
        timing: options.trigger.timing,
        source: options.trigger.source,
        generation_type: options.trigger.generation_type,
        target_message_id: capsuleMessageId,
        target_version_key: versionInfo.version_key,
        target_role:
          capsuleMessage.role === "assistant"
            ? "assistant"
            : capsuleMessage.role === "user"
              ? "user"
              : "other",
        flow_ids: flowIds,
        flow_ids_hash: simpleHash(flowIds.join("|")),
        capsule_mode: capsuleMode,
        legacy_approx: Boolean(options.rederiveOptions?.legacy_approx),
      };
      if (capsuleMode === "full") {
        replayCapsule.assembled_messages = result.attempts.flatMap((attempt) => {
          const assembled = attempt.request_debug?.assembled_messages;
          if (!Array.isArray(assembled)) {
            return [];
          }
          return assembled
            .filter(
              (item) =>
                item && typeof item === "object" && !Array.isArray(item),
            )
            .map((item) => ({
              role: String((item as Record<string, unknown>).role ?? ""),
              content: String((item as Record<string, unknown>).content ?? ""),
              name:
                typeof (item as Record<string, unknown>).name === "string"
                  ? String((item as Record<string, unknown>).name)
                  : undefined,
            }));
        });
        replayCapsule.request_preview = result.attempts
          .map((attempt) => ({
            flow_id: attempt.flow.id,
            request_id: attempt.request?.request_id ?? "",
            flow_name: attempt.flow.name,
            flow_order: attempt.flow_order,
          }))
          .slice(0, 20);
      }
      await writeWorkflowReplayCapsule(
        capsuleMessageId,
        replayCapsule,
        versionInfo,
      );
    }
  }

  syncAfterReplyFailureQueue(options, lastAfterReplyExecutionState, true);
  reminderSettled = true;
  stopCarousel();
  processingReminder.update({
    title: "Evolution World",
    message: options.successMessage,
    level: "success",
    persist: false,
    busy: false,
    action: undefined,
    collapse_after_ms: 0,
    duration_ms: 4000,
  });
  return {
    shouldAbortGeneration: false,
    workflowSucceeded: true,
    abortedByUser: false,
  };
}

type GenerationInterceptorAbort = (immediately: boolean) => void;

async function runPrimaryBeforeReplyIntercept(
  _chat: any[],
  _contextSize: number,
  abort: GenerationInterceptorAbort,
  generationType: string,
): Promise<void> {
  const settings = getSettings();
  if (!settings.enabled || !hasFlowsForTiming(settings, "before_reply")) {
    return;
  }

  const allowedTypes = new Set(["normal", "continue", "regenerate", "swipe"]);
  if (
    !allowedTypes.has(generationType) ||
    isQuietLike(generationType, undefined)
  ) {
    return;
  }

  const textareaValue = getSendTextareaValue();
  if (!textareaValue.trim()) {
    const decision = shouldHandleGenerationAfter(
      generationType,
      undefined,
      false,
      settings,
    );
    if (!decision.ok) {
      return;
    }
  }

  const userInput = resolvePrimaryWorkflowUserInput(generationType);
  const isNonSendType = NON_SEND_GENERATION_TYPES.has(generationType);
  if (!userInput.trim() && !isNonSendType) {
    return;
  }

  const messageId =
    getRuntimeState().last_send?.message_id ?? getLastMessageId();
  const pendingUserMessageId = getRuntimeState().last_send?.message_id ?? null;
  const identityKey = buildBeforeReplyIdentityKey(
    messageId,
    generationType,
    userInput,
  );
  if (queuedBeforeReplyJobKeys.has(identityKey)) {
    console.debug(
      `[Evolution World] before_reply skipped in generate interceptor: duplicate in-flight (${identityKey})`,
    );
    return;
  }
  const lastTriggerAt =
    lastBeforeReplyTriggerByIdentityKey.get(identityKey) ?? 0;
  if (Date.now() - lastTriggerAt < MIN_BEFORE_REPLY_INTERVAL_MS) {
    console.debug(
      `[Evolution World] before_reply skipped in generate interceptor: identity-windowed dedup (${Date.now() - lastTriggerAt}ms, key=${identityKey})`,
    );
    return;
  }

  markIntercepted(userInput, {
    messageId,
    generationType,
  });
  queuedBeforeReplyJobKeys.add(identityKey);
  lastBeforeReplyTriggerByIdentityKey.set(identityKey, Date.now());
  setBeforeReplySource("primary");

  let workflowOutcome: WorkflowExecutionOutcome = {
    shouldAbortGeneration: false,
    workflowSucceeded: false,
    abortedByUser: false,
  };

  try {
    workflowOutcome = await enqueueWorkflowJob(
      "live_auto",
      `before_reply:generate_interceptor:${messageId}`,
      async () => {
        setProcessing(true);
        try {
          return await executeWorkflowWithPolicy(settings, {
            messageId,
            userInput,
            injectReply: true,
            timingFilter: "before_reply",
            jobType: "live_auto",
            trigger: {
              timing: "before_reply",
              source: "generate_interceptor",
              generation_type: generationType,
              user_message_id: getRuntimeState().last_send?.message_id,
            },
            reminderMessage: "正在读取上下文并处理本轮工作流，请稍后…",
            successMessage: "动态世界流程处理完成，已更新本轮上下文。",
          });
        } finally {
          clearSendContextIfMatches(pendingUserMessageId, userInput);
          setProcessing(false);
        }
      },
    );
  } catch (error) {
    console.error("[Evolution World] Error in generate interceptor:", error);
    clearReplyInstruction();
  } finally {
    queuedBeforeReplyJobKeys.delete(identityKey);
  }

  if (workflowOutcome.shouldAbortGeneration) {
    await rollbackInterceptedUserMessage(
      pendingUserMessageId,
      userInput,
      generationType,
    );
    setSendTextareaValue(userInput);
    clearReplyInstruction();
    abort(true);
    return;
  }

  if (!shouldReleaseInterceptedMessage(settings, workflowOutcome)) {
    await rollbackInterceptedUserMessage(
      pendingUserMessageId,
      userInput,
      generationType,
    );
    setSendTextareaValue(userInput);
    clearReplyInstruction();
    console.debug(
      "[Evolution World] Original intercepted message was not released due to intercept_release_policy",
    );
    abort(true);
    return;
  }

  setSendTextareaValue(userInput);
  recordUserSendIntent(userInput);
}

function installPrimaryGenerateInterceptor(): void {
  (globalThis as Record<string, unknown>)[EW_GENERATE_INTERCEPTOR_KEY] =
    runPrimaryBeforeReplyIntercept;
}

function uninstallPrimaryGenerateInterceptor(): void {
  delete (globalThis as Record<string, unknown>)[EW_GENERATE_INTERCEPTOR_KEY];
}

// ---------------------------------------------------------------------------
// Fallback path: GENERATION_AFTER_COMMANDS event
// ---------------------------------------------------------------------------

async function onBeforeCombinePrompts(
  _promptData?: Record<string, any>,
): Promise<void> {
  if (consumeDryRunPromptPreview()) {
    console.debug(
      "[Evolution World] GENERATE_BEFORE_COMBINE_PROMPTS skipped: dry-run prompt preview bridge active",
    );
    return;
  }

  if (isMvuExtraAnalysisGuardActive()) {
    console.debug(
      "[Evolution World] GENERATE_BEFORE_COMBINE_PROMPTS observed during MVU extra analysis",
    );
  }

  if (shouldSkipTavernHelperPromptViewerSyntheticGeneration()) {
    clearSendIntent();
    console.debug(
      "[Evolution World] GENERATE_BEFORE_COMBINE_PROMPTS skipped: Tavern Helper prompt viewer synthetic generation",
    );
    return;
  }
}

async function onGenerationAfterCommands(
  type: string,
  params: {
    automatic_trigger?: boolean;
    quiet_prompt?: string;
    _ew_processed?: boolean;
    [key: string]: any;
  },
  dryRun: boolean,
) {
  if (dryRun) {
    return;
  }

  const generationType = String(type || "normal").trim() || "normal";

  if (consumeDryRunPromptPreview()) {
    console.debug(
      "[Evolution World] GENERATION_AFTER_COMMANDS skipped: dry-run prompt preview bridge active",
    );
    return;
  }

  if (isMvuExtraAnalysisGuardActive()) {
    console.debug(
      "[Evolution World] GENERATION_AFTER_COMMANDS skipped: MVU extra analysis guard active",
    );
    return;
  }

  if (
    generationType === "normal" &&
    shouldSkipTavernHelperPromptViewerSyntheticGeneration()
  ) {
    clearSendIntent();
    console.debug(
      "[Evolution World] GENERATION_AFTER_COMMANDS skipped: Tavern Helper prompt viewer synthetic generation",
    );
    return;
  }

  // Dedup check 1: already handled by TavernHelper hook
  if (params?._ew_processed) {
    console.debug(
      "[Evolution World] GENERATION_AFTER_COMMANDS skipped: already processed by TavernHelper hook",
    );
    return;
  }

  const settings = getSettings();
  if (!hasFlowsForTiming(settings, "before_reply")) {
    return;
  }
  const decision = shouldHandleGenerationAfter(type, params, dryRun, settings);
  if (!decision.ok) {
    return;
  }

  const messageId =
    getRuntimeState().last_send?.message_id ?? getLastMessageId();
  const genType = getRuntimeState().last_generation?.type ?? "";
  const effectiveGenerationType = genType || type;
  const userInput = resolveFallbackWorkflowUserInput(effectiveGenerationType);
  const identityKey = buildBeforeReplyIdentityKey(
    messageId,
    effectiveGenerationType,
    userInput,
  );
  const isNonSendType = NON_SEND_GENERATION_TYPES.has(effectiveGenerationType);

  // Only block on empty input for normal send — continue/regen/swipe can proceed without it
  if (!userInput.trim() && !isNonSendType) {
    console.debug("[Evolution World] skipped workflow: user input is empty");
    return;
  }

  // Dedup check 2: hash-based guard against recent TavernHelper interception
  if (queuedBeforeReplyJobKeys.has(identityKey)) {
    console.debug(
      "[Evolution World] GENERATION_AFTER_COMMANDS skipped: duplicate before_reply job already in-flight",
    );
    return;
  }

  const lastTriggerAt =
    lastBeforeReplyTriggerByIdentityKey.get(identityKey) ?? 0;
  if (Date.now() - lastTriggerAt < MIN_BEFORE_REPLY_INTERVAL_MS) {
    console.debug(
      `[Evolution World] GENERATION_AFTER_COMMANDS skipped: identity-windowed before_reply dedup (${Date.now() - lastTriggerAt}ms, key=${identityKey})`,
    );
    return;
  }

  if (
    wasRecentlyIntercepted(userInput, {
      messageId,
      generationType: effectiveGenerationType,
    })
  ) {
    console.debug(
      "[Evolution World] GENERATION_AFTER_COMMANDS skipped: this generation was already handled by the primary path",
    );
    return;
  }

  markIntercepted(userInput, {
    messageId,
    generationType: effectiveGenerationType,
  });
  queuedBeforeReplyJobKeys.add(identityKey);
  lastBeforeReplyTriggerByIdentityKey.set(identityKey, Date.now());
  setBeforeReplySource("fallback");

  console.debug(
    "[Evolution World] GENERATION_AFTER_COMMANDS executing workflow (fallback path)",
  );
  try {
    await enqueueWorkflowJob(
      "live_auto",
      `before_reply:fallback:${messageId}`,
      async () => {
        setProcessing(true);
        try {
          await executeWorkflowWithPolicy(settings, {
            messageId,
            userInput,
            injectReply: true,
            timingFilter: "before_reply",
            jobType: "live_auto",
            trigger: {
              timing: "before_reply",
              source: "generation_after_commands",
              generation_type: effectiveGenerationType,
              user_message_id: getRuntimeState().last_send?.message_id,
            },
            reminderMessage: "正在读取上下文并处理本轮工作流，请稍后…",
            successMessage: "动态世界流程处理完成，已更新本轮上下文。",
          });
        } finally {
          clearSendContextIfMatches(messageId, userInput);
          setProcessing(false);
        }
      },
    );
  } finally {
    queuedBeforeReplyJobKeys.delete(identityKey);
  }
}

function getMessageText(messageId: number): string {
  try {
    const message = getChatMessages(messageId)[0];
    return String(message?.message ?? "");
  } catch {
    return "";
  }
}

function isAssistantMessage(messageId: number): boolean {
  try {
    const message = getChatMessages(messageId)[0];
    return message?.role === "assistant";
  } catch {
    return false;
  }
}

function clearPendingAfterReplyMessageReceivedFallback(messageId: number): void {
  const handle = pendingAfterReplyMessageReceivedFallbacks.get(messageId);
  if (!handle) {
    return;
  }

  clearTimeout(handle);
  pendingAfterReplyMessageReceivedFallbacks.delete(messageId);
}

function markGenerationEndedObserved(): void {
  const generationSeq = Math.max(
    0,
    Math.trunc(Number(getRuntimeState().last_generation?.seq ?? 0) || 0),
  );
  if (generationSeq > lastObservedGenerationEndedSeq) {
    lastObservedGenerationEndedSeq = generationSeq;
  }
}

function hasObservedGenerationEndForSeq(expectedGenerationSeq: number): boolean {
  if (!Number.isFinite(expectedGenerationSeq) || expectedGenerationSeq <= 0) {
    return false;
  }
  return lastObservedGenerationEndedSeq >= expectedGenerationSeq;
}

function scheduleAfterReplyFromMessageReceived(
  messageId: number,
  type: string,
): void {
  if (!isAssistantMessage(messageId)) {
    return;
  }

  clearPendingAfterReplyMessageReceivedFallback(messageId);

  const expectedGenerationSeq = Math.max(
    0,
    Math.trunc(
      Number(
        getRuntimeState().after_reply.pending_generation_seq ||
          getRuntimeState().last_generation?.seq ||
          0,
      ) || 0,
    ),
  );
  const startedAt = Date.now();

  const poll = () => {
    if (!pendingAfterReplyMessageReceivedFallbacks.has(messageId)) {
      return;
    }

    const generationEnded = hasObservedGenerationEndForSeq(expectedGenerationSeq);
    const timedOut =
      Date.now() - startedAt >= AFTER_REPLY_MESSAGE_RECEIVED_FALLBACK_TIMEOUT_MS;

    if (generationEnded || timedOut) {
      pendingAfterReplyMessageReceivedFallbacks.delete(messageId);
      if (timedOut) {
        console.debug(
          `[Evolution World] after_reply fallback waited ${AFTER_REPLY_MESSAGE_RECEIVED_FALLBACK_TIMEOUT_MS}ms without GENERATION_ENDED, using delayed message_received path for assistant floor #${messageId}`,
        );
      }
      void onAfterReplyMessage(
        messageId,
        type,
        generationEnded ? "message_received_fallback" : "message_received_timeout",
      );
      return;
    }

    const nextHandle = scheduleManagedRuntimeTimeout(
      poll,
      AFTER_REPLY_MESSAGE_RECEIVED_FALLBACK_POLL_MS,
    );
    pendingAfterReplyMessageReceivedFallbacks.set(messageId, nextHandle);
  };

  const initialHandle = scheduleManagedRuntimeTimeout(
    poll,
    AFTER_REPLY_MESSAGE_RECEIVED_FALLBACK_POLL_MS,
  );
  pendingAfterReplyMessageReceivedFallbacks.set(messageId, initialHandle);
}

async function onAfterReplyMessage(
  messageId: number,
  type: string,
  source:
    | "message_received"
    | "message_received_fallback"
    | "message_received_timeout"
    | "generation_ended",
) {
  const settings = getSettings();
  const pendingBeforeReplyBinding = pruneExpiredBeforeReplyBindingPending();

  if (!isAssistantMessage(messageId)) {
    return;
  }

  const messageText = getMessageText(messageId);
  if (!messageText.trim() || wasAfterReplyHandled(messageId, messageText)) {
    return;
  }

  const runtimeState = getRuntimeState();
  const generationType =
    runtimeState.after_reply.pending_generation_type ||
    runtimeState.last_generation?.type ||
    type;
  const userInput = resolveAfterReplyUserInput();
  const pendingUserMessageId =
    runtimeState.after_reply.pending_user_message_id ??
    runtimeState.last_send?.message_id ??
    null;
  const shouldAttemptBeforeReplyBindingMigration = Boolean(
    pendingBeforeReplyBinding &&
      !pendingBeforeReplyBinding.migrated &&
      Number.isFinite(pendingUserMessageId) &&
      pendingBeforeReplyBinding.user_message_id === pendingUserMessageId,
  );
  const hasAfterReplyFlows = hasFlowsForTiming(settings, "after_reply");
  const decision = hasAfterReplyFlows
    ? shouldHandleAfterReply(messageId, type, settings)
    : { ok: false, reason: "after_reply_flows_disabled" };
  const shouldRunAfterReplyWorkflow =
    hasAfterReplyFlows &&
    decision.ok &&
    !wasAfterReplyHandled(messageId, messageText);
  if (!shouldRunAfterReplyWorkflow && !shouldAttemptBeforeReplyBindingMigration) {
    return;
  }

  let flowIds: string[] | undefined;
  if (shouldRunAfterReplyWorkflow) {
    flowIds = await resolveEligibleAfterReplyFlowIds(settings, messageId);
    if (flowIds.length === 0 && !shouldAttemptBeforeReplyBindingMigration) {
      markAfterReplyHandled(messageId, messageText);
      clearAfterReplyPending();
      clearSendContext();
      return;
    }
  }

  const chatKey = getCurrentChatKey();
  const generationSeq =
    runtimeState.after_reply.pending_generation_seq ||
    runtimeState.last_generation?.seq ||
    0;
  const queueKey = `${chatKey}:${messageId}`;
  const dedupKey = buildAfterReplyDedupKey(messageText, pendingUserMessageId);
  const identityKey = buildAfterReplyIdentityKey({
    chatKey,
    messageId,
    generationSeq,
    pendingUserMessageId,
    generationType: type,
  });

  if (
    queuedAfterReplyJobKeys.has(queueKey) ||
    queuedAfterReplyDedupKeys.has(dedupKey)
  ) {
    console.debug(
      `[Evolution World] after_reply skipped as duplicate (${source}): ${dedupKey}`,
    );
    return;
  }

  if (processedAfterReplyIdentityKeys.has(identityKey)) {
    console.debug(
      `[Evolution World] after_reply skipped: identity already processed (${source}, key=${identityKey})`,
    );
    return;
  }

  const lastTriggerAt =
    lastAfterReplyTriggerByIdentityKey.get(identityKey) ?? 0;
  if (Date.now() - lastTriggerAt < MIN_AFTER_REPLY_INTERVAL_MS) {
    console.debug(
      `[Evolution World] after_reply skipped: identity-windowed dedup (${source}, ${Date.now() - lastTriggerAt}ms since last, key=${identityKey})`,
    );
    return;
  }

  lastAfterReplyTriggerByIdentityKey.set(identityKey, Date.now());
  queuedAfterReplyJobKeys.add(queueKey);
  queuedAfterReplyDedupKeys.add(dedupKey);

  await enqueueWorkflowJob("live_auto", `after_reply:${messageId}`, async () => {
    setProcessing(true);
    try {
      if (shouldAttemptBeforeReplyBindingMigration) {
        const bindingMigration = await migrateBeforeReplyBindingToAssistant(
          settings,
          messageId,
          pendingUserMessageId,
        );
        if (bindingMigration.migrated) {
          console.info(
            `[Evolution World] before_reply binding migrated to assistant floor #${messageId} (snapshot=${bindingMigration.snapshot_migrated}, execution=${bindingMigration.execution_migrated})`,
          );
        }
      }

      if (!shouldRunAfterReplyWorkflow) {
        return;
      }

      if (!flowIds?.length) {
        markAfterReplyHandled(messageId, messageText);
        return;
      }

      await executeWorkflowWithPolicy(settings, {
        messageId,
        userInput,
        injectReply: false,
        flowIds,
        timingFilter: "after_reply",
        jobType: "live_auto",
        trigger: {
          timing: "after_reply",
          source,
          generation_type: generationType,
          user_message_id: pendingUserMessageId ?? undefined,
          assistant_message_id: messageId,
        },
        reminderMessage: "正在根据最新回复更新动态世界，请稍后…",
        successMessage: "动态世界已根据最新回复完成更新。",
      });
      markAfterReplyHandled(messageId, messageText);
    } finally {
      processedAfterReplyIdentityKeys.add(identityKey);
      clearAfterReplyPendingIfMatches(pendingUserMessageId);
      clearSendContextIfMatches(pendingUserMessageId, userInput);
      queuedAfterReplyJobKeys.delete(queueKey);
      queuedAfterReplyDedupKeys.delete(dedupKey);
      setProcessing(false);
    }
  });
}

async function rerollQueuedFailedAfterReplyWorkflows(
  settings: EwSettings,
): Promise<{ ok: boolean; reason?: string }> {
  const chatKey = getCurrentChatKey();
  const jobs = getFailedAfterReplyJobs(chatKey);
  if (jobs.length === 0) {
    return { ok: false, reason: "当前聊天没有失败队列可供重跑" };
  }

  try {
    return await enqueueWorkflowJob(
      "live_reroll",
      `reroll_failed_queue:${chatKey}`,
      async () => {
        setProcessing(true);
        try {
          let retriedCount = 0;
          let successCount = 0;
          let failedCount = 0;
          let skippedCount = 0;

          for (let index = 0; index < jobs.length; index += 1) {
            const job = jobs[index];
            const resolved = await resolveFailedOnlyRerollTarget(
              settings,
              job.message_id,
            );
            if (!resolved.ok) {
              removeFailedAfterReplyJob(chatKey, job.message_id);
              skippedCount += 1;
              continue;
            }

            retriedCount += 1;
            if (settings.floor_binding_enabled) {
              await rollbackBeforeFloor(settings, job.message_id);
            }

            const outcome = await executeWorkflowWithPolicy(settings, {
              messageId: job.message_id,
              userInput: job.user_input,
              injectReply: false,
              flowIds: resolved.flowIds,
              timingFilter: "after_reply",
              preservedResults: resolved.preservedResults,
              jobType: "live_reroll",
              trigger: {
                timing: "after_reply",
                source: "queued_failed_reroll",
                generation_type: job.generation_type,
                user_message_id: Number.isFinite(job.user_message_id)
                  ? Number(job.user_message_id)
                  : undefined,
                assistant_message_id: job.message_id,
              },
              reminderMessage: `正在重跑失败队列 ${index + 1}/${jobs.length}，请稍后…`,
              successMessage: `失败队列 ${index + 1}/${jobs.length} 已处理完成。`,
            });

            if (outcome.abortedByUser) {
              return {
                ok: false,
                reason: `已终止失败队列重跑，已完成 ${successCount}/${retriedCount} 条。`,
              };
            }

            if (outcome.workflowSucceeded) {
              const messageText = getMessageText(job.message_id);
              if (messageText.trim()) {
                markAfterReplyHandled(job.message_id, messageText);
              }
              successCount += 1;
            } else {
              failedCount += 1;
            }
          }

          if (retriedCount === 0) {
            return {
              ok: false,
              reason: "失败队列中的楼层记录已失效，已自动清理。",
            };
          }

          if (failedCount > 0) {
            return {
              ok: false,
              reason: `失败队列已重跑 ${retriedCount} 条，其中 ${successCount} 条成功，${failedCount} 条仍失败${skippedCount > 0 ? `，${skippedCount} 条已跳过` : ""}。`,
            };
          }

          return {
            ok: true,
            reason:
              skippedCount > 0
                ? `失败队列已重跑完成，共成功 ${successCount} 条，另有 ${skippedCount} 条失效记录已跳过。`
                : `失败队列已重跑完成，共成功 ${successCount} 条。`,
          };
        } finally {
          setProcessing(false);
        }
      },
    );
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

type RederiveWorkflowInput = {
  message_id: number;
  timing: "before_reply" | "after_reply" | "manual";
  target_version_key?: string;
  confirm_legacy?: boolean;
  capsule_mode?: WorkflowCapsuleMode;
};

type RederiveWorkflowResult = {
  ok: boolean;
  reason?: string;
  result?: {
    message_id: number;
    anchor_message_id: number;
    legacy_approx: boolean;
    writeback_applied: number;
    writeback_conflicts: number;
    writeback_conflict_names: string[];
  };
};

export async function rederiveWorkflowAtFloor(
  input: RederiveWorkflowInput,
): Promise<RederiveWorkflowResult> {
  const supportStatus = getWorkflowSupportStatus();
  if (!supportStatus.ok) {
    return { ok: false, reason: supportStatus.message };
  }

  const settings = getSettings();
  if (!settings.enabled) {
    return { ok: false, reason: "workflow disabled" };
  }
  if (getRuntimeState().is_processing) {
    return { ok: false, reason: "workflow already processing" };
  }

  const sourceMessageId = Number(input.message_id);
  if (!Number.isFinite(sourceMessageId) || sourceMessageId < 0) {
    return { ok: false, reason: "invalid target floor" };
  }

  const sourceMessage = getChatMessages(sourceMessageId)[0];
  if (!sourceMessage) {
    return { ok: false, reason: "target floor not found" };
  }

  const timing = input.timing;
  const pair =
    timing === "before_reply"
      ? resolveBeforeReplyPair(sourceMessageId)
      : { source_message_id: sourceMessageId };
  const assistantMessageId = pair.assistant_message_id;
  const beforeReplySourceMessageId = pair.source_message_id;
  const anchorMessageId =
    timing === "before_reply" && Number.isFinite(assistantMessageId)
      ? Number(assistantMessageId)
      : sourceMessageId;

  const anchorMessage = getChatMessages(anchorMessageId)[0];
  if (!anchorMessage) {
    return { ok: false, reason: "anchor floor not found" };
  }

  const hasAnchorCapsule =
    Object.keys(
      normalizeWorkflowReplayCapsuleMap(
        anchorMessage.data?.[EW_WORKFLOW_REPLAY_CAPSULE_KEY],
      ),
    ).length > 0;
  const hasSourceCapsule =
    Number.isFinite(beforeReplySourceMessageId) &&
    beforeReplySourceMessageId !== anchorMessageId
      ? Object.keys(
          normalizeWorkflowReplayCapsuleMap(
            getChatMessages(beforeReplySourceMessageId)[0]?.data?.[
              EW_WORKFLOW_REPLAY_CAPSULE_KEY
            ],
          ),
        ).length > 0
      : false;

  if (!hasAnchorCapsule && !hasSourceCapsule && !input.confirm_legacy) {
    return { ok: false, reason: "legacy_confirmation_required" };
  }
  const legacyApprox = !hasAnchorCapsule && !hasSourceCapsule;

  const targetVersionInfo = getMessageVersionInfo(anchorMessage);
  const contextCursor: ContextCursor = {
    chat_id: getCurrentChatKey(),
    target_message_id:
      timing === "before_reply" ? beforeReplySourceMessageId : anchorMessageId,
    target_role:
      timing === "before_reply"
        ? "user"
        : anchorMessage.role === "assistant"
          ? "assistant"
          : anchorMessage.role === "user"
            ? "user"
            : "other",
    target_version_key: String(
      input.target_version_key ?? targetVersionInfo.version_key,
    ),
    timing,
    source_user_message_id:
      timing === "before_reply" ? beforeReplySourceMessageId : undefined,
    assistant_message_id:
      timing === "before_reply" ? assistantMessageId : anchorMessageId,
    capsule_mode: input.capsule_mode === "light" ? "light" : "full",
  };

  const oldSnapshotRead = await readFloorSnapshotByMessageId(
    anchorMessageId,
    "history",
  );

  const sourceUserText = String(
    getChatMessages(beforeReplySourceMessageId)[0]?.message ?? "",
  );
  const afterReplySourceUserMessageId =
    timing === "after_reply"
      ? resolveAssistantSourceUserMessageId(anchorMessageId)
      : null;
  const afterReplySourceUserText = String(
    Number.isFinite(afterReplySourceUserMessageId)
      ? getChatMessages(Number(afterReplySourceUserMessageId))[0]?.message ?? ""
      : "",
  );
  const userInput =
    timing === "before_reply"
      ? sourceUserText
      : timing === "after_reply"
        ? afterReplySourceUserText || getMessageText(anchorMessageId)
        : sourceUserText || getMessageText(sourceMessageId);

  let flowIds: string[] | undefined;
  if (timing === "after_reply") {
    flowIds = await resolveEligibleAfterReplyFlowIds(settings, anchorMessageId);
    if (flowIds.length === 0) {
      return {
        ok: false,
        reason: "当前楼层没有命中任何应执行的 after_reply 工作流",
      };
    }
  }

  try {
    const outcome = await enqueueWorkflowJob(
      "historical_rederive",
      `rederive:${timing}:${sourceMessageId}`,
      async () => {
        setProcessing(true);
        try {
          return await executeWorkflowWithPolicy(settings, {
            messageId:
              timing === "before_reply"
                ? beforeReplySourceMessageId
                : anchorMessageId,
            userInput,
            injectReply: false,
            flowIds,
            timingFilter: timing === "manual" ? undefined : timing,
            jobType: "historical_rederive",
            contextCursor,
            writebackPolicy: "dual_diff_merge",
            rederiveOptions: {
              legacy_approx: legacyApprox,
              capsule_mode: contextCursor.capsule_mode,
            },
            trigger: {
              timing,
              source: "history_rederive",
              generation_type:
                getRuntimeState().last_generation?.type || "manual",
              ...(timing === "before_reply"
                ? {
                    user_message_id: beforeReplySourceMessageId,
                    assistant_message_id: assistantMessageId,
                  }
                : timing === "after_reply"
                  ? {
                      user_message_id: afterReplySourceUserMessageId ?? undefined,
                      assistant_message_id:
                        anchorMessage.role === "assistant"
                          ? anchorMessageId
                          : undefined,
                    }
                  : {}),
            },
            reminderMessage: "正在重推导历史楼层工作流并重建快照，请稍后…",
            successMessage: "历史楼层重推导与快照重建已完成。",
          });
        } finally {
          setProcessing(false);
        }
      },
    );

    if (!outcome.workflowSucceeded) {
      return {
        ok: false,
        reason: outcome.abortedByUser
          ? "workflow cancelled by user"
          : "workflow failed",
      };
    }

    if (
      timing === "before_reply" &&
      Number.isFinite(assistantMessageId) &&
      Number.isFinite(beforeReplySourceMessageId) &&
      beforeReplySourceMessageId !== assistantMessageId
    ) {
      await rebindFloorSnapshotToMessage(
        settings,
        beforeReplySourceMessageId,
        Number(assistantMessageId),
      );
      await migrateFloorWorkflowExecutionToAssistant(
        beforeReplySourceMessageId,
        Number(assistantMessageId),
      );
      await migrateFloorWorkflowCapsuleToAssistant(
        beforeReplySourceMessageId,
        Number(assistantMessageId),
      );
      await writeBeforeReplyBindingMeta(
        beforeReplySourceMessageId,
        Number(assistantMessageId),
        `rederive:${Date.now().toString(36)}`,
      );
    }

    const newSnapshotRead = await readFloorSnapshotByMessageId(
      anchorMessageId,
      "history",
    );
    const writebackResult = await applySnapshotDiffToCurrentWorldbook(
      settings,
      oldSnapshotRead,
      newSnapshotRead,
    );
    await writeRederiveMeta(anchorMessageId, {
      source_job: "historical_rederive",
      legacy_approx: legacyApprox,
      timing,
      conflicts: writebackResult.conflicts,
      conflict_names: writebackResult.conflict_names,
      writeback_applied: writebackResult.applied,
      writeback_ok: writebackResult.conflicts === 0,
    });

    return {
      ok: true,
      result: {
        message_id: sourceMessageId,
        anchor_message_id: anchorMessageId,
        legacy_approx: legacyApprox,
        writeback_applied: writebackResult.applied,
        writeback_conflicts: writebackResult.conflicts,
        writeback_conflict_names: writebackResult.conflict_names,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function rerollCurrentAfterReplyWorkflow(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const supportStatus = getWorkflowSupportStatus();
  if (!supportStatus.ok) {
    return { ok: false, reason: supportStatus.message };
  }

  const settings = getSettings();
  if (!hasFlowsForTiming(settings, "after_reply")) {
    return { ok: false, reason: "no flows configured for after_reply timing" };
  }
  if (!settings.enabled) {
    return { ok: false, reason: "workflow disabled" };
  }
  if (getRuntimeState().is_processing) {
    return { ok: false, reason: "workflow already processing" };
  }

  const messageId = getLastMessageId();
  if (!Number.isFinite(messageId) || messageId < 0) {
    return { ok: false, reason: "no current floor found" };
  }
  if (!isAssistantMessage(messageId)) {
    return { ok: false, reason: "current floor is not an assistant reply" };
  }

  const messageText = getMessageText(messageId);
  if (!messageText.trim()) {
    return { ok: false, reason: "current assistant reply is empty" };
  }

  const runtimeState = getRuntimeState();
  const generationType = runtimeState.last_generation?.type || "manual";
  const userInput = resolveAfterReplyUserInput();
  const rerollScope = settings.reroll_scope ?? "all";

  if (rerollScope === "queued_failed") {
    return rerollQueuedFailedAfterReplyWorkflows(settings);
  }

  let flowIds: string[] | undefined;
  let preservedResults: FloorWorkflowStoredResult[] = [];
  let failedOnlyFallbackToAll = false;

  if (rerollScope === "failed_only") {
    const resolved = await resolveFailedOnlyRerollTarget(settings, messageId);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }

    flowIds = resolved.flowIds;
    preservedResults = resolved.preservedResults;
    failedOnlyFallbackToAll = Boolean(resolved.fallbackToAll);
  } else {
    flowIds = await resolveEligibleAfterReplyFlowIds(settings, messageId);
    if (flowIds.length === 0) {
      return { ok: false, reason: "当前楼层没有命中任何应执行的 after_reply 工作流" };
    }
  }

  try {
    const outcome = await enqueueWorkflowJob(
      "live_reroll",
      `reroll_after_reply:${messageId}`,
      async () => {
        setProcessing(true);
        try {
          if (settings.floor_binding_enabled) {
            await rollbackBeforeFloor(settings, messageId);
          }

          return await executeWorkflowWithPolicy(settings, {
            messageId,
            userInput,
            injectReply: false,
            flowIds,
            timingFilter: "after_reply",
            preservedResults,
            jobType: "live_reroll",
            trigger: {
              timing: "after_reply",
              source: "fab_double_click",
              generation_type: generationType,
              user_message_id:
                runtimeState.after_reply.pending_user_message_id ??
                runtimeState.last_send?.message_id,
              assistant_message_id: messageId,
            },
            reminderMessage:
              rerollScope === "failed_only" && flowIds?.length
                ? failedOnlyFallbackToAll
                  ? `当前楼上次失败发生在合并或写回阶段，正在回退重跑该楼关联的 ${flowIds.length} 条工作流，请稍后…`
                  : `正在重跑当前楼失败的 ${flowIds.length} 条工作流，请稍后…`
                : `正在重跑当前楼命中的 ${flowIds?.length ?? 0} 条回复后工作流，请稍后…`,
            successMessage:
              rerollScope === "failed_only" && flowIds?.length
                ? failedOnlyFallbackToAll
                  ? "当前楼因整轮失败而回退重跑的工作流已完成。"
                  : "当前楼失败的工作流已重跑完成。"
                : `当前楼命中的 ${flowIds?.length ?? 0} 条回复后工作流已重跑完成。`,
          });
        } finally {
          setProcessing(false);
        }
      },
    );

    if (outcome.workflowSucceeded) {
      markAfterReplyHandled(messageId, messageText);
      return { ok: true };
    }

    if (outcome.abortedByUser) {
      return { ok: false, reason: "workflow cancelled by user" };
    }

    return { ok: false, reason: "workflow failed" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function initRuntimeEvents() {
  if (runtimeEventsInitialized) {
    return;
  }

  const eventTypes = getEventTypes();

  try {
    installPrimaryGenerateInterceptor();
    installSendIntentHooks();

    listenerStops.push(
      onSTEvent(eventTypes.MESSAGE_SENT, (messageId: number) => {
        const msg = getChatMessages(messageId)[0];
        if (!msg || msg.role !== "user") {
          return;
        }
        recordUserSend(messageId, msg.message ?? "");
      }),
    );

    listenerStops.push(
      onSTEvent(
        eventTypes.GENERATION_STARTED,
        (type: string, params: Record<string, any>, dryRun: boolean) => {
          if (dryRun) {
            markDryRunPromptPreview();
            return;
          }

          const generationType = String(type || "normal").trim() || "normal";
          if (
            generationType === "normal" &&
            shouldSkipTavernHelperPromptViewerSyntheticGeneration()
          ) {
            clearSendIntent();
            console.debug(
              "[Evolution World] GENERATION_STARTED skipped: Tavern Helper prompt viewer synthetic generation",
            );
            return;
          }

          clearDryRunPromptPreview();
          recordGeneration(type, params ?? {}, false);
        },
      ),
    );

    listenerStops.push(
      onSTEvent(
        eventTypes.MESSAGE_RECEIVED,
        async (messageId: number, type: string) => {
          scheduleAfterReplyFromMessageReceived(messageId, type);
        },
      ),
    );

    listenerStops.push(
      onSTEvent(eventTypes.GENERATION_ENDED, async (messageId: number) => {
        markGenerationEndedObserved();
        clearPendingAfterReplyMessageReceivedFallback(messageId);
        const type = getRuntimeState().last_generation?.type ?? "normal";
        await onAfterReplyMessage(messageId, type, "generation_ended");
      }),
    );

    // Primary path: GENERATION_AFTER_COMMANDS (ST 扩展中不再需要 TavernHelper hook)
    listenerStops.push(
      registerBeforeCombinePrompts(async (promptData) => {
        await onBeforeCombinePrompts(promptData);
      }),
    );

    listenerStops.push(
      registerGenerationAfterCommands(async (type, params, dryRun) => {
        await onGenerationAfterCommands(type, params ?? {}, dryRun);
      }),
    );

    listenerStops.push(
      onSTEvent(eventTypes.CHAT_CHANGED, () => {
        clearQueuedWorkflowTasks("workflow queue cleared because chat changed");
        resetRuntimeState();
        resetInterceptGuard();
        resetBeforeReplySource();
        scheduleManagedRuntimeTimeout(() => {
          installSendIntentHooks();
        }, 300);
        scheduleManagedRuntimeTimeout(() => {
          if (getSettings().enabled) {
            void (async () => {
              try {
                await compactCurrentChatArtifacts(getSettings());
              } catch (error) {
                console.warn(
                  "[Evolution World] artifact compaction during chat change failed:",
                  error,
                );
              }
              try {
                await repairCurrentChatSuspiciousEmptySnapshots();
              } catch (error) {
                console.warn(
                  "[Evolution World] suspicious empty snapshot repair during chat change failed:",
                  error,
                );
              }
            })();
          }
        }, 900);
      }),
    );

    // Initialize floor binding event listeners for automatic cleanup.
    initFloorBindingEvents(getSettings);
    scheduleManagedRuntimeTimeout(() => {
      if (getSettings().enabled) {
        void (async () => {
          try {
            await compactCurrentChatArtifacts(getSettings());
          } catch (error) {
            console.warn(
              "[Evolution World] artifact compaction during init failed:",
              error,
            );
          }
          try {
            await repairCurrentChatSuspiciousEmptySnapshots();
          } catch (error) {
            console.warn(
              "[Evolution World] suspicious empty snapshot repair during init failed:",
              error,
            );
          }
        })();
      }
    }, 900);
    runtimeEventsInitialized = true;
  } catch (error) {
    disposeRuntimeEvents();
    throw error;
  }
}

export function disposeRuntimeEvents() {
  for (const stop of listenerStops.splice(0, listenerStops.length)) {
    stop();
  }
  for (const cleanup of domCleanup.splice(0, domCleanup.length)) {
    cleanup();
  }
  if (sendIntentRetryTimer) {
    clearTimeout(sendIntentRetryTimer);
    sendIntentRetryTimer = null;
  }
  clearManagedRuntimeTimeouts();
  setSendIntentHookStatus("degraded");
  resetBeforeReplySource();
  uninstallPrimaryGenerateInterceptor();
  clearQueuedWorkflowTasks("workflow queue cleared because runtime events were disposed");
  resetInterceptGuard();
  disposeFloorBindingEvents();
  runtimeEventsInitialized = false;
}
