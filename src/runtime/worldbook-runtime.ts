import { getCurrentCharacter, getCurrentCharacterName } from './compat/character';
import { getCharWorldbookNames, getWorldbook, type WbEntry } from './compat/worldbook';
import { DynSnapshot, DynWorldbookProfile, DynWorldbookProfileSchema, DynWriteConfig, EwSettings } from './types';
import { createWorkflowRuntimeError } from './workflow-error';
import { assertWorkflowSupport } from './workflow-support';

export type TargetWorldbook = {
  worldbook_name: string;
  entries: WbEntry[];
  created: boolean;
};

export type FullWorldbookContext = {
  character_name: string;
  character_description: string;
  char_worldbook: {
    worldbook_name: string;
    entries: Array<{ name: string; enabled: boolean; content: string }>;
  };
};

function toEntrySnapshot(entries: WbEntry[]): Array<{ name: string; enabled: boolean; content: string }> {
  return entries.map(entry => ({
    name: entry.name,
    enabled: entry.enabled,
    content: entry.content,
  }));
}

function normalizePositionRole(raw: unknown): DynWorldbookProfile['position']['role'] {
  return raw === 'user' || raw === 'assistant' ? raw : 'system';
}

function normalizeSecondaryLogic(raw: unknown): DynWorldbookProfile['strategy']['keys_secondary']['logic'] {
  return raw === 'and_all' || raw === 'not_any' || raw === 'not_all' ? raw : 'and_any';
}

function normalizeScanDepth(raw: unknown): DynWorldbookProfile['strategy']['scan_depth'] {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return 'same_as_global';
}

function normalizeNullableInt(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

export function getDefaultDynWorldbookProfile(): DynWorldbookProfile {
  return DynWorldbookProfileSchema.parse({});
}

export function extractDynWorldbookProfile(raw: any): DynWorldbookProfile {
  return DynWorldbookProfileSchema.parse({
    comment: typeof raw?.comment === 'string' ? raw.comment : '',
    position: raw?.position
      ? {
          type:
            typeof raw.position.type === 'string' && raw.position.type.trim()
              ? raw.position.type.trim()
              : 'before_character_definition',
          role: normalizePositionRole(raw.position.role),
          depth: Math.max(0, Math.trunc(Number(raw.position.depth ?? 0) || 0)),
          order: Math.trunc(Number(raw.position.order ?? 100) || 100),
        }
      : undefined,
    strategy: raw?.strategy
      ? {
          type: typeof raw.strategy.type === 'string' && raw.strategy.type.trim() ? raw.strategy.type.trim() : 'constant',
          keys: Array.isArray(raw.strategy.keys)
            ? raw.strategy.keys.map((value: unknown) => String(value ?? '').trim()).filter(Boolean)
            : [],
          keys_secondary: {
            logic: normalizeSecondaryLogic(raw.strategy.keys_secondary?.logic),
            keys: Array.isArray(raw.strategy.keys_secondary?.keys)
              ? raw.strategy.keys_secondary.keys.map((value: unknown) => String(value ?? '').trim()).filter(Boolean)
              : [],
          },
          scan_depth: normalizeScanDepth(raw.strategy.scan_depth),
        }
      : undefined,
    probability: Number.isFinite(Number(raw?.probability)) ? Number(raw.probability) : undefined,
    effect: raw?.effect
      ? {
          sticky: normalizeNullableInt(raw.effect.sticky),
          cooldown: normalizeNullableInt(raw.effect.cooldown),
          delay: normalizeNullableInt(raw.effect.delay),
        }
      : undefined,
    extra: raw?.extra
      ? {
          caseSensitive: Boolean(raw.extra.caseSensitive),
          matchWholeWords: Boolean(raw.extra.matchWholeWords),
          group: typeof raw.extra.group === 'string' ? raw.extra.group : '',
          groupOverride: Boolean(raw.extra.groupOverride),
          groupWeight: Number.isFinite(Number(raw.extra.groupWeight)) ? Number(raw.extra.groupWeight) : 100,
          useGroupScoring: Boolean(raw.extra.useGroupScoring),
        }
      : undefined,
  });
}

export function normalizeDynSnapshotData(raw: any): DynSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const name = String(raw.name ?? '').trim();
  if (!name) {
    return null;
  }

  const profile = extractDynWorldbookProfile(raw);
  return {
    name,
    content: String(raw.content ?? ''),
    enabled: Boolean(raw.enabled),
    ...profile,
  };
}

export function buildDynSnapshotFromEntry(entry: any): DynSnapshot {
  const normalized = normalizeDynSnapshotData({
    name: entry?.name,
    content: entry?.content,
    enabled: entry?.enabled,
    comment: entry?.comment,
    position: entry?.position,
    strategy: entry?.strategy,
    probability: entry?.probability,
    effect: entry?.effect,
    extra: entry?.extra,
  });

  if (!normalized) {
    return {
      name: String(entry?.name ?? '').trim(),
      content: String(entry?.content ?? ''),
      enabled: Boolean(entry?.enabled),
      ...getDefaultDynWorldbookProfile(),
    };
  }

  return normalized;
}

