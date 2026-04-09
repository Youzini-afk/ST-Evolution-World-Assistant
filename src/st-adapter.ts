/**
 * SillyTavern API 适配层
 *
 * 封装 ST 原生 API，提供与旧 TavernHelper 运行时等效的接口。
 * 所有模块通过此文件访问 ST 功能，不直接依赖全局变量。
 */

import {
  setEventTypesSource,
  setSettingsMigrationSource,
  type EwHostEventTypesSource,
} from "./runtime/host-status";

// ── ST 全局类型声明 ──────────────────────────────────

/** SillyTavern 暴露的 context 对象（部分类型） */
export interface STContext {
  chat: any[];
  characters: any[];
  name1: string; // 用户名
  name2: string; // 角色名
  characterId: number;
  groupId: string | null;
  selectedGroupId?: string | null;
  groups?: any[];
  chatId: string;
  onlineStatus: string;
  maxContext: number;
  extensionSettings: Record<string, any>;
  saveSettingsDebounced: () => void;
  eventSource: STEventSource;
  event_types?: Record<string, string>;
  eventTypes?: Record<string, string>;
  getRequestHeaders: () => Record<string, string>;
  getCurrentChatId?: () => string;
  saveChat?: () => Promise<void>;
  saveChatConditional?: () => Promise<void>;
  deleteLastMessage?: () => Promise<void>;
  loadWorldInfo?: (name: string) => Promise<Record<string, any>>;
  saveWorldInfo?: (
    name: string,
    data: Record<string, any>,
    immediately?: boolean,
  ) => Promise<void>;
  reloadWorldInfoEditor?: () => Promise<void> | void;
  updateWorldInfoList?: () => Promise<void> | void;
  setExtensionPrompt?: (
    key: string,
    value: string,
    position: number,
    depth?: number,
    scan?: boolean,
    role?: number,
    filter?: unknown,
  ) => void;
  /** 发送一次 quiet generation */
  generateQuietPrompt: (
    prompt: string,
    quietToLoud?: boolean,
    skipWIAN?: boolean,
    quietImage?: string | null,
    quietName?: string | null,
    responseLength?: number,
  ) => Promise<string>;
}

export interface STEventSource {
  on: (event: string, handler: (...args: any[]) => void) => void;
  once: (event: string, handler: (...args: any[]) => void) => void;
  removeListener: (event: string, handler: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  makeLast: (event: string, handler: (...args: any[]) => void) => void;
  makeFirst: (event: string, handler: (...args: any[]) => void) => void;
}

// ── 全局 context 获取 ─────────────────────────────────

export function getHostWindow(): Window & typeof globalThis {
  try {
    if (window.parent && window.parent !== window) {
      return window.parent as Window & typeof globalThis;
    }
  } catch {
    // ignore cross-frame access failure and fall back to current window
  }

  return window;
}

export function getHostDocument(): Document {
  return getHostWindow().document;
}

export function getHostRuntime(): Record<string, any> {
  return getHostWindow() as unknown as Record<string, any>;
}

/**
 * 获取 SillyTavern context。
 * ST 扩展通过 `SillyTavern.getContext()` 访问。
 *
 * 注意: 不缓存 context — ST 的 getContext() 每次返回最新快照，
 * chat/settings 等可能随时变化。
 */
export function getSTContext(): STContext {
  const st = getHostRuntime().SillyTavern ?? (globalThis as any).SillyTavern;
  if (!st || typeof st.getContext !== "function") {
    throw new Error(
      "[Evolution World] SillyTavern.getContext() 不可用 — 确保在 jQuery ready 后调用",
    );
  }

  return st.getContext() as STContext;
}

export function tryGetSTContext(): STContext | undefined {
  try {
    return getSTContext();
  } catch {
    return undefined;
  }
}

/**
 * 检查 SillyTavern context 是否可用（不抛出异常）。
 */
export function isSTReady(): boolean {
  const st = getHostRuntime().SillyTavern ?? (globalThis as any).SillyTavern;
  return !!(st && typeof st.getContext === "function");
}

/**
 * 获取 eventSource（事件总线）。
 * 替代旧的 `eventOn` / `tavern_events`。
 */
export function getEventSource(): STEventSource {
  return getSTContext().eventSource;
}

/**
 * 获取 event_types 枚举。
 * 替代旧的 `tavern_events`。
 */
export function getEventTypes(): Record<string, string> {
  const ctx = getSTContext() as Record<string, any>;
  const resolved = resolveEventTypes(ctx);
  setEventTypesSource(resolved.source);
  if (resolved.source !== lastLoggedEventTypesSource) {
    lastLoggedEventTypesSource = resolved.source;
    console.info(
      `[Evolution World] event types resolved from ${resolved.source}`,
    );
  }
  return resolved.types;
}

// ── Settings 适配 ─────────────────────────────────────

const ASSISTANT_SETTINGS_KEY = "evolution_world_assistant";
const LEGACY_SETTINGS_KEYS = ["evolution_world"] as const;
const LEGACY_SCRIPT_LOCAL_STORAGE_KEY = "evolution_world_assistant";
let lastLoggedEventTypesSource: EwHostEventTypesSource | null = null;
let lastLoggedMigrationSource: string | null = null;

function countMeaningfulArrayEntries(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }

