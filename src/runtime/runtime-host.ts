import {
  getCurrentChatIdSafe as getStCurrentChatIdSafe,
  getHostRuntime as getStHostRuntime,
  getHostWindow as getStHostWindow,
} from '../st-adapter';

import type { FlowTriggerV1 } from './contracts';

export type WorkflowRequestContext = {
  chat_id: string;
  request_id?: string;
  message_id: number;
  user_input?: string;
  trigger?: FlowTriggerV1;
};

export function getHostRuntime(): Record<string, any> {
  return getStHostRuntime();
}

export function getHostWindow(): Window & typeof globalThis {
  return getStHostWindow();
}

export function getSillyTavernRuntime(): Record<string, any> | undefined {
  const hostRuntime = getHostRuntime();
  const localRuntime = globalThis as Record<string, any>;
  return hostRuntime.SillyTavern ?? localRuntime.SillyTavern;
}

export function getCurrentChatIdSafe(): string {
  return getStCurrentChatIdSafe();
}

export function sanitizeFlowTrigger(trigger: FlowTriggerV1 | undefined): FlowTriggerV1 | undefined {
  if (!trigger) {
    return undefined;
  }

  const next: Record<string, unknown> = {
    timing: trigger.timing,
    source: trigger.source,
    generation_type: trigger.generation_type,
  };

  if (Number.isFinite(trigger.user_message_id)) {
    next.user_message_id = trigger.user_message_id;
  }

  if (Number.isFinite(trigger.assistant_message_id)) {
    next.assistant_message_id = trigger.assistant_message_id;
  }

  return next as FlowTriggerV1;
}

export function createWorkflowRequestContext(input: WorkflowRequestContext): WorkflowRequestContext {
  return {
    chat_id: String(input.chat_id ?? '').trim() || 'unknown',
    request_id: typeof input.request_id === 'string' ? input.request_id.trim() || undefined : undefined,
    message_id: Number(input.message_id ?? -1),
    user_input: typeof input.user_input === 'string' ? input.user_input : undefined,
    trigger: sanitizeFlowTrigger(input.trigger),
  };
}
