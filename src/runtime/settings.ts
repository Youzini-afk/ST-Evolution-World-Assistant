import { readExtensionSettings, writeExtensionSettings } from '../st-adapter';
import { klona } from 'klona';
import { normalizeApiBaseUrl, normalizeApiSource } from './api-sources';
import { createDefaultApiPreset, createDefaultFlow } from './factory';
import { simpleHash } from './helpers';
import {
  mergeSharedSettingsWithLocalSecrets,
  sanitizeLastIoSummary,
  sanitizeSettingsForShared,
} from './redaction';
import { readSharedSettings, writeSharedSettings } from './shared-settings-storage';
import {
  ControllerEntrySnapshot,
  DEFAULT_PROMPT_ORDER,
  EwApiPreset,
  EwApiPresetSchema,
  EwFlowConfig,
  EwFlowConfigSchema,
  EwPromptOrderEntry,
  EwSettings,
  EwSettingsSchema,
  LastIoSummary,
  LastIoSummarySchema,
  RunSummary,
  RunSummarySchema,
} from './types';

type SettingsListener = (settings: EwSettings) => void;
type RunListener = (summary: RunSummary | null) => void;
type IoListener = (summary: LastIoSummary | null) => void;

type ScriptStorageShape = {
  settings?: EwSettings;
  last_run?: RunSummary | null;
  last_io?: LastIoSummary | null;
  last_run_by_chat?: Record<string, RunSummary | null | undefined>;
  last_io_by_chat?: Record<string, LastIoSummary | null | undefined>;
  backups?: Record<
    string,
    {
      at: number;
      worldbook_name: string;
      controller_content: string | Record<string, string> | ControllerEntrySnapshot[];
    }
  >;
};

const SCRIPT_STORAGE_KEY = 'evolution_world_assistant';

const settingsListeners = new Set<SettingsListener>();
const runListeners = new Set<RunListener>();
const ioListeners = new Set<IoListener>();
const SHARED_SETTINGS_WRITE_DELAY_MS = 240;
const MAX_DEBUG_RECORD_CHATS = 80;

let cachedSettings: EwSettings | null = null;
let cachedLastRun: RunSummary | null | undefined = undefined;
let cachedLastIo: LastIoSummary | null | undefined = undefined;
let sharedSettingsHydrationPromise: Promise<EwSettings> | null = null;
let sharedSettingsWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSharedSettings: EwSettings | null = null;
let sharedSettingsWritePromise: Promise<void> = Promise.resolve();

// M-3: 使用 factory.ts 中的共享工厂函数。
const makeDefaultApiPreset = createDefaultApiPreset;
const makeDefaultFlow = createDefaultFlow;

function readScriptStorage(): ScriptStorageShape {
  const raw = readExtensionSettings();
  if (!_.isPlainObject(raw)) {
    return {};
  }
  return raw as ScriptStorageShape;
}

function writeScriptStorage(updater: (storage: ScriptStorageShape) => ScriptStorageShape) {
  const previous = readScriptStorage();
  const nextStorage = updater(previous);
  writeExtensionSettings(nextStorage as Record<string, any>);
}

function persistLocalSettings(settings: EwSettings) {
  writeScriptStorage(previous => ({ ...previous, settings }));
}

function queueSharedSettingsPersist(settings: EwSettings) {
  pendingSharedSettings = klona(settings);

  if (sharedSettingsWriteTimer !== null) {
    clearTimeout(sharedSettingsWriteTimer);
  }

  sharedSettingsWriteTimer = setTimeout(() => {
    sharedSettingsWriteTimer = null;
    const nextSettings = pendingSharedSettings;
    pendingSharedSettings = null;
    if (!nextSettings) {
      return;
    }

    sharedSettingsWritePromise = sharedSettingsWritePromise
      .catch(() => undefined)
      .then(async () => {
        await writeSharedSettings(nextSettings);
      })
      .catch(error => {
        console.warn('[Evolution World] Failed to persist shared settings:', error);
      });
  }, SHARED_SETTINGS_WRITE_DELAY_MS);
}

