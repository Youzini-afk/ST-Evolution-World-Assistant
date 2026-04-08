/**
 * Compat: 提示词注入
 *
 * 替代旧的 `injectPrompts` 全局。
 * 使用 ST 的 `setExtensionPrompt` 实现一次性注入。
 *
 * setExtensionPrompt(key, value, position, depth, scan, role, filter)
 * - position 0 = IN_PROMPT (after story string)
 * - position 1 = IN_CHAT (at depth)
 */
import { getEventTypes, getSTContext } from "../../st-adapter";

const EW_INJECT_KEY = "ew_reply_instruction";

// ST extension_prompt_types
const EXTENSION_PROMPT_IN_CHAT = 1;

// ST extension_prompt_roles
const PROMPT_ROLE_SYSTEM = 0;

/**
 * 注入一次性回复指令。
 *
 * 替代旧 `injectPrompts([{ id, position, depth, role, content, should_scan }], { once: true })`。
 * 使用 ST 的 `setExtensionPrompt` 实现:注入到 depth=0 (最新消息后)。
 *
 * "一次性" 通过在下一次 generation 事件后清除实现。
 */
export function injectReplyInstruction(content: string): void {
  if (!content.trim()) return;

  const ctx = getSTContext() as any;
  if (typeof ctx.setExtensionPrompt !== "function") {
    console.warn("[Compat] setExtensionPrompt not available");
    return;
  }

  // 注入到 in_chat, depth=0, scan=true, role=system
  ctx.setExtensionPrompt(
    EW_INJECT_KEY,
    content.trim(),
    EXTENSION_PROMPT_IN_CHAT,
    0, // depth
    true, // scan (include in WI scan)
    PROMPT_ROLE_SYSTEM,
  );

  // 注册一次性清除:generation 完成后清除注入
  const es = ctx.eventSource;
  const eventTypes = getEventTypes();
  const clearEvents = [
    eventTypes.MESSAGE_RECEIVED ?? "messageReceived",
    eventTypes.GENERATION_STOPPED,
    eventTypes.GENERATION_ENDED,
  ].filter(
    (eventName): eventName is string =>
      typeof eventName === "string" && eventName.trim().length > 0,
  );

  const clearHandler = () => {
    try {
      ctx.setExtensionPrompt(EW_INJECT_KEY, "", EXTENSION_PROMPT_IN_CHAT, 0);
    } catch {
      /* 静默 */
    }
  };

  if (es && typeof es.once === "function") {
    for (const eventName of clearEvents) {
      es.once(eventName, clearHandler);
    }
  }
}

/**
 * 清除已注入的回复指令。
 */
export function clearReplyInstruction(): void {
  try {
    const ctx = getSTContext() as any;
    if (typeof ctx.setExtensionPrompt === "function") {
      ctx.setExtensionPrompt(EW_INJECT_KEY, "", EXTENSION_PROMPT_IN_CHAT, 0);
    }
  } catch {
    /* 静默 */
  }
}
