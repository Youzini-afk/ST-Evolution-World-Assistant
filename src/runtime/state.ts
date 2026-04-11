import { now, simpleHash } from './helpers';
import { EwSettings } from './types';

const DRY_RUN_PROMPT_PREVIEW_BRIDGE_MS = 1200;
const MVU_EXTRA_ANALYSIS_GUARD_TTL_MS = 2500;

type SendRecord = {
  message_id: number;
  user_input: string;
  hash: string;
  at: number;
};

type SendIntentRecord = {
  user_input: string;
  hash: string;
  at: number;
};

type GenerationRecord = {
  seq: number;
  type: string;
  params: {
    automatic_trigger?: boolean;
    quiet_prompt?: string;
    [key: string]: any;
  };
  dry_run: boolean;
  at: number;
};

type AfterReplyRecord = {
  pending_user_message_id: number | null;
  pending_user_input: string;
  pending_generation_type: string;
  pending_generation_seq: number;
  pending_at: number;
  last_handled_assistant_message_id: number | null;
  last_handled_hash: string;
  last_handled_at: number;
};

export type BeforeReplyBindingPending = {
  request_id: string;
  user_message_id: number;
  source_message_id: number;
  generation_type: string;
  created_at: number;
  expires_at: number;
  migrated: boolean;
  migrated_assistant_message_id?: number;
  migrated_at?: number;
};

export type RuntimeState = {
  last_send: SendRecord | null;
  last_send_intent: SendIntentRecord | null;
  last_generation: GenerationRecord | null;
  after_reply: AfterReplyRecord;
  before_reply_binding_pending: BeforeReplyBindingPending | null;
  is_processing: boolean;
};

const state: RuntimeState = {
  last_send: null,
  last_send_intent: null,
  last_generation: null,
  after_reply: {
    pending_user_message_id: null,
    pending_user_input: '',
    pending_generation_type: '',
    pending_generation_seq: 0,
    pending_at: 0,
    last_handled_assistant_message_id: null,
    last_handled_hash: '',
    last_handled_at: 0,
  },
  before_reply_binding_pending: null,
  is_processing: false,
};

let generationSeq = 0;
let dryRunPromptPreviewUntil = 0;
let mvuExtraAnalysisGuardUntil = 0;

export function getRuntimeState(): RuntimeState {
  return state;
}

export function recordUserSend(message_id: number, user_input: string) {
  state.last_send = {
    message_id,
    user_input,
    hash: simpleHash(user_input),
    at: now(),
  };
  state.after_reply.pending_user_message_id = message_id;
  state.after_reply.pending_user_input = user_input;
  state.after_reply.pending_at = now();
  state.before_reply_binding_pending = null;
}

export function recordUserSendIntent(user_input: string) {
  state.last_send_intent = {
    user_input,
    hash: simpleHash(user_input),
    at: now(),
  };
}

export function recordGeneration(type: string, params: Record<string, any> | undefined, dry_run: boolean) {
  generationSeq += 1;
  state.last_generation = {
    seq: generationSeq,
    type,
    params: (params ?? {}) as GenerationRecord['params'],
    dry_run,
    at: now(),
  };

  state.after_reply.pending_generation_type = type;
  state.after_reply.pending_generation_seq = state.last_generation.seq;
  if (!state.after_reply.pending_at) {
    state.after_reply.pending_at = now();
  }
}

export function markDryRunPromptPreview(
  ttl_ms = DRY_RUN_PROMPT_PREVIEW_BRIDGE_MS,
): number {
  const resolvedTtlMs = Math.max(
    100,
    Math.floor(Number(ttl_ms) || DRY_RUN_PROMPT_PREVIEW_BRIDGE_MS),
  );
  dryRunPromptPreviewUntil = now() + resolvedTtlMs;
  return dryRunPromptPreviewUntil;
}

export function clearDryRunPromptPreview(currentAt = now()): boolean {
  const hadPendingSkip = dryRunPromptPreviewUntil > currentAt;
  dryRunPromptPreviewUntil = 0;
  return hadPendingSkip;
}

export function consumeDryRunPromptPreview(currentAt = now()): boolean {
  if (dryRunPromptPreviewUntil <= currentAt) {
    if (dryRunPromptPreviewUntil !== 0) {
      dryRunPromptPreviewUntil = 0;
    }
    return false;
  }

  dryRunPromptPreviewUntil = 0;
  return true;
}

