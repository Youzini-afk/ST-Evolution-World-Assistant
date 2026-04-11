/**
 * 角色卡绑定工作流 — 读写模块
 *
 * 将工作流配置序列化到角色卡世界书的 `EW/Flows` 条目中，
 * 使工作流随角色卡导出/导入。
 *
 * 数据安全：EW/Flows 条目中不存储 API 密钥 / URL / headers，
 * 但会保留 api_preset_id，用于在刷新后继续绑定到同一个全局 API 预设。
 */

import { getCurrentCharacterName } from './compat/character';
import { replaceWorldbook } from './compat/worldbook';
import { simpleHash } from './helpers';
import { EwFlowConfig, EwFlowConfigSchema, EwSettings } from './types';
import { ensureDefaultEntry, resolveTargetWorldbook } from './worldbook-runtime';
import { klona } from 'klona';

/** 角色卡工作流在世界书中的条目名称 */
export const CHAR_FLOWS_ENTRY_NAME = 'EW/Flows';
const CHAR_FLOW_DRAFT_STORAGE_PREFIX = 'ew_char_flow_draft:';

/** 角色卡工作流 JSON 包装格式 */
interface CharFlowsPayload {
  ew_char_flows: true;
  flows: unknown[];
}

/** 写入 EW/Flows 时排除的字段（敏感 / 仅本地） */
const EXCLUDED_FIELDS = new Set(['api_url', 'api_key', 'headers_json']);

function normalizeFlowName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeCharDraftName(name: string): string {
  return name.trim();
}

function getCharFlowDraftStorageKey(charName: string): string | null {
  const normalizedName = normalizeCharDraftName(charName);
  if (!normalizedName) {
    return null;
  }
  return `${CHAR_FLOW_DRAFT_STORAGE_PREFIX}${normalizedName}`;
}

function sanitizeFlow(flow: EwFlowConfig): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flow)) {
    if (!EXCLUDED_FIELDS.has(key)) {
      obj[key] = value;
    }
  }
  return obj;
}

function normalizeLoadedFlowIds(flows: EwFlowConfig[], source: string): EwFlowConfig[] {
  const usedIds = new Set<string>();
  return flows.map((flow, index) => {
    const rawId = String(flow.id ?? '').trim();
    const baseId = rawId || `flow_${index + 1}_${simpleHash(`${source}:${index}:${flow.name || 'flow'}`)}`;
    let nextId = baseId;
    let counter = 2;
    while (usedIds.has(nextId)) {
      nextId = `${baseId}__${counter}`;
      counter += 1;
    }
    usedIds.add(nextId);

    if (nextId === flow.id) {
      return flow;
    }

    console.warn(`[Evolution World] normalized duplicate char flow id "${flow.id}" -> "${nextId}" (${source})`);
    return EwFlowConfigSchema.parse({
      ...flow,
      id: nextId,
    });
  });
}

export function readCharFlowDraft(charName: string): EwFlowConfig[] | null {
  const storageKey = getCharFlowDraftStorageKey(charName);
  if (!storageKey) {
    return null;
  }

  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 'ew-char-flow-draft/v1' || !Array.isArray(parsed.flows)) {
      return null;
    }

    const flows: EwFlowConfig[] = [];
    for (const item of parsed.flows) {
      flows.push(EwFlowConfigSchema.parse(item));
    }
    return normalizeLoadedFlowIds(flows, 'char-flow-draft');
  } catch (error) {
    console.warn('[Evolution World] Failed to read char flow draft cache:', error);
    return null;
  }
}

export function writeCharFlowDraft(charName: string, flows: EwFlowConfig[]): void {
  const storageKey = getCharFlowDraftStorageKey(charName);
  if (!storageKey) {
    return;
  }

  try {
    const payload = {
      version: 'ew-char-flow-draft/v1',
      updated_at: Date.now(),
      flows: flows.map(sanitizeFlow),
    };
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(payload));
  } catch (error) {
    console.warn('[Evolution World] Failed to write char flow draft cache:', error);
  }
}