function ensurePresetId(rawId: string, index: number, usedIds: Set<string>): string {
  let nextId = rawId.trim() || `api_${index + 1}_${simpleHash(`api-${index}-${Date.now()}`)}`;
  while (usedIds.has(nextId)) {
    nextId = `${nextId}_${usedIds.size + 1}`;
  }
  usedIds.add(nextId);
  return nextId;
}

function ensurePresetName(baseName: string, usedNames: Set<string>): string {
  const trimmed = baseName.trim() || 'API配置';
  if (!usedNames.has(trimmed)) {
    usedNames.add(trimmed);
    return trimmed;
  }

  let counter = 2;
  let nextName = `${trimmed} ${counter}`;
  while (usedNames.has(nextName)) {
    counter += 1;
    nextName = `${trimmed} ${counter}`;
  }
  usedNames.add(nextName);
  return nextName;
}

function ensureFlowId(rawId: string, index: number, flowName: string, usedIds: Set<string>): string {
  const trimmed = rawId.trim();
  const baseId = trimmed || `flow_${index + 1}_${simpleHash(`${index}:${flowName || 'flow'}`)}`;
  let nextId = baseId;
  let counter = 2;
  while (usedIds.has(nextId)) {
    nextId = `${baseId}__${counter}`;
    counter += 1;
  }
  usedIds.add(nextId);
  return nextId;
}

function normalizeApiPresets(rawPresets: EwApiPreset[]): EwApiPreset[] {
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();

  const normalized = rawPresets.map((preset, index) => {
    const parsed = EwApiPresetSchema.parse(preset);
    const id = ensurePresetId(parsed.id, index, usedIds);
    const name = ensurePresetName(parsed.name, usedNames);
    return EwApiPresetSchema.parse({
      ...parsed,
      id,
      name,
      mode: parsed.mode ?? 'workflow_http',
      use_main_api: parsed.use_main_api ?? false,
      api_url: normalizeApiBaseUrl(parsed.api_source, parsed.api_url),
      model: parsed.model ?? '',
      api_source: normalizeApiSource(parsed.api_source),
      model_candidates: parsed.model_candidates ?? [],
    });
  });

  return normalized;
}

function findPresetByLegacyFields(presets: EwApiPreset[], flow: EwFlowConfig): EwApiPreset | null {
  const legacyUrl = flow.api_url.trim();
  const legacyKey = flow.api_key.trim();
  const legacyHeaders = flow.headers_json.trim();
  if (!legacyUrl && !legacyKey && !legacyHeaders) {
    return null;
  }

  return (
    presets.find(preset => {
      return (
        preset.api_url.trim() === legacyUrl &&
        preset.api_key.trim() === legacyKey &&
        preset.headers_json.trim() === legacyHeaders
      );
    }) ?? null
  );
}

function migratePromptItems(flow: EwFlowConfig): EwFlowConfig {
  // 如果 prompt_order 已被自定义（长度与默认不同），跳过迁移
  if (flow.prompt_order.length !== DEFAULT_PROMPT_ORDER.length) return flow;

  // 检查 prompt_order 是否仍为默认值（从未被用户配置）
  const isDefault = flow.prompt_order.every((entry, idx) => entry.identifier === DEFAULT_PROMPT_ORDER[idx].identifier);
  if (!isDefault) return flow;

  // 如果存在 prompt_items，将其作为自定义条目追加到 prompt_order
  if (flow.prompt_items.length === 0) return flow;

  const migratedOrder: EwPromptOrderEntry[] = [...flow.prompt_order];
  for (const item of flow.prompt_items) {
    // 避免重复 —— 检查 identifier 是否已存在
    if (migratedOrder.some(e => e.identifier === item.id)) continue;
    const oldItem = item as any; // may carry legacy depth field
    migratedOrder.push({
      identifier: item.id,
      name: item.name || '迁移提示词',
      enabled: item.enabled,
      type: 'prompt',
      role: item.role as 'system' | 'user' | 'assistant',
      content: item.content,
      injection_position: item.position === 'in_chat' ? 'in_chat' : 'relative',
      injection_depth:
        typeof oldItem.injection_depth === 'number'
          ? oldItem.injection_depth
          : typeof oldItem.depth === 'number'
            ? oldItem.depth
            : 0,
    });
  }
  return { ...flow, prompt_order: migratedOrder };
}

