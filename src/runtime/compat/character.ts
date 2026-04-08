/**
 * Compat: 角色与聊天上下文
 *
 * 替代旧的 getCurrentCharacterName / getCharacter /
 * getChatMessages / setChatMessages / getLastMessageId。
 *
 * 内部通过 ST context 的 chat 数组和 characters 数组实现。
 *
 * 重要: ST 原始消息使用 `mes` 字段存储正文,而业务代码读取 `message`。
 * 此 compat 层在返回消息时做标准化映射。
 */
import { getSTContext } from '../../st-adapter';

// ── 聊天消息类型 ──────────────────────────────────────

export interface ChatMessage {
  /** 消息正文 (映射自 ST 的 mes / extra.display_text) */
  message: string;
  /** 角色: user / assistant / system */
  role: 'user' | 'assistant' | 'system';
  /** 是否为用户消息 */
  is_user: boolean;
  /** 是否为系统消息 */
  is_system: boolean;
  /** 消息索引 */
  message_id: number;
  /** 发送者名称 */
  name?: string;
  /** 消息附带数据 (floor binding, EW data 等) */
  data?: Record<string, unknown>;
  /** 当前 swipe 索引 */
  swipe_id?: number;
  /** 所有 swipe 文本 */
  swipes?: string[];
  /** 额外元数据 */
  extra?: Record<string, any>;
  /** 原始 ST 消息对象引用 (不保证结构) */
  raw: any;
}

// ── ST 消息 → compat 消息映射 ─────────────────────────

/**
 * 将 ST 原始聊天消息对象标准化为 compat ChatMessage。
 *
 * ST 消息关键字段:
 * - `mes` — 正文 (注意不是 `message`)
 * - `extra.display_text` — 显示文本 (如有)
 * - `is_user` — boolean
 * - `is_system` — boolean
 * - `name` — 发送者名
 */
function normalizeMessage(raw: any, index: number): ChatMessage {
  // 正文: 优先取 extra.display_text, 回退到 mes, 再回退到 message
  const message = String(raw?.extra?.display_text ?? raw?.mes ?? raw?.message ?? '');

  // 角色推导
  let role: 'user' | 'assistant' | 'system';
  if (raw?.is_system === true) {
    role = 'system';
  } else if (raw?.is_user === true) {
    role = 'user';
  } else {
    role = 'assistant';
  }

  return {
    message,
    role,
    is_user: Boolean(raw?.is_user),
    is_system: Boolean(raw?.is_system),
    message_id: index,
    name: raw?.name,
    data: raw?.data,
    swipe_id: raw?.swipe_id,
    swipes: raw?.swipes,
    extra: raw?.extra,
    raw,
  };
}

// ── 角色 ──────────────────────────────────────────────

/**
 * 获取当前活跃角色名。
 * 替代旧 `getCurrentCharacterName()`。
 */
export function getCurrentCharacterName(): string | null {
  const ctx = getSTContext() as any;
  return ctx.name2 ?? null;
}

/**
 * 获取当前角色对象。
 * 替代旧 `getCharacter('current')`。
 */
export function getCurrentCharacter(): Record<string, any> | null {
  const ctx = getSTContext() as any;
  const chid = ctx.characterId;
  const chars = ctx.characters;
  if (chid == null || !chars?.[chid]) return null;
  return chars[chid];
}

// ── 聊天消息 ──────────────────────────────────────────

/**
 * 获取聊天消息。
 *
 * 支持两种调用方式:
 * - `getChatMessages(5)` → 返回第 5 条消息 (单条数组)
 * - `getChatMessages('0-10')` → 返回 0-10 范围的消息
 * - `getChatMessages(-1)` → 返回最后一条消息
 *
 * 返回结构已标准化: ST 的 `mes` 被映射为 `message`。
 *
 * 替代旧 `getChatMessages(idOrRange, opts)`。
 */
export function getChatMessages(
  messageIdOrRange: number | string,
  _opts?: { hide_state?: string },
): ChatMessage[] {
  const ctx = getSTContext() as any;
  const chat: any[] = ctx.chat ?? [];

  if (typeof messageIdOrRange === 'number') {
    const idx = messageIdOrRange < 0 ? chat.length + messageIdOrRange : messageIdOrRange;
    const msg = chat[idx];
    if (!msg) return [];
    return [normalizeMessage(msg, idx)];
  }

  // 范围格式: "0-10"
  const parts = String(messageIdOrRange).split('-');
  const start = Math.max(0, parseInt(parts[0], 10) || 0);
  const end = Math.min(chat.length - 1, parseInt(parts[1], 10) || chat.length - 1);

  const result: ChatMessage[] = [];
  for (let i = start; i <= end; i++) {
    const msg = chat[i];
    if (msg) {
      result.push(normalizeMessage(msg, i));
    }
  }
  return result;
}

/**
 * 更新聊天消息的 data 字段。
 *
 * 替代旧 `setChatMessages(updates, opts)`。
 * 直接写 ST chat 数组,然后通过 saveChat 持久化。
 */
export async function setChatMessages(
  updates: Array<{ message_id: number; data?: Record<string, unknown> }>,
  _opts?: { refresh?: string },
): Promise<void> {
  const ctx = getSTContext() as any;
  const chat: any[] = ctx.chat ?? [];

  for (const update of updates) {
    const msg = chat[update.message_id];
    if (!msg) continue;
    if (update.data !== undefined) {
      msg.data = update.data;
    }
  }

  // 持久化
  if (typeof ctx.saveChat === 'function') {
    await ctx.saveChat();
  } else if (typeof ctx.saveChatConditional === 'function') {
    await ctx.saveChatConditional();
  }
}

/**
 * 获取最后一条消息的 ID (索引)。
 * 替代旧 `getLastMessageId()`。
 */
export function getLastMessageId(): number {
  const ctx = getSTContext() as any;
  const chat: any[] = ctx.chat ?? [];
  return chat.length - 1;
}

/**
 * 获取当前 Chat ID。
 * 替代旧 `SillyTavern.getCurrentChatId()`。
 */
export function getChatId(): string {
  const ctx = getSTContext() as any;
  if (typeof ctx.getCurrentChatId === 'function') {
    return ctx.getCurrentChatId() ?? 'unknown';
  }
  return ctx.chatId ?? 'unknown';
}