export function readMvuExtraAnalysisFlag(): boolean {
  const runtime = globalThis as typeof globalThis & {
    Mvu?: { isDuringExtraAnalysis?: () => boolean };
    window?: {
      Mvu?: { isDuringExtraAnalysis?: () => boolean };
      parent?: {
        Mvu?: { isDuringExtraAnalysis?: () => boolean };
        getActivePinia?: () => any;
      };
      getActivePinia?: () => any;
    };
    getActivePinia?: () => any;
  };

  try {
    if (typeof runtime.Mvu?.isDuringExtraAnalysis === 'function') {
      return Boolean(runtime.Mvu.isDuringExtraAnalysis());
    }
  } catch {
    // ignore guard read failures and fall through
  }

  try {
    if (typeof runtime.window?.Mvu?.isDuringExtraAnalysis === 'function') {
      return Boolean(runtime.window.Mvu.isDuringExtraAnalysis());
    }
  } catch {
    // ignore guard read failures and fall through
  }

  try {
    if (
      typeof runtime.window?.parent?.Mvu?.isDuringExtraAnalysis === 'function'
    ) {
      return Boolean(runtime.window.parent.Mvu.isDuringExtraAnalysis());
    }
  } catch {
    // ignore guard read failures and fall through
  }

  try {
    const getActivePinia =
      runtime.getActivePinia ??
      runtime.window?.getActivePinia ??
      runtime.window?.parent?.getActivePinia;
    if (typeof getActivePinia === 'function') {
      const pinia = getActivePinia();
      return Boolean(
        pinia?.state?.value?.['MVU变量框架']?.runtimes?.is_during_extra_analysis,
      );
    }
  } catch {
    // ignore guard read failures and fall through
  }

  return false;
}

export function isMvuExtraAnalysisGuardActive(currentAt = now()): boolean {
  if (readMvuExtraAnalysisFlag()) {
    mvuExtraAnalysisGuardUntil = Math.max(
      mvuExtraAnalysisGuardUntil,
      currentAt + MVU_EXTRA_ANALYSIS_GUARD_TTL_MS,
    );
  }

  if (mvuExtraAnalysisGuardUntil <= currentAt) {
    if (mvuExtraAnalysisGuardUntil !== 0) {
      mvuExtraAnalysisGuardUntil = 0;
    }
    return false;
  }

  return true;
}

export function setProcessing(processing: boolean) {
  state.is_processing = processing;
}

export function clearSendContext() {
  state.last_send = null;
  state.last_send_intent = null;
}

export function clearSendContextIfMatches(message_id: number | null, user_input?: string) {
  if (message_id !== null && state.last_send?.message_id === message_id) {
    state.last_send = null;
  }

  const nextHash = String(user_input ?? '').trim() ? simpleHash(String(user_input)) : '';
  if (nextHash && state.last_send_intent?.hash === nextHash) {
    state.last_send_intent = null;
  }
}

export function clearAfterReplyPending() {
  state.after_reply.pending_user_message_id = null;
  state.after_reply.pending_user_input = '';
  state.after_reply.pending_generation_type = '';
  state.after_reply.pending_generation_seq = 0;
  state.after_reply.pending_at = 0;
}

export function clearAfterReplyPendingIfMatches(message_id: number | null) {
  if (message_id === null) {
    return;
  }

  if (state.after_reply.pending_user_message_id === message_id) {
    clearAfterReplyPending();
  }
}

export function setBeforeReplyBindingPending(input: {
  request_id: string;
  user_message_id: number;
  source_message_id: number;
  generation_type: string;
  window_ms: number;
}): BeforeReplyBindingPending {
  const createdAt = now();
  const windowMs = Math.max(1000, Math.trunc(Number(input.window_ms) || 0));
  const next: BeforeReplyBindingPending = {
    request_id: String(input.request_id ?? '').trim(),
    user_message_id: Number(input.user_message_id ?? -1),
    source_message_id: Number(input.source_message_id ?? -1),
    generation_type: String(input.generation_type ?? '').trim(),
    created_at: createdAt,
    expires_at: createdAt + windowMs,
    migrated: false,
  };
  state.before_reply_binding_pending = next;
  return next;
}

export function clearBeforeReplyBindingPending(): void {
  state.before_reply_binding_pending = null;
}

export function getBeforeReplyBindingPending(): BeforeReplyBindingPending | null {
  return state.before_reply_binding_pending;
}

export function pruneExpiredBeforeReplyBindingPending(currentAt = now()): BeforeReplyBindingPending | null {
  const pending = state.before_reply_binding_pending;
  if (!pending) {
    return null;
  }

  if (pending.expires_at > currentAt) {
    return pending;
  }

  state.before_reply_binding_pending = null;
  return null;
}