function normalizeSettings(raw: unknown): EwSettings {
  // Migrate legacy controller_entry_name → controller_entry_prefix.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj['controller_entry_name'] === 'string' && !obj['controller_entry_prefix']) {
      const oldName = obj['controller_entry_name'] as string;
      obj['controller_entry_prefix'] = oldName.endsWith('/') ? oldName : oldName + '/';
      delete obj['controller_entry_name'];
    }
    // Old versions defaulted to 10s parallel staggering, which behaves like accidental serialized reroll.
    if (Number(obj['parallel_dispatch_interval_seconds'] ?? 0) === 10) {
      obj['parallel_dispatch_interval_seconds'] = 0;
    }
  }

  const parsed = EwSettingsSchema.safeParse(raw);
  const base = parsed.success ? parsed.data : EwSettingsSchema.parse({});
  const apiPresets = normalizeApiPresets(base.api_presets ?? []);
  const usedPresetNames = new Set(apiPresets.map(preset => preset.name));
  const flowSeed = base.flows ?? [];
  const usedFlowIds = new Set<string>();

  const normalizedFlows = flowSeed.map((flow, index) => {
    let nextFlow = EwFlowConfigSchema.parse(flow);
    const uniqueFlowId = ensureFlowId(nextFlow.id, index, nextFlow.name, usedFlowIds);
    if (uniqueFlowId !== nextFlow.id) {
      console.warn(`[Evolution World] normalized duplicate flow id "${nextFlow.id}" -> "${uniqueFlowId}"`);
      nextFlow = EwFlowConfigSchema.parse({
        ...nextFlow,
        id: uniqueFlowId,
      });
    }
    // FEAT-2: 将旧的 prompt_items 迁移到 prompt_order
    nextFlow = migratePromptItems(nextFlow);
    const boundPreset = apiPresets.find(preset => preset.id === nextFlow.api_preset_id);
    if (boundPreset) {
      return nextFlow;
    }

    const legacyPreset = findPresetByLegacyFields(apiPresets, nextFlow);
    if (legacyPreset) {
      return EwFlowConfigSchema.parse({
        ...nextFlow,
        api_preset_id: legacyPreset.id,
      });
    }

    const hasLegacyApiConfig = Boolean(
      nextFlow.api_url.trim() || nextFlow.api_key.trim() || nextFlow.headers_json.trim(),
    );
    if (hasLegacyApiConfig) {
      const createdPreset = EwApiPresetSchema.parse({
        id: ensurePresetId('', apiPresets.length, new Set(apiPresets.map(preset => preset.id))),
        name: ensurePresetName(`${nextFlow.name || '工作流'} API`, usedPresetNames),
        mode: 'workflow_http',
        use_main_api: false,
        api_url: nextFlow.api_url,
        api_key: nextFlow.api_key,
        model: '',
        api_source: normalizeApiSource('openai'),
        model_candidates: [],
        headers_json: nextFlow.headers_json,
      });
      apiPresets.push(createdPreset);
      return EwFlowConfigSchema.parse({
        ...nextFlow,
        api_preset_id: createdPreset.id,
      });
    }

    return EwFlowConfigSchema.parse({
      ...nextFlow,
      api_preset_id: '',
    });
  });

  return EwSettingsSchema.parse({
    ...base,
    api_presets: apiPresets,
    flows: normalizedFlows,
  });
}

function getSettingsStructureScore(settings: EwSettings): number {
  const flowCount = settings.flows.length;
  const apiPresetCount = settings.api_presets.length;

  return flowCount * 100 + apiPresetCount * 60 + (settings.enabled ? 10 : 0);
}