  return value.filter((entry) => entry && typeof entry === "object").length;
}

function countObjectKeys(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }

  return Object.keys(value).length;
}

export function getExtensionSettingsBucketScore(bucket: unknown): number {
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
    return 0;
  }

  const obj = bucket as Record<string, any>;
  const settings =
    obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
      ? (obj.settings as Record<string, any>)
      : null;
  const flowCount = countMeaningfulArrayEntries(settings?.flows);
  const apiPresetCount = countMeaningfulArrayEntries(settings?.api_presets);
  const backupCount = countObjectKeys(obj.backups);
  const runByChatCount = countObjectKeys(obj.last_run_by_chat);
  const ioByChatCount = countObjectKeys(obj.last_io_by_chat);

  return (
    flowCount * 100 +
    apiPresetCount * 60 +
    (settings?.enabled ? 10 : 0) +
    (obj.last_run ? 8 : 0) +
    (obj.last_io ? 8 : 0) +
    Math.min(backupCount, 10) * 3 +
    Math.min(runByChatCount, 10) * 2 +
    Math.min(ioByChatCount, 10) * 2
  );
}

export function shouldUseLegacySettingsBucket(
  assistantBucket: unknown,
  legacyBucket: unknown,
): boolean {
  const assistantScore = getExtensionSettingsBucketScore(assistantBucket);
  const legacyScore = getExtensionSettingsBucketScore(legacyBucket);

  if (legacyScore <= assistantScore) {
    return false;
  }

  return assistantScore < 50;
}

function resolveEventTypes(ctx: Record<string, any>): {
  types: Record<string, string>;
  source: EwHostEventTypesSource;
} {
  if (ctx.eventTypes && typeof ctx.eventTypes === "object") {
    return {
      types: ctx.eventTypes as Record<string, string>,
      source: "eventTypes",
    };
  }

  if (ctx.event_types && typeof ctx.event_types === "object") {
    return {
      types: ctx.event_types as Record<string, string>,
      source: "event_types",
    };
  }

  return {
    types: {},
    source: "missing",
  };
}