export function clearCharFlowDraft(charName: string): void {
  const storageKey = getCharFlowDraftStorageKey(charName);
  if (!storageKey) {
    return;
  }

  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch (error) {
    console.warn('[Evolution World] Failed to clear char flow draft cache:', error);
  }
}

export async function readCharFlows(settings: EwSettings): Promise<EwFlowConfig[]> {
  try {
    const target = await resolveTargetWorldbook(settings);
    const entry = target.entries.find(e => e.name === CHAR_FLOWS_ENTRY_NAME);
    if (!entry) return [];

    const parsed: unknown = JSON.parse(entry.content);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as any).ew_char_flows !== true ||
      !Array.isArray((parsed as any).flows)
    ) {
      return [];
    }

    const defaultPresetId = settings.api_presets[0]?.id ?? '';
    const presetIds = new Set(settings.api_presets.map(preset => preset.id));
    const globalPresetIdByName = new Map(
      settings.flows
        .map(flow => [normalizeFlowName(flow.name), flow.api_preset_id])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    const result: EwFlowConfig[] = [];

    for (const raw of (parsed as CharFlowsPayload).flows) {
      try {
        const flow = EwFlowConfigSchema.parse(raw);
        if (!flow.api_preset_id || !presetIds.has(flow.api_preset_id)) {
          const recoveredPresetId = globalPresetIdByName.get(normalizeFlowName(flow.name));
          if (recoveredPresetId && presetIds.has(recoveredPresetId)) {
            flow.api_preset_id = recoveredPresetId;
          } else if (defaultPresetId) {
            flow.api_preset_id = defaultPresetId;
          }
        }
        result.push(flow);
      } catch {
        console.warn('[Evolution World] skipped invalid char flow entry');
      }
    }

    return normalizeLoadedFlowIds(result, 'char-flows');
  } catch (error) {
    console.debug('[Evolution World] readCharFlows failed:', error);
    return [];
  }
}

export async function writeCharFlows(settings: EwSettings, flows: EwFlowConfig[]): Promise<void> {
  const target = await resolveTargetWorldbook(settings);

  const payload: CharFlowsPayload = {
    ew_char_flows: true,
    flows: flows.map(sanitizeFlow),
  };
  const content = JSON.stringify(payload, null, 2);

  const nextEntries = klona(target.entries);
  const existing = nextEntries.find(e => e.name === CHAR_FLOWS_ENTRY_NAME);

  if (existing) {
    existing.content = content;
    existing.enabled = false;
  } else {
    const newEntry = ensureDefaultEntry(CHAR_FLOWS_ENTRY_NAME, content, false, nextEntries, true);
    nextEntries.push(newEntry);
  }

  await replaceWorldbook(target.worldbook_name, nextEntries, { render: 'debounced' });
}

const CHAR_FLOW_PRIORITY_BOOST = 1000;

export async function getEffectiveFlows(settings: EwSettings): Promise<EwFlowConfig[]> {
  const globalFlows = settings.flows.filter(f => f.enabled);

  let charFlows: EwFlowConfig[];
  try {
    const currentCharName = String(getCurrentCharacterName?.() ?? '').trim();
    const draftFlows = currentCharName ? readCharFlowDraft(currentCharName) : null;
    charFlows = (draftFlows ?? (await readCharFlows(settings))).filter(f => f.enabled);
  } catch {
    charFlows = [];
  }

  if (charFlows.length === 0) return globalFlows;

  const charFlowIds = new Set(charFlows.map(f => f.id));
  const charFlowNames = new Set(charFlows.map(f => f.name.trim().toLowerCase()));

  const filteredGlobal = globalFlows.filter(
    f => !charFlowIds.has(f.id) && !charFlowNames.has(f.name.trim().toLowerCase()),
  );

  const boostedChar = charFlows.map(f => ({
    ...f,
    priority: f.priority + CHAR_FLOW_PRIORITY_BOOST,
  }));

  const merged = [...filteredGlobal, ...boostedChar];
  merged.sort((a, b) => b.priority - a.priority);
  return merged;
}