export function mergeSharedSettingsWithLocalFallback(
  shared: EwSettings,
  local: EwSettings,
): EwSettings {
  const sharedScore = getSettingsStructureScore(shared);
  const localScore = getSettingsStructureScore(local);

  if (sharedScore === 0 && localScore > 0) {
    return EwSettingsSchema.parse(local);
  }

  const needsLocalFlows = shared.flows.length === 0 && local.flows.length > 0;
  const needsLocalApiPresets =
    shared.api_presets.length === 0 && local.api_presets.length > 0;
  const shouldReuseLocalBasics =
    (needsLocalFlows || needsLocalApiPresets) && localScore > sharedScore;

  return EwSettingsSchema.parse({
    ...shared,
    ...(shouldReuseLocalBasics
      ? {
          enabled: local.enabled,
          workflow_timing: local.workflow_timing,
        }
      : {}),
    api_presets: needsLocalApiPresets ? local.api_presets : shared.api_presets,
    flows: needsLocalFlows ? local.flows : shared.flows,
  });
}

function emitSettings(settings: EwSettings) {
  settingsListeners.forEach(listener => listener(settings));
}

function emitRun(summary: RunSummary | null) {
  runListeners.forEach(listener => listener(summary));
}

function emitIo(summary: LastIoSummary | null) {
  ioListeners.forEach(listener => listener(summary));
}

function normalizeRunRecordMap(storage: ScriptStorageShape): Record<string, RunSummary> {
  const raw = storage.last_run_by_chat;
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: Record<string, RunSummary> = {};
  for (const [chatId, summary] of Object.entries(raw)) {
    const parsed = RunSummarySchema.safeParse(summary);
    if (parsed.success) {
      next[chatId] = parsed.data;
    }
  }
  return next;
}

function normalizeIoRecordMap(storage: ScriptStorageShape): Record<string, LastIoSummary> {
  const raw = storage.last_io_by_chat;
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: Record<string, LastIoSummary> = {};
  for (const [chatId, summary] of Object.entries(raw)) {
    const parsed = LastIoSummarySchema.safeParse(summary);
    if (parsed.success) {
      next[chatId] = sanitizeLastIoSummary(parsed.data);
    }
  }
  return next;
}