export function markBeforeReplyBindingMigrated(assistantMessageId: number): BeforeReplyBindingPending | null {
  const pending = state.before_reply_binding_pending;
  if (!pending) {
    return null;
  }

  const migratedAt = now();
  state.before_reply_binding_pending = {
    ...pending,
    migrated: true,
    migrated_assistant_message_id: assistantMessageId,
    migrated_at: migratedAt,
  };
  return state.before_reply_binding_pending;
}

export function markAfterReplyHandled(message_id: number, content: string) {
  state.after_reply.last_handled_assistant_message_id = message_id;
  state.after_reply.last_handled_hash = simpleHash(content);
  state.after_reply.last_handled_at = now();
}

export function wasAfterReplyHandled(message_id: number, content: string): boolean {
  if (state.after_reply.last_handled_assistant_message_id === message_id) {
    return true;
  }

  const contentHash = simpleHash(content);
  if (!contentHash || !state.after_reply.last_handled_hash) {
    return false;
  }

  return state.after_reply.last_handled_hash === contentHash && now() - state.after_reply.last_handled_at <= 30000;
}

export function resetRuntimeState() {
  state.last_send = null;
  state.last_send_intent = null;
  state.last_generation = null;
  generationSeq = 0;
  dryRunPromptPreviewUntil = 0;
  mvuExtraAnalysisGuardUntil = 0;
  clearAfterReplyPending();
  clearBeforeReplyBindingPending();
  state.after_reply.last_handled_assistant_message_id = null;
  state.after_reply.last_handled_hash = '';
  state.after_reply.last_handled_at = 0;
  state.is_processing = false;
}

export function isQuietLike(type: string, params: { quiet_prompt?: string } | undefined): boolean {
  if (type === 'quiet') {
    return true;
  }
  if (params?.quiet_prompt && String(params.quiet_prompt).trim()) {
    return true;
  }
  return false;
}

export function shouldHandleGenerationAfter(
  type: string,
  params: { automatic_trigger?: boolean; quiet_prompt?: string } | undefined,
  dry_run: boolean,
  settings: EwSettings,
): { ok: boolean; reason: string } {
  if (!settings.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (dry_run) {
    return { ok: false, reason: 'dry_run' };
  }
  if (isQuietLike(type, params)) {
    return { ok: false, reason: 'quiet' };
  }
  if (params?.automatic_trigger) {
    return { ok: false, reason: 'automatic_trigger' };
  }
  // 允许用户可配置 trigger_types 的标准生成类型。
  const allowedTypes = new Set(['normal', 'continue', 'regenerate', 'swipe']);
  if (!allowedTypes.has(type)) {
    return { ok: false, reason: `unsupported_type:${type}` };
  }

  // CR-2: continue/regenerate/swipe 不会创建新的发送记录，因此
  // gate_ttl 新鲜度检查几乎总会拒绝它们。跳过该检查。
  const noSendTypes = new Set(['continue', 'regenerate', 'swipe']);
  if (noSendTypes.has(type)) {
    return { ok: true, reason: 'ok' };
  }

  const lastSend = state.last_send;
  const lastIntent = state.last_send_intent;
  const hasFreshSend = Boolean(lastSend && now() - lastSend.at <= settings.gate_ttl_ms);
  const hasFreshIntent = Boolean(lastIntent && now() - lastIntent.at <= settings.gate_ttl_ms);

  if (!hasFreshSend && !hasFreshIntent) {
    return { ok: false, reason: 'missing_send_context' };
  }

  return { ok: true, reason: 'ok' };
}

export function shouldHandleAfterReply(
  message_id: number,
  type: string,
  settings: EwSettings,
): { ok: boolean; reason: string } {
  if (!settings.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (type === 'quiet' || type === 'impersonate' || type === 'command' || type === 'extension') {
    return { ok: false, reason: `unsupported_type:${type}` };
  }
  if (state.last_generation?.dry_run) {
    return { ok: false, reason: 'dry_run' };
  }
  if (state.last_generation?.params?.automatic_trigger) {
    return { ok: false, reason: 'automatic_trigger' };
  }
  if (state.after_reply.last_handled_assistant_message_id === message_id) {
    return { ok: false, reason: 'already_handled' };
  }

  const windowMs = Math.max(settings.total_timeout_ms + 10000, settings.gate_ttl_ms, 600000);
  const hasFreshPending = Boolean(state.after_reply.pending_at && now() - state.after_reply.pending_at <= windowMs);
  const hasFreshGeneration = Boolean(state.last_generation && now() - state.last_generation.at <= windowMs);

  if (!hasFreshPending && !hasFreshGeneration) {
    return { ok: false, reason: 'missing_generation_context' };
  }

  return { ok: true, reason: 'ok' };
}