function cloneSettingsBucket<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {
    // fall through
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function readLegacyScriptLocalStorageBucket(): Record<string, any> | null {
  try {
    const runtime = getHostRuntime() as { localStorage?: Storage };
    const storage = runtime.localStorage ?? globalThis.localStorage;
    if (!storage) {
      return null;
    }

    const raw = storage.getItem(LEGACY_SCRIPT_LOCAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, any>;
  } catch (error) {
    console.warn(
      "[Evolution World] Failed to read legacy script localStorage settings bucket:",
      error,
    );
    return null;
  }
}

function tryMigrateScriptLocalStorageBucket(
  ctx: STContext,
  buckets: Record<string, any>,
  assistantBucket?: Record<string, any>,
): Record<string, any> | null {
  const scriptBucket = readLegacyScriptLocalStorageBucket();
  if (!scriptBucket) {
    return null;
  }

  if (
    assistantBucket &&
    !shouldUseLegacySettingsBucket(assistantBucket, scriptBucket)
  ) {
    return null;
  }

  const migratedBucket = cloneSettingsBucket(scriptBucket);
  buckets[ASSISTANT_SETTINGS_KEY] = migratedBucket;
  ctx.saveSettingsDebounced();
  setSettingsMigrationSource("legacy:script_local_storage");
  logSettingsMigration(
    assistantBucket
      ? "recovered from script localStorage"
      : "migrated from script localStorage",
  );
  return migratedBucket as Record<string, any>;
}

function logSettingsMigration(source: string): void {
  if (source === lastLoggedMigrationSource) {
    return;
  }
  lastLoggedMigrationSource = source;
  console.info(`[Evolution World] settings namespace source: ${source}`);
}

/**
 * 读取扩展 settings。
 * 替代 `getVariables({ type: 'script', script_id: getScriptId() })`。
 */
export function readExtensionSettings(): Record<string, any> {
  const ctx = getSTContext();
  const buckets =
    ctx.extensionSettings && typeof ctx.extensionSettings === "object"
      ? ctx.extensionSettings
      : (ctx.extensionSettings = {});

  const assistantBucket = buckets[ASSISTANT_SETTINGS_KEY];
  if (assistantBucket && typeof assistantBucket === "object") {
    for (const legacyKey of LEGACY_SETTINGS_KEYS) {
      const legacyBucket = buckets[legacyKey];
      if (
        legacyBucket &&
        typeof legacyBucket === "object" &&
        shouldUseLegacySettingsBucket(assistantBucket, legacyBucket)
      ) {
        const migratedBucket = cloneSettingsBucket(legacyBucket);
        buckets[ASSISTANT_SETTINGS_KEY] = migratedBucket;
        ctx.saveSettingsDebounced();
        setSettingsMigrationSource(`legacy:${legacyKey}`);
        logSettingsMigration(`recovered from ${legacyKey}`);
        return migratedBucket as Record<string, any>;
      }
    }

    const migratedFromScriptStorage = tryMigrateScriptLocalStorageBucket(
      ctx,
      buckets,
      assistantBucket as Record<string, any>,
    );
    if (migratedFromScriptStorage) {
      return migratedFromScriptStorage;
    }

    setSettingsMigrationSource("assistant");
    logSettingsMigration(ASSISTANT_SETTINGS_KEY);
    return assistantBucket as Record<string, any>;
  }

  for (const legacyKey of LEGACY_SETTINGS_KEYS) {
    const legacyBucket = buckets[legacyKey];
    if (legacyBucket && typeof legacyBucket === "object") {
      const migratedBucket = cloneSettingsBucket(legacyBucket);
      buckets[ASSISTANT_SETTINGS_KEY] = migratedBucket;
      ctx.saveSettingsDebounced();
      setSettingsMigrationSource(`legacy:${legacyKey}`);
      logSettingsMigration(`migrated from ${legacyKey}`);
      return migratedBucket as Record<string, any>;
    }
  }

  const migratedFromScriptStorage = tryMigrateScriptLocalStorageBucket(
    ctx,
    buckets,
  );
  if (migratedFromScriptStorage) {
    return migratedFromScriptStorage;
  }

  if (!buckets[ASSISTANT_SETTINGS_KEY] || typeof buckets[ASSISTANT_SETTINGS_KEY] !== "object") {
    buckets[ASSISTANT_SETTINGS_KEY] = {};
  }
  setSettingsMigrationSource("initialized_empty");
  logSettingsMigration("initialized_empty");
  return buckets[ASSISTANT_SETTINGS_KEY] as Record<string, any>;
}

/**
 * 写入扩展 settings 并触发持久化。
 * 替代 `insertOrAssignVariables`。
 */
export function writeExtensionSettings(data: Record<string, any>): void {
  const ctx = getSTContext();
  ctx.extensionSettings[ASSISTANT_SETTINGS_KEY] = data;
  setSettingsMigrationSource("assistant");
  ctx.saveSettingsDebounced();
}

// ── 事件监听适配 ──────────────────────────────────────

type StopFn = () => void;

/**
 * 注册事件监听器。返回取消订阅函数。
 * 替代 `eventOn(tavern_events.XXX, handler)` 返回的 EventOnReturn。
 */
export function onSTEvent(
  eventName: string,
  handler: (...args: any[]) => void,
): StopFn {
  const es = getEventSource();
  es.on(eventName, handler);
  return () => es.removeListener(eventName, handler);
}

/**
 * 注册高优先级事件监听器（在其他监听器之前执行）。
 * 替代 `eventMakeFirst`。
 */
export function onSTEventFirst(
  eventName: string,
  handler: (...args: any[]) => void,
): StopFn {
  const es = getEventSource();
  if (typeof es.makeFirst === "function") {
    es.makeFirst(eventName, handler);
  } else {
    es.on(eventName, handler);
  }
  return () => es.removeListener(eventName, handler);
}

// ── 杂项工具 ──────────────────────────────────────────

/**
 * 获取当前 chat ID。
 */
export function getChatId(): string {
  return getSTContext().chatId;
}

export function getCurrentChatIdSafe(): string {
  const ctx = tryGetSTContext();
  if (ctx) {
    const chatId =
      (typeof ctx.getCurrentChatId === "function" ? ctx.getCurrentChatId() : ctx.chatId) ?? "";
    return String(chatId).trim() || "unknown";
  }

  try {
    const runtime = getHostRuntime();
    const st = runtime.SillyTavern ?? (globalThis as any).SillyTavern;
    return String(st?.getCurrentChatId?.() ?? st?.chatId ?? "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 获取 ST 请求头（包含 CSRF token 等）。
 */
export function getRequestHeaders(): Record<string, string> {
  return getSTContext().getRequestHeaders();
}