function trimDebugRecordMap<T extends { at: number }>(
  records: Record<string, T>,
  maxEntries: number,
): Record<string, T> {
  const entries = Object.entries(records);
  if (entries.length <= maxEntries) {
    return records;
  }

  entries.sort((left, right) => Number(right[1]?.at ?? 0) - Number(left[1]?.at ?? 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export function loadSettings(): EwSettings {
  const storage = readScriptStorage();
  const normalized = normalizeSettings(storage.settings);
  cachedSettings = normalized;

  persistLocalSettings(normalized);
  return normalized;
}

export async function hydrateSharedSettings(): Promise<EwSettings> {
  if (sharedSettingsHydrationPromise) {
    return sharedSettingsHydrationPromise;
  }

  sharedSettingsHydrationPromise = (async () => {
    const localStorage = readScriptStorage();
    const localNormalized = cachedSettings ?? normalizeSettings(localStorage.settings);

    try {
      const shared = await readSharedSettings();
      if (shared?.settings) {
        const normalized = normalizeSettings(shared.settings);
        const structurallyMerged = mergeSharedSettingsWithLocalFallback(
          normalized,
          localNormalized,
        );
        const sharedStructureChanged = !_.isEqual(normalized, structurallyMerged);
        const sanitizedShared = sanitizeSettingsForShared(structurallyMerged);
        const merged = mergeSharedSettingsWithLocalSecrets(
          mergeSharedSettingsWithLocalSecrets(sanitizedShared, localNormalized),
          normalized,
        );
        const changed = !_.isEqual(cachedSettings, merged);
        cachedSettings = merged;
        persistLocalSettings(merged);
        if (!_.isEqual(normalized, sanitizedShared)) {
          if (sharedStructureChanged) {
            console.info(
              '[Evolution World] Repaired shared settings from local runtime cache to preserve flows/API presets',
            );
          }
          void writeSharedSettings(structurallyMerged).catch(error => {
            console.warn('[Evolution World] Failed to rewrite shared settings without secrets:', error);
          });
        }
        if (changed) {
          emitSettings(klona(merged));
        }
        console.info('[Evolution World] Shared settings loaded from server file');
        return klona(merged);
      }

      cachedSettings = localNormalized;
      await writeSharedSettings(localNormalized);
      persistLocalSettings(localNormalized);
      console.info(
        localStorage.settings
          ? '[Evolution World] Migrated legacy local settings to shared server file'
          : '[Evolution World] Initialized shared server settings file',
      );
      return klona(localNormalized);
    } catch (error) {
      console.warn('[Evolution World] Shared settings hydration failed, using local cache:', error);
      cachedSettings = localNormalized;
      persistLocalSettings(localNormalized);
      return klona(localNormalized);
    }
  })();

  return sharedSettingsHydrationPromise;
}

export function getSettings(): EwSettings {
  if (!cachedSettings) {
    cachedSettings = loadSettings();
  }
  return klona(cachedSettings);
}

export function replaceSettings(nextSettings: EwSettings): EwSettings {
  const normalized = normalizeSettings(nextSettings);
  cachedSettings = normalized;
  persistLocalSettings(normalized);
  queueSharedSettingsPersist(normalized);
  emitSettings(klona(normalized));
  return klona(normalized);
}

export function persistSettingsDraft(nextSettings: EwSettings) {
  const draft = klona(nextSettings);
  cachedSettings = draft;
  persistLocalSettings(draft);
  queueSharedSettingsPersist(draft);
}

export function patchSettings(partial: Partial<EwSettings>): EwSettings {
  // 使用展开运算符（浅合并）替代 _.merge，避免按索引合并数组导致的数据损坏。
  // _.merge 在新数组较短时会保留旧数组的条目。
  const current = getSettings();
  const merged: EwSettings = { ...current, ...partial };
  return replaceSettings(merged);
}

export function subscribeSettings(listener: SettingsListener): { stop: () => void } {
  settingsListeners.add(listener);
  return { stop: () => settingsListeners.delete(listener) };
}

export function loadLastRun(): RunSummary | null {
  const storage = readScriptStorage();
  const parsed = RunSummarySchema.safeParse(storage.last_run);
  cachedLastRun = parsed.success ? parsed.data : null;
  return cachedLastRun ? klona(cachedLastRun) : null;
}

export function getLastRun(): RunSummary | null {
  if (cachedLastRun === undefined) {
    return loadLastRun();
  }
  return cachedLastRun ? klona(cachedLastRun) : null;
}

export function setLastRun(summary: RunSummary) {
  const normalized = RunSummarySchema.parse(summary);
  cachedLastRun = normalized;
  writeScriptStorage(previous => {
    const byChat = normalizeRunRecordMap(previous);
    if (normalized.chat_id.trim()) {
      byChat[normalized.chat_id.trim()] = normalized;
    }
    return {
      ...previous,
      last_run: normalized,
      last_run_by_chat: trimDebugRecordMap(byChat, MAX_DEBUG_RECORD_CHATS),
    };
  });
  emitRun(klona(normalized));
}

export function subscribeLastRun(listener: RunListener): { stop: () => void } {
  runListeners.add(listener);
  return { stop: () => runListeners.delete(listener) };
}

export function loadLastIo(): LastIoSummary | null {
  const storage = readScriptStorage();
  const parsed = LastIoSummarySchema.safeParse(storage.last_io);
  cachedLastIo = parsed.success ? sanitizeLastIoSummary(parsed.data) : null;
  return cachedLastIo ? klona(cachedLastIo) : null;
}

export function getLastIo(): LastIoSummary | null {
  if (cachedLastIo === undefined) {
    return loadLastIo();
  }
  return cachedLastIo ? klona(cachedLastIo) : null;
}

export function setLastIo(summary: LastIoSummary) {
  const normalized = sanitizeLastIoSummary(LastIoSummarySchema.parse(summary));
  cachedLastIo = normalized;
  writeScriptStorage(previous => {
    const byChat = normalizeIoRecordMap(previous);
    if (normalized.chat_id.trim()) {
      byChat[normalized.chat_id.trim()] = normalized;
    }
    return {
      ...previous,
      last_io: normalized,
      last_io_by_chat: trimDebugRecordMap(byChat, MAX_DEBUG_RECORD_CHATS),
    };
  });
  emitIo(klona(normalized));
}

export function subscribeLastIo(listener: IoListener): { stop: () => void } {
  ioListeners.add(listener);
  return { stop: () => ioListeners.delete(listener) };
}

export function loadLastRunForChat(chatId: string): RunSummary | null {
  const normalizedChatId = String(chatId ?? '').trim();
  if (!normalizedChatId) {
    return loadLastRun();
  }

  const storage = readScriptStorage();
  const byChat = normalizeRunRecordMap(storage);
  const summary = byChat[normalizedChatId] ?? null;
  if (summary) {
    cachedLastRun = summary;
    return klona(summary);
  }

  const globalSummary = RunSummarySchema.safeParse(storage.last_run);
  if (globalSummary.success && globalSummary.data.chat_id.trim() === normalizedChatId) {
    cachedLastRun = globalSummary.data;
    return klona(globalSummary.data);
  }

  return null;
}

export function loadLastIoForChat(chatId: string): LastIoSummary | null {
  const normalizedChatId = String(chatId ?? '').trim();
  if (!normalizedChatId) {
    return loadLastIo();
  }

  const storage = readScriptStorage();
  const byChat = normalizeIoRecordMap(storage);
  const summary = byChat[normalizedChatId] ?? null;
  if (summary) {
    cachedLastIo = summary;
    return klona(summary);
  }

  const globalSummary = LastIoSummarySchema.safeParse(storage.last_io);
  if (globalSummary.success && globalSummary.data.chat_id.trim() === normalizedChatId) {
    cachedLastIo = sanitizeLastIoSummary(globalSummary.data);
    return klona(cachedLastIo);
  }

  return null;
}

export function saveControllerBackup(
  chatId: string,
  worldbookName: string,
  controllerContent: ControllerEntrySnapshot[],
) {
  const MAX_BACKUPS = 10;
  writeScriptStorage(previous => {
    const backups = { ...(previous.backups ?? {}) };
    backups[chatId] = {
      at: Date.now(),
      worldbook_name: worldbookName,
      controller_content: controllerContent,
    };

    // CR-4: LRU 淘汰 —— 仅保留最近的 MAX_BACKUPS 条记录。
    const entries = Object.entries(backups);
    if (entries.length > MAX_BACKUPS) {
      entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
      const keysToRemove = entries.slice(MAX_BACKUPS).map(e => e[0]);
      for (const key of keysToRemove) {
        delete backups[key];
      }
    }

    return { ...previous, backups };
  });
}

export function readControllerBackup(
  chatId: string,
): { at: number; worldbook_name: string; controller_content: ControllerEntrySnapshot[] } | null {
  const storage = readScriptStorage();
  const backup = storage.backups?.[chatId];
  if (!backup) return null;

  const content = backup.controller_content;
  let controllers: ControllerEntrySnapshot[] = [];
  if (Array.isArray(content)) {
    controllers = content
      .filter(entry => entry && typeof entry === 'object')
      .map(entry => ({
        entry_name: String((entry as ControllerEntrySnapshot).entry_name ?? ''),
        content: String((entry as ControllerEntrySnapshot).content ?? ''),
        flow_id: (entry as ControllerEntrySnapshot).flow_id,
        flow_name: (entry as ControllerEntrySnapshot).flow_name,
        legacy: Boolean((entry as ControllerEntrySnapshot).legacy),
      }))
      .filter(entry => entry.content);
  } else if (typeof content === 'string') {
    controllers = content ? [{ entry_name: '', content, flow_name: 'Legacy Controller', legacy: true }] : [];
  } else if (content && typeof content === 'object') {
    controllers = Object.entries(content).map(([entryName, value]) => ({
      entry_name: entryName,
      content: String(value ?? ''),
    }));
  }

  return klona({ at: backup.at, worldbook_name: backup.worldbook_name, controller_content: controllers });
}

export function clearControllerBackup(chatId: string) {
  writeScriptStorage(previous => {
    const backups = { ...(previous.backups ?? {}) };
    delete backups[chatId];
    return { ...previous, backups };
  });
}