export function applyDynSnapshotToEntry(entry: WbEntry, snapshot: DynSnapshot): void {
  const normalized = normalizeDynSnapshotData(snapshot);
  if (!normalized) {
    return;
  }

  entry.name = normalized.name;
  entry.content = normalized.content;
  entry.enabled = normalized.enabled;
  entry.comment = normalized.comment;
  entry.position = {
    type: normalized.position.type,
    role: normalized.position.role,
    depth: normalized.position.depth,
    order: normalized.position.order,
  };
  entry.strategy = {
    type: normalized.strategy.type,
    keys: [...normalized.strategy.keys],
    keys_secondary: {
      logic: normalized.strategy.keys_secondary.logic,
      keys: [...normalized.strategy.keys_secondary.keys],
    },
    scan_depth: normalized.strategy.scan_depth,
  };
  entry.probability = normalized.probability;
  entry.effect = {
    sticky: normalized.effect.sticky,
    cooldown: normalized.effect.cooldown,
    delay: normalized.effect.delay,
  };
  entry.extra = {
    caseSensitive: normalized.extra.caseSensitive,
    matchWholeWords: normalized.extra.matchWholeWords,
    group: normalized.extra.group,
    groupOverride: normalized.extra.groupOverride,
    groupWeight: normalized.extra.groupWeight,
    useGroupScoring: normalized.extra.useGroupScoring,
  };
}

export function applyDynWriteConfigToEntry(entry: WbEntry, name: string, content: string, dynWrite: DynWriteConfig): void {
  applyDynSnapshotToEntry(entry, {
    name,
    content,
    enabled: dynWrite.activation_mode === 'worldbook_direct',
    ...dynWrite.profile,
  });
}

export function createDynEntryFromWriteConfig(
  name: string,
  content: string,
  entries: WbEntry[],
  dynWrite: DynWriteConfig,
): WbEntry {
  const entry = ensureDefaultEntry(name, content, dynWrite.activation_mode === 'worldbook_direct', entries);
  applyDynWriteConfigToEntry(entry, name, content, dynWrite);
  return entry;
}

export function createDynEntryFromSnapshot(snapshot: DynSnapshot, entries: WbEntry[]): WbEntry {
  const normalized = normalizeDynSnapshotData(snapshot);
  if (!normalized) {
    return ensureDefaultEntry(String(snapshot?.name ?? ''), String(snapshot?.content ?? ''), Boolean(snapshot?.enabled), entries);
  }

  const entry = ensureDefaultEntry(normalized.name, normalized.content, normalized.enabled, entries);
  applyDynSnapshotToEntry(entry, normalized);
  return entry;
}

async function resolveLegacyWorldbookHint(candidateNames: string[], charName: string): Promise<string> {
  const trimmedCharName = charName.trim();
  if (!trimmedCharName) {
    return '';
  }

  const legacyName = `EW_${trimmedCharName}`;
  if (candidateNames.includes(legacyName)) {
    return '';
  }

  try {
    await getWorldbook(legacyName);
    return ` 检测到历史自动世界书 "${legacyName}" 存在，但当前角色未绑定它；插件不会再自动重绑，请手动绑定后再执行。`;
  } catch {
    return '';
  }
}

export async function resolveTargetWorldbook(_settings: EwSettings): Promise<TargetWorldbook> {
  assertWorkflowSupport();
  const charWb = getCharWorldbookNames();
  const candidateNames = _.uniq([...(charWb.primary ? [charWb.primary] : []), ...(charWb.additional ?? [])]);

  for (const wbName of candidateNames) {
    try {
      const entries = await getWorldbook(wbName);
      return { worldbook_name: wbName, entries, created: false };
    } catch (error) {
      console.debug(`[Evolution World] Bound worldbook "${wbName}" failed to load:`, error);
    }
  }

  const charName = getCurrentCharacterName() ?? '';
  const legacyHint = await resolveLegacyWorldbookHint(candidateNames, charName);
  throw createWorkflowRuntimeError('worldbook_missing', 'commit', {
    message: `当前角色没有可写的已绑定世界书，请先在角色卡绑定世界书。${legacyHint}`.trim(),
    detail: `character=${charName || 'unknown'}; bound_worldbooks=${candidateNames.join(', ') || '(none)'}`,
  });
}

export async function getFullWorldbookContext(preloadedTarget?: TargetWorldbook): Promise<FullWorldbookContext> {
  const charName = getCurrentCharacterName() ?? '';
  let charDescription = '';

  try {
    const character = getCurrentCharacter();
    charDescription = character?.description ?? '';
  } catch (error) {
    console.debug('[Evolution World] character data unavailable:', error);
  }

  let charEntries: Array<{ name: string; enabled: boolean; content: string }> = [];
  let charWbName = '';

  if (preloadedTarget) {
    charWbName = preloadedTarget.worldbook_name;
    charEntries = toEntrySnapshot(preloadedTarget.entries);
  } else {
    try {
      const charWb = getCharWorldbookNames();
      charWbName = charWb.primary ?? '';
      if (charWb.primary) {
        charEntries = toEntrySnapshot(await getWorldbook(charWb.primary));
      }
    } catch (error) {
      console.debug('[Evolution World] cannot read target worldbook context:', error);
    }
  }

  return {
    character_name: charName,
    character_description: charDescription,
    char_worldbook: {
      worldbook_name: charWbName,
      entries: charEntries,
    },
  };
}

function nextUid(entries: WbEntry[]): number {
  const maxUid = _.max(entries.map(entry => entry.uid));
  return (maxUid ?? 0) + 1;
}

export function ensureDefaultEntry(
  name: string,
  content: string,
  enabled: boolean,
  entries: WbEntry[],
  _constant = false,
): WbEntry {
  return {
    uid: nextUid(entries),
    name,
    enabled,
    strategy: {
      type: 'constant',
      keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: {
      type: 'before_character_definition',
      role: 'system',
      depth: 0,
      order: 100,
    },
    content,
    probability: 100,
    recursion: {
      prevent_incoming: true,
      prevent_outgoing: true,
      delay_until: null,
    },
    effect: {
      sticky: null,
      cooldown: null,
      delay: null,
    },
    extra: {},
  };
}
