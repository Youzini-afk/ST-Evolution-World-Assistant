import {
  getChatId,
  getChatMessages,
  getCurrentCharacterName,
  getLastMessageId,
  setChatMessages,
} from './compat/character';
import {
  EVENT_CHAT_CHANGED,
  EVENT_MESSAGE_DELETED,
  EVENT_MESSAGE_EDITED,
  EVENT_MESSAGE_SWIPED,
  EVENT_MESSAGE_UPDATED,
  onEvent,
  type StopFn,
} from './compat/events';
import { replaceWorldbook } from './compat/worldbook';
import { buildMessageVersionKey, getMessageVersionInfo, resolveControllerSnapshotEntryName } from './helpers';
import {
  buildChatFingerprint,
  buildFileName,
  buildFilePrefix,
  buildLegacyFileName,
  buildLegacyFilePrefix,
  buildSnapshotStoreOwner,
  cleanupSnapshotFiles,
  deleteSnapshot,
  hasSnapshotStorePayload,
  readSnapshotStore,
  writeSnapshot,
  writeSnapshotStore,
  type SnapshotData,
  type SnapshotStoreOwner,
  type SnapshotVersionStore,
} from './snapshot-storage';
import { ControllerEntrySnapshot, DynSnapshot, EwSettings } from './types';
export type { DynSnapshot } from './types';
import { isMvuExtraAnalysisGuardActive } from './state';
import { createWorkflowRuntimeError } from './workflow-error';
import {
  applyDynSnapshotToEntry,
  buildDynSnapshotFromEntry,
  createDynEntryFromSnapshot,
  ensureDefaultEntry,
  normalizeDynSnapshotData,
  resolveTargetWorldbook,
} from './worldbook-runtime';

const EW_FLOOR_DATA_KEY = 'ew_entries';
const EW_CONTROLLER_DATA_KEY = 'ew_controller';
const EW_CONTROLLERS_DATA_KEY = 'ew_controllers';
const EW_DYN_SNAPSHOTS_KEY = 'ew_dyn_snapshots';
const EW_SNAPSHOT_FILE_KEY = 'ew_snapshot_file';
const EW_SWIPE_ID_KEY = 'ew_snapshot_swipe_id';
const EW_CONTENT_HASH_KEY = 'ew_snapshot_content_hash';
const EW_INLINE_SNAPSHOT_VERSIONS_KEY = 'ew_snapshot_versions';
const EW_FLOOR_WORKFLOW_EXECUTION_KEY = 'ew_workflow_execution';
const EW_WORKFLOW_REPLAY_CAPSULE_KEY = 'ew_workflow_replay_capsule';
const EW_BEFORE_REPLY_BINDING_KEY = 'ew_before_reply_binding';

export type FloorSnapshotReadResolution =
  | 'exact'
  | 'single_fallback'
  | 'same_swipe_fallback'
  | 'latest_fallback'
  | 'missing';

export type LatestSnapshotsResult = {
  controllers: ControllerEntrySnapshot[];
  dyn: Map<string, DynSnapshot>;
  resolution: FloorSnapshotReadResolution;
  source: 'file' | 'inline' | 'none';
  matched_version_key?: string;
  file_name?: string;
  message_id?: number;
};

type SnapshotReadMode = 'strict' | 'history';

type SnapshotVersionSource = {
  source: 'file' | 'inline';
  versions: Record<string, SnapshotData>;
  fileName?: string;
};

type SnapshotReadResult = {
  snapshot: SnapshotData | null;
  resolution: FloorSnapshotReadResolution;
  available_version_count: number;
  source: 'file' | 'inline' | 'none';
  matched_version_key?: string;
  file_name?: string;
};

function normalizeDynSnapshot(snapshot: DynSnapshot): DynSnapshot {
  const normalized = normalizeDynSnapshotData(snapshot);
  if (normalized) {
    return normalized;
  }

  return {
    name: String(snapshot?.name ?? '').trim(),
    content: String(snapshot?.content ?? ''),
    enabled: Boolean(snapshot?.enabled),
    comment: '',
    position: {
      type: 'before_character_definition',
      role: 'system',
      depth: 0,
      order: 100,
    },
    strategy: {
      type: 'constant',
      keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    probability: 100,
    effect: {
      sticky: null,
      cooldown: null,
      delay: null,
    },
    extra: {
      caseSensitive: false,
      matchWholeWords: false,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      useGroupScoring: false,
    },
  };
}

function normalizeControllerSnapshot(snapshot: ControllerEntrySnapshot): ControllerEntrySnapshot {
  return {
    entry_name: String(snapshot.entry_name ?? '').trim(),
    content: String(snapshot.content ?? ''),
    flow_id: snapshot.flow_id ? String(snapshot.flow_id) : undefined,
    flow_name: snapshot.flow_name ? String(snapshot.flow_name) : undefined,
    legacy: Boolean(snapshot.legacy),
  };
}

function controllerSnapshotKey(snapshot: ControllerEntrySnapshot): string {
  return String(snapshot.flow_id ?? snapshot.entry_name ?? snapshot.flow_name ?? 'legacy');
}

function isSnapshotResolutionUnsafeForDestructiveWrite(
  resolution: FloorSnapshotReadResolution | undefined,
): boolean {
  return resolution === 'latest_fallback';
}

function assertSnapshotResolutionSafeForDestructiveWrite(
  resolution: FloorSnapshotReadResolution | undefined,
  context: {
    operation: string;
    messageId?: number;
    matchedVersionKey?: string;
    fileName?: string;
  },
): void {
  if (!isSnapshotResolutionUnsafeForDestructiveWrite(resolution)) {
    return;
  }

  throw createWorkflowRuntimeError('snapshot_resolution_unsafe', 'commit', {
    message: '当前仅命中最新回退快照，已阻止危险写回。',
    summary: '当前只命中了最新回退快照，已阻止危险写回。',
    detail:
      `操作=${context.operation}；` +
      `楼层=${context.messageId ?? -1}；` +
      `匹配版本=${context.matchedVersionKey ?? '(none)'}；` +
      `快照文件=${context.fileName ?? '(none)'}`,
  });
}

export function isSnapshotResolutionUnsafeForDestructiveWriteForTest(
  resolution: FloorSnapshotReadResolution | undefined,
): boolean {
  return isSnapshotResolutionUnsafeForDestructiveWrite(resolution);
}

const floorBindingListenerStops: StopFn[] = [];
const observedMessageVersionKeys = new Map<number, string>();
let floorBindingRestoreTimer: ReturnType<typeof setTimeout> | null = null;
const localizationInFlightByChatKey = new Map<string, Promise<SnapshotLocalizationResult>>();
const localizationSignatureByChatKey = new Map<string, string>();

function scheduleFloorBindingRestore(getSettings: () => EwSettings, delayMs: number): void {
  if (floorBindingRestoreTimer) {
    clearTimeout(floorBindingRestoreTimer);
  }

  floorBindingRestoreTimer = setTimeout(() => {
    floorBindingRestoreTimer = null;

    const freshSettings = getSettings();
    if (!freshSettings.enabled || !freshSettings.floor_binding_enabled) {
      return;
    }

    void onChatChanged(freshSettings);
  }, delayMs);
}

function clearInlineSnapshotFields(data: Record<string, unknown>) {
  delete data[EW_CONTROLLER_DATA_KEY];
  delete data[EW_CONTROLLERS_DATA_KEY];
  delete data[EW_DYN_SNAPSHOTS_KEY];
  delete data[EW_SWIPE_ID_KEY];
  delete data[EW_CONTENT_HASH_KEY];
  delete data[EW_INLINE_SNAPSHOT_VERSIONS_KEY];
}

function clearFloorSnapshotFields(data: Record<string, unknown>) {
  delete data[EW_FLOOR_DATA_KEY];
  clearInlineSnapshotFields(data);
  delete data[EW_SNAPSHOT_FILE_KEY];
}

// ── Context Helpers ──────────────────────────────────────────

function getCharName(): string {
  return getCurrentCharacterName() ?? 'unknown';
}

function refreshObservedMessageVersions(): void {
  observedMessageVersionKeys.clear();
  const lastId = getLastMessageId();
  if (lastId < 0) {
    return;
  }

  const allMessages = getChatMessages(`0-${lastId}`);
  for (const msg of allMessages) {
    observedMessageVersionKeys.set(msg.message_id, getMessageVersionInfo(msg).version_key);
  }
}

function shouldReactToVisibleVersionMutation(messageId: number): boolean {
  const msg = getChatMessages(messageId)[0];
  if (!msg) {
    return false;
  }

  const nextVersionKey = getMessageVersionInfo(msg).version_key;
  const prevVersionKey = observedMessageVersionKeys.get(messageId);
  observedMessageVersionKeys.set(messageId, nextVersionKey);
  return prevVersionKey !== nextVersionKey;
}

function shouldSkipRestoreForMvuExtraAnalysis(hookName: string): boolean {
  if (!isMvuExtraAnalysisGuardActive()) {
    return false;
  }

  console.debug(
    `[Evolution World] floor binding restore skipped: MVU extra analysis guard active (${hookName})`,
  );
  return true;
}

function hasSnapshotMetadataHints(msg: any): boolean {
  const data = (msg?.data ?? {}) as Record<string, unknown>;
  return Boolean(
    data[EW_SNAPSHOT_FILE_KEY] ||
    data[EW_INLINE_SNAPSHOT_VERSIONS_KEY] ||
    data[EW_CONTROLLER_DATA_KEY] ||
    data[EW_CONTROLLERS_DATA_KEY] ||
    data[EW_DYN_SNAPSHOTS_KEY] ||
    data[EW_SWIPE_ID_KEY] !== undefined ||
    data[EW_CONTENT_HASH_KEY],
  );
}

function getMessageSnapshotFileCandidates(msg: any): string[] {
  const candidates: string[] = [];
  const explicit = _.get(msg.data, EW_SNAPSHOT_FILE_KEY);
  if (typeof explicit === 'string' && explicit.trim()) {
    candidates.push(explicit.trim());
  }

  const messageId = Number(msg?.message_id);
  if (hasSnapshotMetadataHints(msg) && Number.isFinite(messageId) && messageId >= 0) {
    const inferred = buildFileName(getCharName(), getChatId(), messageId);
    if (inferred && !candidates.includes(inferred)) {
      candidates.push(inferred);
    }

    const inferredLegacy = buildLegacyFileName(getCharName(), getChatId(), messageId);
    if (inferredLegacy && !candidates.includes(inferredLegacy)) {
      candidates.push(inferredLegacy);
    }
  }

  return candidates;
}

function isSnapshotFileNamedForCurrentChat(fileName: string): boolean {
  const normalized = String(fileName ?? '').trim();
  if (!normalized) {
    return false;
  }
  const expectedPrefix = buildFilePrefix(getCharName(), getChatId());
  const legacyPrefix = buildLegacyFilePrefix(getCharName(), getChatId());
  return normalized.startsWith(expectedPrefix) || normalized.startsWith(legacyPrefix);
}

function isSnapshotOwnerMatchingCurrentChat(owner: SnapshotStoreOwner | undefined): boolean {
  if (!owner) {
    return false;
  }

  const expected = buildSnapshotStoreOwner(getCharName(), getChatId());
  return (
    owner.char_name === expected.char_name &&
    owner.chat_id === expected.chat_id &&
    owner.chat_fingerprint === expected.chat_fingerprint
  );
}

function isSnapshotStoreOwnedByCurrentChat(fileName: string, store: SnapshotVersionStore | null | undefined): boolean {
  const nameOwned = isSnapshotFileNamedForCurrentChat(fileName);
  if (!nameOwned) {
    return false;
  }

  if (!store?.owner) {
    return nameOwned;
  }

  return nameOwned && isSnapshotOwnerMatchingCurrentChat(store.owner);
}

function buildSnapshotReadResult(
  source: SnapshotVersionSource | null,
  resolution: FloorSnapshotReadResolution,
  snapshot: SnapshotData | null,
  matchedVersionKey?: string,
): SnapshotReadResult {
  const availableVersionCount = source ? Object.keys(source.versions).length : 0;
  return {
    snapshot,
    resolution,
    available_version_count: availableVersionCount,
    source: source?.source ?? 'none',
    matched_version_key: matchedVersionKey,
    file_name: source?.fileName,
  };
}

function getVersionEntries(versions: Record<string, SnapshotData>): Array<[string, SnapshotData]> {
  return Object.entries(versions) as Array<[string, SnapshotData]>;
}

function selectSnapshotFromSources(
  sources: SnapshotVersionSource[],
  versionInfo: ReturnType<typeof getMessageVersionInfo>,
  mode: SnapshotReadMode,
): SnapshotReadResult {
  for (const source of sources) {
    const exact = source.versions[versionInfo.version_key];
    if (exact) {
      return buildSnapshotReadResult(source, 'exact', exact, versionInfo.version_key);
    }
  }

  if (mode === 'strict') {
    return buildSnapshotReadResult(null, 'missing', null);
  }

  for (const source of sources) {
    const entries = getVersionEntries(source.versions);
    if (entries.length === 1) {
      const [matchedVersionKey, snapshot] = entries[0];
      return buildSnapshotReadResult(source, 'single_fallback', snapshot, matchedVersionKey);
    }
  }

  for (const source of sources) {
    const entries = getVersionEntries(source.versions);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [matchedVersionKey, snapshot] = entries[i];
      if (Number(snapshot?.swipe_id ?? -1) === versionInfo.swipe_id) {
        return buildSnapshotReadResult(source, 'same_swipe_fallback', snapshot, matchedVersionKey);
      }
    }
  }

  for (const source of sources) {
    const entries = getVersionEntries(source.versions);
    if (entries.length > 0) {
      const [matchedVersionKey, snapshot] = entries[entries.length - 1];
      return buildSnapshotReadResult(source, 'latest_fallback', snapshot, matchedVersionKey);
    }
  }

  return buildSnapshotReadResult(null, 'missing', null);
}

async function loadSnapshotVersionSources(msg: any): Promise<SnapshotVersionSource[]> {
  const sources: SnapshotVersionSource[] = [];

  for (const fileName of getMessageSnapshotFileCandidates(msg)) {
    const store = await readSnapshotStore(fileName);
    if (!store || Object.keys(store.versions).length === 0) {
      continue;
    }

    sources.push({
      source: 'file',
      versions: store.versions,
      fileName,
    });
  }

  const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
  if (Object.keys(inlineVersions).length > 0) {
    sources.push({
      source: 'inline',
      versions: inlineVersions,
    });
  }

  return sources;
}

async function readSnapshotForMessageDetailed(msg: any, mode: SnapshotReadMode): Promise<SnapshotReadResult> {
  const sources = await loadSnapshotVersionSources(msg);
  if (sources.length === 0) {
    return buildSnapshotReadResult(null, 'missing', null);
  }

  return selectSnapshotFromSources(sources, getMessageVersionInfo(msg), mode);
}

async function readSnapshotForMessage(msg: any): Promise<SnapshotData | null> {
  return (await readSnapshotForMessageDetailed(msg, 'strict')).snapshot;
}

function isEmptySnapshotPayload(snapshot: SnapshotData | null | undefined): boolean {
  if (!snapshot) {
    return false;
  }
  return (snapshot.controllers?.length ?? 0) === 0 && (snapshot.dyn_entries?.length ?? 0) === 0;
}

export async function repairCurrentChatSuspiciousEmptySnapshots(): Promise<{ repaired: number; warnings: string[] }> {
  const warnings: string[] = [];
  let repaired = 0;
  const lastId = getLastMessageId();
  if (lastId < 0) {
    return { repaired, warnings };
  }

  const allMessages = getChatMessages(`0-${lastId}`);
  for (const msg of allMessages) {
    if (String(msg?.role ?? '') !== 'assistant') {
      continue;
    }

    const versionInfo = getMessageVersionInfo(msg);
    const currentVersionKey = versionInfo.version_key;
    const sources = await loadSnapshotVersionSources(msg);
    if (sources.length === 0) {
      continue;
    }

    const exactEmptySources = sources.filter(source => isEmptySnapshotPayload(source.versions[currentVersionKey]));
    if (exactEmptySources.length === 0) {
      continue;
    }

    const executionVersionKey = buildFloorExecutionVersionKey(versionInfo);
    const executionPresence = await getExecutionPresenceForVersion(msg, executionVersionKey);
    if (executionPresence.exact || !executionPresence.has_any) {
      continue;
    }

    const fallbackSources = sources
      .map(source => {
        if (!source.versions[currentVersionKey]) {
          return source;
        }
        const nextVersions = { ...source.versions };
        delete nextVersions[currentVersionKey];
        return {
          ...source,
          versions: nextVersions,
        };
      })
      .filter(source => Object.keys(source.versions).length > 0);

    if (fallbackSources.length === 0) {
      continue;
    }

    const fallbackReadResult = selectSnapshotFromSources(fallbackSources, versionInfo, 'history');
    if (!fallbackReadResult.snapshot || isEmptySnapshotPayload(fallbackReadResult.snapshot)) {
      continue;
    }

    const nextData: Record<string, unknown> = {
      ...(msg.data ?? {}),
    };
    let mutated = false;

    const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
    if (isEmptySnapshotPayload(inlineVersions[currentVersionKey])) {
      delete inlineVersions[currentVersionKey];
      mutated = true;
      if (Object.keys(inlineVersions).length > 0) {
        writeInlineSnapshotVersions(nextData, inlineVersions);
      } else {
        delete nextData[EW_INLINE_SNAPSHOT_VERSIONS_KEY];
      }
    }

    for (const source of exactEmptySources) {
      if (source.source !== 'file' || !source.fileName) {
        continue;
      }

      try {
        const store = await readSnapshotStore(source.fileName);
        if (!store || !isEmptySnapshotPayload(store.versions[currentVersionKey])) {
          continue;
        }

        delete store.versions[currentVersionKey];
        if (hasSnapshotStorePayload(store)) {
          await writeSnapshotStore(source.fileName, store);
        } else {
          await deleteSnapshot(source.fileName);
        }
        mutated = true;
      } catch (error) {
        warnings.push(
          `message #${msg.message_id} file ${source.fileName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!mutated) {
      continue;
    }

    nextData[EW_SWIPE_ID_KEY] = versionInfo.swipe_id;
    if (versionInfo.content_hash) {
      nextData[EW_CONTENT_HASH_KEY] = versionInfo.content_hash;
    } else {
      delete nextData[EW_CONTENT_HASH_KEY];
    }

    const explicitFileName =
      typeof nextData[EW_SNAPSHOT_FILE_KEY] === 'string' ? String(nextData[EW_SNAPSHOT_FILE_KEY]).trim() : '';
    if (explicitFileName) {
      const explicitStore = await readSnapshotStore(explicitFileName);
      if (!explicitStore || !hasSnapshotStorePayload(explicitStore)) {
        delete nextData[EW_SNAPSHOT_FILE_KEY];
      }
    }

    await setChatMessages([{ message_id: msg.message_id, data: nextData }], { refresh: 'none' });
    repaired += 1;
  }

  if (warnings.length > 0) {
    console.warn('[Evolution World] suspicious empty snapshot repair warnings:', warnings);
  }

  return { repaired, warnings };
}

export async function pinMessageSnapshotToCurrentVersion(messageId: number): Promise<boolean> {
  const msg = getChatMessages(messageId)[0];
  if (!msg) {
    return false;
  }

  const versionInfo = getMessageVersionInfo(msg);
  const currentVersionKey = versionInfo.version_key;
  const readResult = await readSnapshotForMessageDetailed(msg, 'history');
  if (!readResult.snapshot || readResult.source === 'none') {
    return false;
  }

  const nextData: Record<string, unknown> = {
    ...(msg.data ?? {}),
  };
  let mutated = false;

  const syncVisibleVersionMetadata = () => {
    if (Number(nextData[EW_SWIPE_ID_KEY] ?? -1) !== versionInfo.swipe_id) {
      nextData[EW_SWIPE_ID_KEY] = versionInfo.swipe_id;
      mutated = true;
    }

    const currentHash = typeof nextData[EW_CONTENT_HASH_KEY] === 'string' ? String(nextData[EW_CONTENT_HASH_KEY]) : '';
    const targetHash = String(versionInfo.content_hash ?? '').trim();
    if (currentHash !== targetHash) {
      if (targetHash) {
        nextData[EW_CONTENT_HASH_KEY] = targetHash;
      } else {
        delete nextData[EW_CONTENT_HASH_KEY];
      }
      mutated = true;
    }
  };

  if (readResult.source === 'file' && readResult.file_name) {
    const currentFileRef =
      typeof nextData[EW_SNAPSHOT_FILE_KEY] === 'string' ? String(nextData[EW_SNAPSHOT_FILE_KEY]).trim() : '';
    const sourceFileName = String(readResult.file_name).trim();
    const sourceStore = await readSnapshotStore(sourceFileName);
    if (!sourceStore) {
      return false;
    }

    const isOwnedByCurrentChat = isSnapshotStoreOwnedByCurrentChat(sourceFileName, sourceStore);
    const writableFileName = isOwnedByCurrentChat
      ? sourceFileName
      : buildFileName(getCharName(), getChatId(), messageId);
    const writableStore: SnapshotVersionStore = {
      version: sourceStore.version,
      updated_at: Date.now(),
      versions: { ...sourceStore.versions },
      workflow_execution: { ...sourceStore.workflow_execution },
      replay_capsules: { ...sourceStore.replay_capsules },
      owner: buildSnapshotStoreOwner(getCharName(), getChatId()),
    };
    if (readResult.resolution !== 'exact') {
      writableStore.versions[currentVersionKey] = {
        ...readResult.snapshot,
        swipe_id: versionInfo.swipe_id,
        content_hash: versionInfo.content_hash,
      };
      mutated = true;
    }

    if (!isOwnedByCurrentChat || readResult.resolution !== 'exact') {
      await writeSnapshotStore(writableFileName, writableStore);
      mutated = true;
    }

    if (currentFileRef !== writableFileName) {
      nextData[EW_SNAPSHOT_FILE_KEY] = writableFileName;
      mutated = true;
    }

    syncVisibleVersionMetadata();
  } else if (readResult.source === 'inline') {
    const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
    if (!inlineVersions[currentVersionKey]) {
      inlineVersions[currentVersionKey] = {
        ...readResult.snapshot,
        swipe_id: versionInfo.swipe_id,
        content_hash: versionInfo.content_hash,
      };
      writeInlineSnapshotVersions(nextData, inlineVersions);
      mutated = true;
    }

    syncVisibleVersionMetadata();
  }

  if (!mutated) {
    return false;
  }

  observedMessageVersionKeys.set(messageId, currentVersionKey);
  await setChatMessages([{ message_id: messageId, data: nextData }], { refresh: 'none' });
  return true;
}

export type FloorSnapshotRebindResult = {
  migrated: boolean;
  source_message_id: number;
  target_message_id: number;
  source_version_key?: string;
  target_version_key?: string;
  reason?: string;
};

/**
 * Rebind one floor's snapshot payload from source message to target message.
 *
 * This is used by before_reply interception:
 * - source: user floor (where before_reply commit originally landed)
 * - target: assistant floor (the final UX anchor for history / reroll)
 *
 * Behavior:
 * - copies only the resolved source snapshot payload to target current version
 * - removes only the matched source-version binding from source floor
 * - does not perform destructive full-floor cleanup
 */
export async function rebindFloorSnapshotToMessage(
  settings: EwSettings,
  sourceMessageId: number,
  targetMessageId: number,
): Promise<FloorSnapshotRebindResult> {
  if (sourceMessageId === targetMessageId) {
    return {
      migrated: false,
      source_message_id: sourceMessageId,
      target_message_id: targetMessageId,
      reason: 'same_message',
    };
  }

  const sourceMsg = getChatMessages(sourceMessageId)[0];
  const targetMsg = getChatMessages(targetMessageId)[0];
  if (!sourceMsg || !targetMsg) {
    return {
      migrated: false,
      source_message_id: sourceMessageId,
      target_message_id: targetMessageId,
      reason: 'message_not_found',
    };
  }

  const sourceVersionInfo = getMessageVersionInfo(sourceMsg);
  const targetVersionInfo = getMessageVersionInfo(targetMsg);
  const sourceReadResult = await readSnapshotForMessageDetailed(sourceMsg, 'strict');
  if (!sourceReadResult.snapshot) {
    return {
      migrated: false,
      source_message_id: sourceMessageId,
      target_message_id: targetMessageId,
      source_version_key: sourceVersionInfo.version_key,
      target_version_key: targetVersionInfo.version_key,
      reason: 'source_snapshot_missing',
    };
  }

  const sourceSnapshot = sourceReadResult.snapshot;
  const dynSnapshots = sourceSnapshot.dyn_entries
    .filter(snapshot => snapshot.name && typeof snapshot.content === 'string')
    .map(normalizeDynSnapshot);
  const controllerSnapshots = sourceSnapshot.controllers
    .map(normalizeControllerSnapshot)
    .filter(entry => entry.content);

  await markFloorEntries(
    settings,
    targetMessageId,
    dynSnapshots.map(entry => entry.name),
    controllerSnapshots,
    dynSnapshots,
    targetVersionInfo.swipe_id,
    targetVersionInfo.content_hash,
  );

  const cleanupSwipeId =
    typeof sourceSnapshot.swipe_id === 'number' ? sourceSnapshot.swipe_id : Number(sourceVersionInfo.swipe_id ?? 0);
  const cleanupContentHash =
    typeof sourceSnapshot.content_hash === 'string'
      ? sourceSnapshot.content_hash
      : String(sourceVersionInfo.content_hash ?? '');

  await markFloorEntries(settings, sourceMessageId, [], [], [], cleanupSwipeId, cleanupContentHash);

  return {
    migrated: true,
    source_message_id: sourceMessageId,
    target_message_id: targetMessageId,
    source_version_key: sourceReadResult.matched_version_key ?? sourceVersionInfo.version_key,
    target_version_key: targetVersionInfo.version_key,
  };
}

export type SnapshotLocalizationResult = {
  localized: number;
  uplifted: number;
  unresolved: number;
  skipped: number;
  mutated_messages: number;
  warnings: string[];
};

type FloorWorkflowExecutionVersionedMap = Record<string, Record<string, unknown>>;

function buildFloorExecutionVersionKey(state: { swipe_id?: number; content_hash?: string }): string {
  return `sw:${Math.max(0, Math.trunc(Number(state.swipe_id ?? 0) || 0))}|${String(state.content_hash ?? '').trim()}`;
}

function normalizeFloorWorkflowExecutionMap(raw: unknown): FloorWorkflowExecutionVersionedMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  if (
    Array.isArray(obj.attempted_flow_ids) ||
    Array.isArray(obj.failed_flow_ids) ||
    Array.isArray(obj.successful_results) ||
    typeof obj.request_id === 'string'
  ) {
    const versionKey = buildFloorExecutionVersionKey({
      swipe_id: Number(obj.swipe_id ?? 0),
      content_hash: String(obj.content_hash ?? '').trim(),
    });
    return {
      [versionKey]: { ...obj },
    };
  }

  const map: FloorWorkflowExecutionVersionedMap = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      map[key] = { ...(value as Record<string, unknown>) };
    }
  }
  return map;
}

function resolveExecutionEntryForMessage(msg: any): {
  map: FloorWorkflowExecutionVersionedMap;
  key: string;
  state: Record<string, unknown>;
} | null {
  const map = normalizeFloorWorkflowExecutionMap(msg?.data?.[EW_FLOOR_WORKFLOW_EXECUTION_KEY]);
  const versionInfo = getMessageVersionInfo(msg);
  const versionKey = buildFloorExecutionVersionKey(versionInfo);
  const exact = map[versionKey];
  if (exact) {
    return {
      map,
      key: versionKey,
      state: { ...exact },
    };
  }

  const entries = Object.entries(map);
  if (entries.length === 1) {
    const [key, state] = entries[0];
    return {
      map,
      key,
      state: { ...state },
    };
  }

  return null;
}

async function getExecutionPresenceForVersion(
  msg: any,
  versionKey: string,
): Promise<{ exact: boolean; has_any: boolean }> {
  const inlineMap = normalizeFloorWorkflowExecutionMap(msg?.data?.[EW_FLOOR_WORKFLOW_EXECUTION_KEY]);
  if (inlineMap[versionKey]) {
    return { exact: true, has_any: true };
  }

  let hasAny = Object.keys(inlineMap).length > 0;
  for (const fileName of getMessageSnapshotFileCandidates(msg)) {
    const store = await readSnapshotStore(fileName);
    if (!store) {
      continue;
    }
    const externalMap = normalizeFloorWorkflowExecutionMap(store.workflow_execution);
    if (externalMap[versionKey]) {
      return { exact: true, has_any: true };
    }
    if (Object.keys(externalMap).length > 0) {
      hasAny = true;
    }
  }

  return { exact: false, has_any: hasAny };
}

async function migrateExecutionBetweenMessages(
  sourceMessageId: number,
  targetMessageId: number,
): Promise<{ migrated: boolean; reason?: string }> {
  if (sourceMessageId === targetMessageId) {
    return { migrated: false, reason: 'same_message' };
  }

  const sourceMsg = getChatMessages(sourceMessageId)[0];
  const targetMsg = getChatMessages(targetMessageId)[0];
  if (!sourceMsg || !targetMsg) {
    return { migrated: false, reason: 'message_not_found' };
  }

  const sourceResolved = resolveExecutionEntryForMessage(sourceMsg);
  if (!sourceResolved) {
    return { migrated: false, reason: 'source_execution_missing' };
  }

  const sourceMap = { ...sourceResolved.map };
  const targetMap = normalizeFloorWorkflowExecutionMap(targetMsg?.data?.[EW_FLOOR_WORKFLOW_EXECUTION_KEY]);
  const targetVersionInfo = getMessageVersionInfo(targetMsg);
  const targetVersionKey = buildFloorExecutionVersionKey(targetVersionInfo);
  let mutated = false;

  if (!targetMap[targetVersionKey]) {
    targetMap[targetVersionKey] = {
      ...sourceResolved.state,
      swipe_id: targetVersionInfo.swipe_id,
      content_hash: targetVersionInfo.content_hash,
    };
    mutated = true;
  }

  if (sourceMap[sourceResolved.key]) {
    delete sourceMap[sourceResolved.key];
    mutated = true;
  }

  if (!mutated) {
    return { migrated: false, reason: 'already_migrated' };
  }

  const sourceNextData: Record<string, unknown> = {
    ...(sourceMsg.data ?? {}),
  };
  if (Object.keys(sourceMap).length > 0) {
    sourceNextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY] = sourceMap;
  } else {
    delete sourceNextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY];
  }

  const targetNextData: Record<string, unknown> = {
    ...(targetMsg.data ?? {}),
    [EW_FLOOR_WORKFLOW_EXECUTION_KEY]: targetMap,
  };

  await setChatMessages(
    [
      { message_id: sourceMessageId, data: sourceNextData },
      { message_id: targetMessageId, data: targetNextData },
    ],
    { refresh: 'none' },
  );
  return { migrated: true };
}

async function writeBindingMetaPair(
  sourceMessageId: number,
  targetMessageId: number,
  requestId: string,
): Promise<void> {
  const sourceMsg = getChatMessages(sourceMessageId)[0];
  const targetMsg = getChatMessages(targetMessageId)[0];
  if (!sourceMsg || !targetMsg) {
    return;
  }

  const migratedAt = Date.now();
  const sourceNextData: Record<string, unknown> = {
    ...(sourceMsg.data ?? {}),
    [EW_BEFORE_REPLY_BINDING_KEY]: {
      role: 'source',
      paired_message_id: targetMessageId,
      request_id: requestId,
      migrated_at: migratedAt,
    },
  };
  const targetNextData: Record<string, unknown> = {
    ...(targetMsg.data ?? {}),
    [EW_BEFORE_REPLY_BINDING_KEY]: {
      role: 'assistant_anchor',
      paired_message_id: sourceMessageId,
      request_id: requestId,
      migrated_at: migratedAt,
    },
  };

  await setChatMessages(
    [
      { message_id: sourceMessageId, data: sourceNextData },
      { message_id: targetMessageId, data: targetNextData },
    ],
    { refresh: 'none' },
  );
}

async function markLegacyUserAnchor(messageId: number, reason: string): Promise<void> {
  const msg = getChatMessages(messageId)[0];
  if (!msg) {
    return;
  }

  const nextData: Record<string, unknown> = {
    ...(msg.data ?? {}),
    [EW_BEFORE_REPLY_BINDING_KEY]: {
      role: 'legacy_user_anchor',
      reason,
      marked_at: Date.now(),
    },
  };
  await setChatMessages([{ message_id: messageId, data: nextData }], { refresh: 'none' });
}

function buildLocalizationSignature(messages: any[]): string {
  return messages
    .map(msg => {
      const fileRef =
        typeof msg?.data?.[EW_SNAPSHOT_FILE_KEY] === 'string' ? String(msg.data[EW_SNAPSHOT_FILE_KEY]) : '';
      const bindingRole =
        typeof msg?.data?.[EW_BEFORE_REPLY_BINDING_KEY]?.role === 'string'
          ? String(msg.data[EW_BEFORE_REPLY_BINDING_KEY].role)
          : '';
      return `${msg.message_id}:${msg.role ?? ''}:${fileRef}:${bindingRole}`;
    })
    .join('|');
}

export async function localizeSnapshotsForCurrentChat(settings: EwSettings): Promise<SnapshotLocalizationResult> {
  const chatId = getChatId();
  const charName = getCharName();
  const ownershipKey = `${charName}::${chatId}::${buildChatFingerprint(chatId)}`;
  const existingTask = localizationInFlightByChatKey.get(ownershipKey);
  if (existingTask) {
    return existingTask;
  }

  const runTask = (async (): Promise<SnapshotLocalizationResult> => {
    const result: SnapshotLocalizationResult = {
      localized: 0,
      uplifted: 0,
      unresolved: 0,
      skipped: 0,
      mutated_messages: 0,
      warnings: [],
    };

    const lastId = getLastMessageId();
    if (lastId < 0) {
      localizationSignatureByChatKey.set(ownershipKey, '');
      return result;
    }

    const readStoreCache = new Map<string, SnapshotVersionStore | null>();
    const readStoreCached = async (fileName: string): Promise<SnapshotVersionStore | null> => {
      const key = String(fileName ?? '').trim();
      if (!key) {
        return null;
      }
      if (readStoreCache.has(key)) {
        return readStoreCache.get(key) ?? null;
      }
      const store = await readSnapshotStore(key);
      readStoreCache.set(key, store);
      return store;
    };

    let allMessages = getChatMessages(`0-${lastId}`);
    const previousSignature = localizationSignatureByChatKey.get(ownershipKey);
    const nextSignature = buildLocalizationSignature(allMessages);

    const localizedUpdates: Array<{ message_id: number; data: Record<string, unknown> }> = [];
    for (const msg of allMessages) {
      const snapshotFile =
        typeof msg?.data?.[EW_SNAPSHOT_FILE_KEY] === 'string' ? String(msg.data[EW_SNAPSHOT_FILE_KEY]) : '';
      const normalizedFile = snapshotFile.trim();
      if (!normalizedFile) {
        result.skipped += 1;
        continue;
      }

      const store = await readStoreCached(normalizedFile);
      if (!store) {
        result.unresolved += 1;
        result.warnings.push(`message #${msg.message_id}: snapshot file missing "${normalizedFile}"`);
        continue;
      }

      if (isSnapshotStoreOwnedByCurrentChat(normalizedFile, store)) {
        result.skipped += 1;
        continue;
      }

      const localizedFileName = buildFileName(charName, chatId, Number(msg.message_id));
      const localizedStore: SnapshotVersionStore = {
        version: store.version,
        updated_at: Date.now(),
        versions: { ...store.versions },
        workflow_execution: { ...store.workflow_execution },
        replay_capsules: { ...store.replay_capsules },
        owner: buildSnapshotStoreOwner(charName, chatId),
      };
      await writeSnapshotStore(localizedFileName, localizedStore);
      localizedUpdates.push({
        message_id: msg.message_id,
        data: {
          ...(msg.data ?? {}),
          [EW_SNAPSHOT_FILE_KEY]: localizedFileName,
        },
      });
      result.localized += 1;
    }

    if (localizedUpdates.length > 0) {
      await setChatMessages(localizedUpdates, { refresh: 'none' });
      result.mutated_messages += localizedUpdates.length;
      allMessages = getChatMessages(`0-${lastId}`);
    }

    const snapshotReadCache = new Map<number, SnapshotReadResult>();
    const readSnapshotCached = async (messageId: number): Promise<SnapshotReadResult> => {
      if (snapshotReadCache.has(messageId)) {
        return snapshotReadCache.get(messageId)!;
      }
      const message = getChatMessages(messageId)[0];
      if (!message) {
        const missing = buildSnapshotReadResult(null, 'missing', null);
        snapshotReadCache.set(messageId, missing);
        return missing;
      }
      const readResult = await readSnapshotForMessageDetailed(message, 'strict');
      snapshotReadCache.set(messageId, readResult);
      return readResult;
    };

    for (let i = 0; i < allMessages.length; i++) {
      const source = getChatMessages(allMessages[i].message_id)[0] ?? allMessages[i];
      if (source?.role !== 'user') {
        continue;
      }

      const sourceSnapshotRead = await readSnapshotCached(source.message_id);
      const sourceExecution = resolveExecutionEntryForMessage(source);
      const sourceHasArtifacts = Boolean(sourceSnapshotRead.snapshot || sourceExecution);
      if (!sourceHasArtifacts) {
        continue;
      }

      const next = allMessages[i + 1];
      if (!next || next.role !== 'assistant') {
        await markLegacyUserAnchor(source.message_id, 'missing_adjacent_assistant');
        result.skipped += 1;
        continue;
      }

      const target = getChatMessages(next.message_id)[0] ?? next;
      const targetSnapshotRead = await readSnapshotCached(target.message_id);
      const targetExecution = resolveExecutionEntryForMessage(target);
      const targetHasArtifacts = Boolean(targetSnapshotRead.snapshot || targetExecution);
      if (targetHasArtifacts) {
        continue;
      }

      let snapshotMigrated = false;
      if (sourceSnapshotRead.snapshot) {
        const snapshotMove = await rebindFloorSnapshotToMessage(settings, source.message_id, target.message_id);
        snapshotMigrated = snapshotMove.migrated;
      }

      let executionMigrated = false;
      if (sourceExecution) {
        const executionMove = await migrateExecutionBetweenMessages(source.message_id, target.message_id);
        executionMigrated = executionMove.migrated;
      }

      if (snapshotMigrated || executionMigrated) {
        await writeBindingMetaPair(source.message_id, target.message_id, 'auto-localize');
        snapshotReadCache.delete(source.message_id);
        snapshotReadCache.delete(target.message_id);
        result.uplifted += 1;
        result.mutated_messages += 2;
      } else {
        await markLegacyUserAnchor(source.message_id, 'adjacent_assistant_uplift_failed');
        result.skipped += 1;
      }
    }

    if (previousSignature && previousSignature === nextSignature && result.localized === 0 && result.uplifted === 0) {
      result.skipped += allMessages.length;
    }
    localizationSignatureByChatKey.set(ownershipKey, buildLocalizationSignature(getChatMessages(`0-${lastId}`)));

    if (result.unresolved > 0) {
      console.warn(
        `[Evolution World] snapshot localization unresolved=${result.unresolved} for chat ${chatId}`,
        result.warnings,
      );
    }

    return result;
  })();

  localizationInFlightByChatKey.set(ownershipKey, runTask);
  try {
    return await runTask;
  } finally {
    localizationInFlightByChatKey.delete(ownershipKey);
  }
}

// ── Legacy upgrade helpers ───────────────────────────────────

/**
 * Read inline snapshot fields from message data, handling both legacy (single
 * controller string) and new (controllers record) formats.
 */
function readLegacyInlineSnapshot(data: Record<string, unknown>): SnapshotData | null {
  const snapshots = _.get(data, EW_DYN_SNAPSHOTS_KEY) as DynSnapshot[] | undefined;

  const controllersArray = _.get(data, EW_CONTROLLERS_DATA_KEY) as ControllerEntrySnapshot[] | undefined;
  const inlineSwipeId = typeof data[EW_SWIPE_ID_KEY] === 'number' ? (data[EW_SWIPE_ID_KEY] as number) : undefined;
  const inlineContentHash =
    typeof data[EW_CONTENT_HASH_KEY] === 'string' ? (data[EW_CONTENT_HASH_KEY] as string) : undefined;
  if (Array.isArray(controllersArray)) {
    return {
      controllers: controllersArray.map(normalizeControllerSnapshot).filter(entry => entry.content),
      dyn_entries: Array.isArray(snapshots) ? snapshots : [],
      swipe_id: inlineSwipeId,
      content_hash: inlineContentHash,
    };
  }

  const controllersRaw = _.get(data, EW_CONTROLLERS_DATA_KEY) as Record<string, string> | undefined;
  if (controllersRaw && typeof controllersRaw === 'object' && !Array.isArray(controllersRaw)) {
    return {
      controllers: Object.entries(controllersRaw).map(([key, value]) =>
        normalizeControllerSnapshot({
          entry_name: key.startsWith('EW/Controller/') ? key : '',
          flow_name: key.startsWith('EW/Controller/') ? undefined : key,
          content: String(value ?? ''),
          legacy: key === 'legacy',
        }),
      ),
      dyn_entries: Array.isArray(snapshots) ? snapshots : [],
      swipe_id: inlineSwipeId,
      content_hash: inlineContentHash,
    };
  }

  const ctrlSnap = _.get(data, EW_CONTROLLER_DATA_KEY) as string | undefined;
  if ((Array.isArray(snapshots) && snapshots.length > 0) || (typeof ctrlSnap === 'string' && ctrlSnap.length > 0)) {
    return {
      controllers: ctrlSnap
        ? [
            normalizeControllerSnapshot({
              entry_name: '',
              flow_name: 'Legacy Controller',
              content: ctrlSnap,
              legacy: true,
            }),
          ]
        : [],
      dyn_entries: Array.isArray(snapshots) ? snapshots : [],
      swipe_id: inlineSwipeId,
      content_hash: inlineContentHash,
    };
  }

  return null;
}

function normalizeInlineSnapshotVersions(raw: unknown): Record<string, SnapshotData> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const versions: Record<string, SnapshotData> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const upgraded = value as SnapshotData;
    versions[String(key)] = {
      controllers: Array.isArray(upgraded.controllers)
        ? upgraded.controllers.map(normalizeControllerSnapshot).filter(entry => entry.content)
        : [],
      dyn_entries: Array.isArray(upgraded.dyn_entries) ? upgraded.dyn_entries : [],
      swipe_id: typeof upgraded.swipe_id === 'number' ? upgraded.swipe_id : undefined,
      content_hash: typeof upgraded.content_hash === 'string' ? upgraded.content_hash : undefined,
    };
  }
  return versions;
}

function readInlineSnapshotVersions(data: Record<string, unknown>): Record<string, SnapshotData> {
  const rawVersions = data[EW_INLINE_SNAPSHOT_VERSIONS_KEY];
  const normalized = normalizeInlineSnapshotVersions(rawVersions);
  if (Object.keys(normalized).length > 0) {
    return normalized;
  }

  const legacy = readLegacyInlineSnapshot(data);
  if (!legacy) {
    return {};
  }

  return {
    [buildMessageVersionKey(Number(legacy.swipe_id ?? 0), String(legacy.content_hash ?? '').trim())]: legacy,
  };
}

function readInlineSnapshot(data: Record<string, unknown>, versionKey?: string): SnapshotData | null {
  const versions = readInlineSnapshotVersions(data);
  if (versionKey) {
    return versions[versionKey] ?? null;
  }

  const values = Object.values(versions);
  return values.length === 1 ? values[0] : null;
}

void readInlineSnapshot;

function writeInlineSnapshotVersions(nextData: Record<string, unknown>, versions: Record<string, SnapshotData>) {
  nextData[EW_INLINE_SNAPSHOT_VERSIONS_KEY] = versions;
}

function buildSnapshotStoreFromVersions(versions: Record<string, SnapshotData>): SnapshotVersionStore {
  return {
    version: 'ew-message-store/v3',
    updated_at: Date.now(),
    versions: { ...versions },
    workflow_execution: {},
    replay_capsules: {},
    owner: buildSnapshotStoreOwner(getCharName(), getChatId()),
  };
}

// ── Floor Marking ────────────────────────────────────────────

/**
 * Mark floor entries: write snapshot data to the appropriate storage backend.
 *
 * - message_data mode: snapshots stored directly in msg.data
 * - file mode: snapshots written to ST server file, msg.data stores filename reference
 */
export async function markFloorEntries(
  settings: EwSettings,
  messageId: number,
  entryNames: string[],
  controllerSnapshots?: ControllerEntrySnapshot[],
  dynSnapshots?: DynSnapshot[],
  swipeId?: number,
  contentHash?: string,
  options?: {
    persist_empty_snapshot?: boolean;
  },
): Promise<void> {
  const messages = getChatMessages(messageId);
  if (messages.length === 0) {
    console.warn(`[Evolution World] markFloorEntries: message #${messageId} not found, snapshot DROPPED`);
    return;
  }

  const msg = messages[0];
  const previousSnapshotFile = _.get(msg.data, EW_SNAPSHOT_FILE_KEY);
  const previousSnapshotFileName = typeof previousSnapshotFile === 'string' ? previousSnapshotFile.trim() : '';
  const previousSnapshotStore = previousSnapshotFileName ? await readSnapshotStore(previousSnapshotFileName) : null;
  const previousSnapshotFileOwned = previousSnapshotFileName
    ? isSnapshotStoreOwnedByCurrentChat(previousSnapshotFileName, previousSnapshotStore)
    : false;
  const currentVersionInfo = getMessageVersionInfo(msg);
  const effectiveSwipeId = Number.isFinite(currentVersionInfo.swipe_id)
    ? currentVersionInfo.swipe_id
    : Number(swipeId ?? 0);
  const effectiveContentHash = String(currentVersionInfo.content_hash ?? '').trim() || String(contentHash ?? '').trim();
  const versionKey = buildMessageVersionKey(effectiveSwipeId, effectiveContentHash);
  const normalizedEntryNames = _.uniq(entryNames.filter(name => typeof name === 'string' && name.trim()));
  const normalizedDynSnapshots = (dynSnapshots ?? [])
    .filter(snap => snap.name && typeof snap.content === 'string')
    .map(normalizeDynSnapshot);
  const normalizedControllerSnapshots = (controllerSnapshots ?? [])
    .map(snapshot =>
      normalizeControllerSnapshot({
        entry_name: snapshot.entry_name,
        content: snapshot.content,
        flow_id: snapshot.flow_id,
        flow_name: snapshot.flow_name,
      }),
    )
    .filter(snapshot => snapshot.content);
  const hasSnapshotPayload = Boolean(
    normalizedControllerSnapshots.length > 0 || normalizedDynSnapshots.length > 0 || normalizedEntryNames.length > 0,
  );
  const shouldPersistSnapshot = hasSnapshotPayload || Boolean(options?.persist_empty_snapshot);

  const nextData: Record<string, unknown> = {
    ...msg.data,
  };
  clearFloorSnapshotFields(nextData);

  if (!shouldPersistSnapshot) {
    if (previousSnapshotFileName) {
      if (!previousSnapshotFileOwned) {
        console.info(
          `[Evolution World] markFloorEntries: skipped deleting foreign snapshot file "${previousSnapshotFileName}"`,
        );
      } else {
        const existingStore = previousSnapshotStore;
        if (existingStore) {
          delete existingStore.versions[versionKey];
          if (hasSnapshotStorePayload(existingStore)) {
            await writeSnapshotStore(previousSnapshotFileName, existingStore);
            nextData[EW_SNAPSHOT_FILE_KEY] = previousSnapshotFileName;
          } else {
            await deleteSnapshot(previousSnapshotFileName);
          }
        } else {
          await deleteSnapshot(previousSnapshotFileName);
        }
      }
    }

    const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
    if (Object.keys(inlineVersions).length > 0) {
      delete inlineVersions[versionKey];
      if (Object.keys(inlineVersions).length > 0) {
        writeInlineSnapshotVersions(nextData, inlineVersions);
      }
    }

    observedMessageVersionKeys.set(messageId, versionKey);
    await setChatMessages([{ message_id: messageId, data: nextData }], { refresh: 'none' });
    return;
  }

  if (normalizedEntryNames.length > 0) {
    nextData[EW_FLOOR_DATA_KEY] = normalizedEntryNames;
  }

  if (settings.snapshot_storage === 'file') {
    // File mode: rewrite the per-message snapshot store and pin current version in msg.data.
    const snapshotData: SnapshotData = {
      controllers: normalizedControllerSnapshots,
      dyn_entries: normalizedDynSnapshots,
      swipe_id: effectiveSwipeId,
      content_hash: effectiveContentHash,
    };
    try {
      const fileName = await writeSnapshot(getCharName(), getChatId(), messageId, snapshotData);
      nextData[EW_SNAPSHOT_FILE_KEY] = fileName;
      nextData[EW_SWIPE_ID_KEY] = effectiveSwipeId;
      if (effectiveContentHash) nextData[EW_CONTENT_HASH_KEY] = effectiveContentHash;
    } catch (e) {
      console.warn('[Evolution World] File snapshot write failed, falling back to message data:', e);
      const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
      inlineVersions[versionKey] = {
        controllers: normalizedControllerSnapshots,
        dyn_entries: normalizedDynSnapshots,
        swipe_id: effectiveSwipeId,
        content_hash: effectiveContentHash,
      };
      writeInlineSnapshotVersions(nextData, inlineVersions);
      if (previousSnapshotFileName && previousSnapshotStore && hasSnapshotStorePayload(previousSnapshotStore)) {
        nextData[EW_SNAPSHOT_FILE_KEY] = previousSnapshotFileName;
      }
      nextData[EW_SWIPE_ID_KEY] = effectiveSwipeId;
      if (effectiveContentHash) nextData[EW_CONTENT_HASH_KEY] = effectiveContentHash;
    }
  } else {
    // Message data mode: persist all known versions inline and pin current version in msg.data.
    const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
    inlineVersions[versionKey] = {
      controllers: normalizedControllerSnapshots,
      dyn_entries: normalizedDynSnapshots,
      swipe_id: effectiveSwipeId,
      content_hash: effectiveContentHash,
    };
    writeInlineSnapshotVersions(nextData, inlineVersions);
    nextData[EW_SWIPE_ID_KEY] = effectiveSwipeId;
    if (effectiveContentHash) nextData[EW_CONTENT_HASH_KEY] = effectiveContentHash;
    if (previousSnapshotFileName && previousSnapshotFileOwned) {
      if (previousSnapshotStore) {
        delete previousSnapshotStore.versions[versionKey];
        if (hasSnapshotStorePayload(previousSnapshotStore)) {
          await writeSnapshotStore(previousSnapshotFileName, previousSnapshotStore);
          nextData[EW_SNAPSHOT_FILE_KEY] = previousSnapshotFileName;
        } else {
          await deleteSnapshot(previousSnapshotFileName);
        }
      } else {
        await deleteSnapshot(previousSnapshotFileName);
      }
    }
  }

  if (versionKey !== buildMessageVersionKey(Number(swipeId ?? 0), String(contentHash ?? '').trim())) {
    console.debug(
      `[Evolution World] markFloorEntries: version source drift detected for floor #${messageId}, using current visible version ${versionKey}`,
    );
  }
  observedMessageVersionKeys.set(messageId, versionKey);
  await setChatMessages([{ message_id: messageId, data: nextData }], { refresh: 'none' });
}

function hasAnySnapshotReferences(messages: any[]): boolean {
  return messages.some(msg => {
    const data = (msg?.data ?? {}) as Record<string, unknown>;
    return Boolean(
      data[EW_SNAPSHOT_FILE_KEY] ||
      data[EW_INLINE_SNAPSHOT_VERSIONS_KEY] ||
      data[EW_CONTROLLER_DATA_KEY] ||
      data[EW_CONTROLLERS_DATA_KEY] ||
      data[EW_DYN_SNAPSHOTS_KEY],
    );
  });
}

// ── Floor Query ──────────────────────────────────────────────

/**
 * Get the EW/Dyn/ entry names bound to a specific floor.
 */
export function getFloorEntryNames(messageId: number): string[] {
  const messages = getChatMessages(messageId);
  if (messages.length === 0) {
    return [];
  }
  const entryNames = _.get(messages[0].data, EW_FLOOR_DATA_KEY, []);
  return Array.isArray(entryNames)
    ? entryNames
        .map(entry => String(entry ?? '').trim())
        .filter(Boolean)
    : [];
}

// ── Unified Snapshot Collection ──────────────────────────────

/**
 * Scan all surviving messages and return the latest snapshots.
 *
 * Checks BOTH storage backends (message data and file) so that
 * mixed-mode chats work correctly (e.g. user switched mode mid-chat).
 * The latest snapshot (by message position) wins.
 */
export async function collectLatestSnapshots(): Promise<LatestSnapshotsResult> {
  const lastId = getLastMessageId();
  if (lastId < 0) {
    return { controllers: [], dyn: new Map(), resolution: 'missing', source: 'none' };
  }

  const allMessages = getChatMessages(`0-${lastId}`);

  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    const readResult = await readSnapshotForMessageDetailed(msg, 'history');
    const snapshot = readResult.snapshot;
    if (!snapshot) {
      continue;
    }

    const dynMap = new Map<string, DynSnapshot>();
    for (const snap of snapshot.dyn_entries) {
      if (snap.name && typeof snap.content === 'string') {
        dynMap.set(snap.name, snap);
      }
    }
    return {
      controllers: snapshot.controllers.map(normalizeControllerSnapshot).filter(e => e.content),
      dyn: dynMap,
      resolution: readResult.resolution,
      source: readResult.source,
      matched_version_key: readResult.matched_version_key,
      file_name: readResult.file_name,
      message_id: msg.message_id,
    };
  }

  return { controllers: [], dyn: new Map(), resolution: 'missing', source: 'none' };
}

// ── Unified Purge + Restore ─────────────────────────────────

/**
 * Purge all EW-generated entries from worldbook, then restore from the
 * current chat's latest surviving snapshots.
 *
 * Unified handler for all CHAT_CHANGED events:
 *   Delete floor  → deleted message's snapshot gone → restores previous state (rollback)
 *   New chat      → no snapshots → clean slate
 *   Switch back   → old chat's snapshots survive → full restore
 */
export async function purgeAndRestoreForChat(settings: EwSettings): Promise<void> {
  const target = await resolveTargetWorldbook(settings);
  if (!target) {
    console.info('[Evolution World] purgeAndRestore: no worldbook available, skipping');
    return;
  }

  try {
    const repaired = await repairCurrentChatSuspiciousEmptySnapshots();
    if (repaired.repaired > 0 || repaired.warnings.length > 0) {
      console.info(
        `[Evolution World] purgeAndRestore: repaired suspicious empty snapshots=${repaired.repaired}, warnings=${repaired.warnings.length}`,
      );
    }
  } catch (error) {
    console.warn('[Evolution World] purgeAndRestore: suspicious empty snapshot repair failed:', error);
  }

  const lastId = getLastMessageId();
  const allMessages = lastId >= 0 ? getChatMessages(`0-${lastId}`) : [];
  const hasSnapshotRefs = hasAnySnapshotReferences(allMessages);

  // 安全检查：先收集快照。如果存在快照引用但当前可见版本找不到匹配快照，
  // 保持 worldbook 现状不动，避免因版本错配或文件缺失导致破坏性清除。
  const latestSnapshots = await collectLatestSnapshots();
  const { controllers: controllerSnapshots, dyn: dynSnapshots } = latestSnapshots;
  if (dynSnapshots.size === 0 && controllerSnapshots.length === 0 && hasSnapshotRefs) {
    console.info(
      '[Evolution World] purgeAndRestore: no valid snapshots found for current visible versions, keeping current worldbook state',
    );
    refreshObservedMessageVersions();
    return;
  }
  if (dynSnapshots.size > 0 || controllerSnapshots.length > 0) {
    assertSnapshotResolutionSafeForDestructiveWrite(latestSnapshots.resolution, {
      operation: 'purge_and_restore',
      messageId: latestSnapshots.message_id,
      matchedVersionKey: latestSnapshots.matched_version_key,
      fileName: latestSnapshots.file_name,
    });
  }

  // Step 1: Remove all EW/Dyn/* entries and clear all EW/Controller/* entries.
  const nextEntries = klona(target.entries).filter(entry => !entry.name.startsWith(settings.dynamic_entry_prefix));

  // Clear all existing controller entries.
  const ctrlEntries = nextEntries.filter(e => e.name.startsWith(settings.controller_entry_prefix));
  for (const entry of ctrlEntries) {
    entry.content = '';
    entry.enabled = false;
  }

  // Step 2: Restore from snapshot (already collected above).

  for (const snap of dynSnapshots.values()) {
    const normalizedSnap = normalizeDynSnapshot(snap);
    const existing = nextEntries.find(e => e.name === snap.name);
    if (existing) {
      applyDynSnapshotToEntry(existing, normalizedSnap);
    } else {
      nextEntries.push(createDynEntryFromSnapshot(normalizedSnap, nextEntries));
    }
  }

  // Restore multi-controllers.
  for (const controllerSnapshot of controllerSnapshots) {
    const entryName = resolveControllerSnapshotEntryName(settings.controller_entry_prefix, controllerSnapshot);
    const existing = nextEntries.find(e => e.name === entryName);
    if (existing) {
      existing.content = controllerSnapshot.content;
      existing.enabled = true;
    } else {
      nextEntries.push(ensureDefaultEntry(entryName, controllerSnapshot.content, true, nextEntries, true));
    }
  }

  // Step 3: Commit the cleaned + restored worldbook.
  await replaceWorldbook(target.worldbook_name, nextEntries, { render: 'debounced' });

  // Step 4: Cleanup orphaned snapshot files (file mode only).
  if (settings.snapshot_storage === 'file') {
    try {
      if (lastId >= 0) {
        const keepFiles = new Set<string>();
        const allMsgIds: number[] = [];
        for (const msg of allMessages) {
          allMsgIds.push(msg.message_id);
          const directFileName =
            typeof msg?.data?.[EW_SNAPSHOT_FILE_KEY] === 'string' ? String(msg.data[EW_SNAPSHOT_FILE_KEY]).trim() : '';
          if (directFileName) {
            keepFiles.add(directFileName);
          }
          const sources = await loadSnapshotVersionSources(msg);
          for (const source of sources) {
            if (source.source === 'file' && source.fileName) {
              keepFiles.add(source.fileName);
            }
          }
        }
        const cleaned = await cleanupSnapshotFiles(getCharName(), getChatId(), allMsgIds, keepFiles);
        if (cleaned > 0) {
          console.info(`[Evolution World] Cleaned up ${cleaned} orphaned snapshot files`);
        }
      }
    } catch (e) {
      console.warn('[Evolution World] Snapshot file cleanup failed:', e);
    }
  }

  refreshObservedMessageVersions();
  const restoredDyn = dynSnapshots.size;
  const restoredCtrl = controllerSnapshots.length;
  console.info(`[Evolution World] purgeAndRestore: ${restoredDyn} Dyn + ${restoredCtrl} Controller(s) restored`);
}

// ── 迁移 ────────────────────────────────────────────────

/**
 * Migrate snapshots between storage modes for the current chat.
 */
export async function migrateSnapshots(direction: 'to_file' | 'to_message_data'): Promise<{ migrated: number }> {
  const lastId = getLastMessageId();
  if (lastId < 0) return { migrated: 0 };

  const charName = getCharName();
  const chatId = getChatId();
  const allMessages = getChatMessages(`0-${lastId}`);
  let migrated = 0;

  if (direction === 'to_file') {
    for (const msg of allMessages) {
      const inlineVersions = readInlineSnapshotVersions(msg.data ?? {});
      const inlineVersionKeys = Object.keys(inlineVersions);
      if (inlineVersionKeys.length === 0) continue;

      const fileName = buildFileName(charName, chatId, msg.message_id);
      const store = buildSnapshotStoreFromVersions(inlineVersions);
      const existingStore = await readSnapshotStore(fileName);
      if (existingStore) {
        store.workflow_execution = { ...existingStore.workflow_execution };
        store.replay_capsules = { ...existingStore.replay_capsules };
      }
      await writeSnapshotStore(fileName, store);
      const writtenStore = await readSnapshotStore(fileName);
      const writtenVersionKeys = Object.keys(writtenStore?.versions ?? {});
      const versionCountMatches = writtenVersionKeys.length === inlineVersionKeys.length;
      const hasAllVersions = inlineVersionKeys.every(key => Boolean(writtenStore?.versions?.[key]));
      const ownerOk = isSnapshotStoreOwnedByCurrentChat(fileName, writtenStore);
      if (!writtenStore || !versionCountMatches || !hasAllVersions || !ownerOk) {
        console.warn(
          `[Evolution World] Migration to_file verification failed for floor #${msg.message_id}: expected ${inlineVersionKeys.length} versions, got ${writtenVersionKeys.length}`,
          {
            message_id: msg.message_id,
            file_name: fileName,
            expected_version_count: inlineVersionKeys.length,
            actual_version_count: writtenVersionKeys.length,
            expected_version_keys: inlineVersionKeys,
            actual_version_keys: writtenVersionKeys,
            owner_ok: ownerOk,
          },
        );
        continue;
      }

      console.debug('[Evolution World] Migration to_file verified', {
        message_id: msg.message_id,
        file_name: fileName,
        expected_version_count: inlineVersionKeys.length,
        actual_version_count: writtenVersionKeys.length,
        version_keys: writtenVersionKeys,
        owner_ok: ownerOk,
      });

      const versionInfo = getMessageVersionInfo(msg);
      const nextData: Record<string, unknown> = { ...msg.data };
      nextData[EW_SNAPSHOT_FILE_KEY] = fileName;
      nextData[EW_SWIPE_ID_KEY] = versionInfo.swipe_id;
      nextData[EW_CONTENT_HASH_KEY] = versionInfo.content_hash;
      delete nextData[EW_INLINE_SNAPSHOT_VERSIONS_KEY];
      delete nextData[EW_CONTROLLER_DATA_KEY];
      delete nextData[EW_CONTROLLERS_DATA_KEY];
      delete nextData[EW_DYN_SNAPSHOTS_KEY];

      await setChatMessages([{ message_id: msg.message_id, data: nextData }], { refresh: 'none' });
      migrated++;
    }
  } else {
    for (const msg of allMessages) {
      const snapshotFile = _.get(msg.data, EW_SNAPSHOT_FILE_KEY);
      const normalizedSnapshotFile =
        typeof snapshotFile === 'string' ? snapshotFile : undefined;
      if (!normalizedSnapshotFile) continue;

      const store = await readSnapshotStore(normalizedSnapshotFile);
      if (!store) {
        console.warn(
          `[Evolution World] Migration to_message_data skipped unreadable artifact store: ${normalizedSnapshotFile}`,
        );
        continue;
      }

      const nextData: Record<string, unknown> = { ...msg.data };
      delete nextData[EW_SNAPSHOT_FILE_KEY];
      clearInlineSnapshotFields(nextData);

      if (Object.keys(store.versions).length > 0) {
        writeInlineSnapshotVersions(nextData, store.versions);
        const versionInfo = getMessageVersionInfo(msg);
        nextData[EW_SWIPE_ID_KEY] = versionInfo.swipe_id;
        nextData[EW_CONTENT_HASH_KEY] = versionInfo.content_hash;
      }

      if (Object.keys(store.workflow_execution ?? {}).length > 0) {
        nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY] = store.workflow_execution;
      } else {
        delete nextData[EW_FLOOR_WORKFLOW_EXECUTION_KEY];
      }

      if (Object.keys(store.replay_capsules ?? {}).length > 0) {
        nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY] = store.replay_capsules;
      } else {
        delete nextData[EW_WORKFLOW_REPLAY_CAPSULE_KEY];
      }

      await setChatMessages([{ message_id: msg.message_id, data: nextData }], { refresh: 'none' });

      if (isSnapshotStoreOwnedByCurrentChat(normalizedSnapshotFile, store)) {
        await deleteSnapshot(normalizedSnapshotFile);
      }
      migrated++;
    }
  }

  console.info(`[Evolution World] Migration ${direction}: ${migrated} messages processed`);
  return { migrated };
}

// ── History: Per-Floor Snapshot Collection ───────────────────

export type FloorSnapshot = {
  messageId: number;
  snapshot: SnapshotData | null;
  resolution: FloorSnapshotReadResolution;
  available_version_count: number;
  source: 'file' | 'inline' | 'none';
  matched_version_key?: string;
  file_name?: string;
  execution?: {
    execution_status: 'executed' | 'skipped';
    skip_reason?: string;
    attempted_flow_ids: string[];
    failed_flow_ids: string[];
    workflow_failed: boolean;
  };
};

export type SnapshotDiff = {
  created: string[];
  modified: string[];
  deleted: string[];
  toggled: string[];
  controllersChanged: Record<string, 'created' | 'modified' | 'deleted'>;
};

/**
 * Collect every message's individual snapshot (not merged).
 * Returns an array ordered by messageId ascending, where each entry
 * contains the snapshot data stored at that specific floor.
 * Messages without snapshots are included with `snapshot: null`.
 */
export async function collectAllFloorSnapshots(): Promise<FloorSnapshot[]> {
  const lastId = getLastMessageId();
  if (lastId < 0) return [];

  const allMessages = getChatMessages(`0-${lastId}`);
  const result: FloorSnapshot[] = [];

  for (const msg of allMessages) {
    const readResult = await readSnapshotForMessageDetailed(msg, 'history');
    result.push({
      messageId: msg.message_id,
      snapshot: readResult.snapshot,
      resolution: readResult.resolution,
      available_version_count: readResult.available_version_count,
      source: readResult.source,
      matched_version_key: readResult.matched_version_key,
      file_name: readResult.file_name,
    });
  }

  return result;
}

export async function readFloorSnapshotByMessageId(
  messageId: number,
  mode: 'strict' | 'history' = 'history',
): Promise<FloorSnapshot | null> {
  const message = getChatMessages(messageId)[0];
  if (!message) {
    return null;
  }

  const readResult = await readSnapshotForMessageDetailed(message, mode);
  return {
    messageId,
    snapshot: readResult.snapshot,
    resolution: readResult.resolution,
    available_version_count: readResult.available_version_count,
    source: readResult.source,
    matched_version_key: readResult.matched_version_key,
    file_name: readResult.file_name,
  };
}

export type SnapshotDiffApplyResult = {
  applied: number;
  conflicts: number;
  conflict_names: string[];
};

export async function applySnapshotDiffToCurrentWorldbook(
  settings: EwSettings,
  previousSnapshotRead: FloorSnapshot | null,
  nextSnapshotRead: FloorSnapshot | null,
): Promise<SnapshotDiffApplyResult> {
  const previousSnapshot = previousSnapshotRead?.snapshot ?? null;
  const nextSnapshot = nextSnapshotRead?.snapshot ?? null;
  if (!previousSnapshot && !nextSnapshot) {
    return { applied: 0, conflicts: 0, conflict_names: [] };
  }

  if (previousSnapshotRead?.snapshot) {
    assertSnapshotResolutionSafeForDestructiveWrite(previousSnapshotRead.resolution, {
      operation: 'apply_snapshot_diff:previous',
      messageId: previousSnapshotRead.messageId,
      matchedVersionKey: previousSnapshotRead.matched_version_key,
      fileName: previousSnapshotRead.file_name,
    });
  }
  if (nextSnapshotRead?.snapshot) {
    assertSnapshotResolutionSafeForDestructiveWrite(nextSnapshotRead.resolution, {
      operation: 'apply_snapshot_diff:next',
      messageId: nextSnapshotRead.messageId,
      matchedVersionKey: nextSnapshotRead.matched_version_key,
      fileName: nextSnapshotRead.file_name,
    });
  }

  const target = await resolveTargetWorldbook(settings);
  if (!target) {
    return { applied: 0, conflicts: 0, conflict_names: [] };
  }

  const nextEntries = klona(target.entries);
  const diff = diffSnapshots(previousSnapshot, nextSnapshot);
  let applied = 0;
  let conflicts = 0;
  const conflictNames = new Set<string>();

  const previousDynByName = new Map((previousSnapshot?.dyn_entries ?? []).map(entry => [entry.name, entry]));
  const nextDynByName = new Map((nextSnapshot?.dyn_entries ?? []).map(entry => [entry.name, entry]));

  const previousCtrlByKey = new Map(
    (previousSnapshot?.controllers ?? []).map(snapshot => [
      controllerSnapshotKey(snapshot),
      normalizeControllerSnapshot(snapshot),
    ]),
  );
  const nextCtrlByKey = new Map(
    (nextSnapshot?.controllers ?? []).map(snapshot => [
      controllerSnapshotKey(snapshot),
      normalizeControllerSnapshot(snapshot),
    ]),
  );

  const dynamicUpserts = _.uniq([...diff.created, ...diff.modified, ...diff.toggled]).filter(name =>
    String(name ?? '').startsWith(settings.dynamic_entry_prefix),
  );

  for (const entryName of dynamicUpserts) {
    const desired = nextDynByName.get(entryName);
    if (!desired) {
      continue;
    }

    const existing = nextEntries.find(entry => entry.name === entryName);
    const previous = previousDynByName.get(entryName);
    const normalizedDesired = normalizeDynSnapshot(desired);
    if (existing) {
      const hasConflict = Boolean(
        previous &&
        JSON.stringify(normalizeDynSnapshot(previous)) !== JSON.stringify(normalizedDesired) &&
        JSON.stringify(buildDynSnapshotFromEntry(existing)) !== JSON.stringify(normalizedDesired),
      );
      if (hasConflict) {
        conflicts += 1;
        conflictNames.add(entryName);
        continue;
      }
      applyDynSnapshotToEntry(existing, normalizedDesired);
    } else {
      nextEntries.push(createDynEntryFromSnapshot(normalizedDesired, nextEntries));
    }
    applied += 1;
  }

  for (const entryName of diff.deleted.filter(name => String(name ?? '').startsWith(settings.dynamic_entry_prefix))) {
    const index = nextEntries.findIndex(entry => entry.name === entryName);
    if (index < 0) {
      continue;
    }

    const existing = nextEntries[index];
    const previous = previousDynByName.get(entryName);
    const hasConflict = Boolean(
      previous &&
      JSON.stringify(buildDynSnapshotFromEntry(existing)) !== JSON.stringify(normalizeDynSnapshot(previous)),
    );
    if (hasConflict) {
      conflicts += 1;
      conflictNames.add(entryName);
      continue;
    }
    nextEntries.splice(index, 1);
    applied += 1;
  }

  for (const [controllerKey, changeType] of Object.entries(diff.controllersChanged ?? {})) {
    if (changeType === 'deleted') {
      const previous = previousCtrlByKey.get(controllerKey);
      if (!previous) {
        continue;
      }
      const entryName = resolveControllerSnapshotEntryName(settings.controller_entry_prefix, previous);
      const existing = nextEntries.find(entry => entry.name === entryName);
      if (!existing) {
        continue;
      }
      if (existing.content !== previous.content) {
        conflicts += 1;
        conflictNames.add(entryName);
        continue;
      }
      existing.content = '';
      existing.enabled = false;
      applied += 1;
      continue;
    }

    const desired = nextCtrlByKey.get(controllerKey);
    if (!desired) {
      continue;
    }
    const entryName = resolveControllerSnapshotEntryName(settings.controller_entry_prefix, desired);
    const existing = nextEntries.find(entry => entry.name === entryName);
    const previous = previousCtrlByKey.get(controllerKey);
    if (existing) {
      const hasConflict = Boolean(
        previous && existing.content !== previous.content && existing.content !== desired.content,
      );
      if (hasConflict) {
        conflicts += 1;
        conflictNames.add(entryName);
        continue;
      }
      existing.content = desired.content;
      existing.enabled = true;
    } else {
      nextEntries.push(ensureDefaultEntry(entryName, desired.content, true, nextEntries, true));
    }
    applied += 1;
  }

  await replaceWorldbook(target.worldbook_name, nextEntries, { render: 'debounced' });
  return {
    applied,
    conflicts,
    conflict_names: [...conflictNames],
  };
}

/**
 * Compute the diff between two snapshots (prev → curr).
 * If prev is null, all entries in curr are "created".
 */
export function diffSnapshots(prev: SnapshotData | null, curr: SnapshotData | null): SnapshotDiff {
  const diff: SnapshotDiff = { created: [], modified: [], deleted: [], toggled: [], controllersChanged: {} };
  if (!curr) return diff;

  const prevMap = new Map<string, DynSnapshot>();
  if (prev) {
    for (const e of prev.dyn_entries) {
      prevMap.set(e.name, normalizeDynSnapshot(e));
    }
  }

  const currMap = new Map<string, DynSnapshot>();
  for (const e of curr.dyn_entries) {
    currMap.set(e.name, normalizeDynSnapshot(e));
  }

  // Find created, modified, toggled
  for (const [name, currEntry] of currMap) {
    const prevEntry = prevMap.get(name);
    if (!prevEntry) {
      diff.created.push(name);
    } else if (JSON.stringify(prevEntry) !== JSON.stringify(currEntry)) {
      diff.modified.push(name);
    }
  }

  // Find deleted
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) {
      diff.deleted.push(name);
    }
  }

  // Controller changes (multi-controller)
  const prevControllers = new Map(
    (prev?.controllers ?? []).map(snapshot => [controllerSnapshotKey(snapshot), snapshot]),
  );
  const currControllers = new Map(curr.controllers.map(snapshot => [controllerSnapshotKey(snapshot), snapshot]));
  const allCtrlKeys = new Set([...prevControllers.keys(), ...currControllers.keys()]);
  for (const key of allCtrlKeys) {
    const prevVal = prevControllers.get(key);
    const currVal = currControllers.get(key);
    if (!prevVal && currVal) {
      diff.controllersChanged[key] = 'created';
    } else if (prevVal && !currVal) {
      diff.controllersChanged[key] = 'deleted';
    } else if (prevVal?.content !== currVal?.content || prevVal?.entry_name !== currVal?.entry_name) {
      diff.controllersChanged[key] = 'modified';
    }
  }

  return diff;
}

/**
 * Rollback worldbook to the cumulative snapshot state at a given floor.
 * This means: merge all snapshots from floor 0 up to and including
 * the target messageId, then apply that state to the worldbook.
 */
export async function rollbackToFloor(settings: EwSettings, targetMessageId: number): Promise<void> {
  await restoreWorldbookFromSnapshots(settings, floor => floor.messageId <= targetMessageId);
  console.info(`[Evolution World] Rolled back to floor #${targetMessageId}`);
}

export async function rollbackBeforeFloor(settings: EwSettings, messageId: number): Promise<void> {
  // 安全检查：如果目标楼层之前没有任何快照，跳过回退，
  // 避免清空全部条目后无法恢复。
  const allFloors = await collectAllFloorSnapshots();
  const hasSnapshotBefore = allFloors.some(f => f.messageId < messageId && f.snapshot !== null);
  if (!hasSnapshotBefore) {
    console.info(`[EW] No snapshot found before floor #${messageId}, skipping rollback to preserve current state`);
    return;
  }
  await restoreWorldbookFromSnapshots(settings, floor => floor.messageId < messageId);
  console.info(`[Evolution World] Rolled back to state before floor #${messageId}`);
}

async function restoreWorldbookFromSnapshots(
  settings: EwSettings,
  predicate: (floor: FloorSnapshot) => boolean,
): Promise<void> {
  try {
    const repaired = await repairCurrentChatSuspiciousEmptySnapshots();
    if (repaired.repaired > 0 || repaired.warnings.length > 0) {
      console.info(
        `[Evolution World] restoreWorldbookFromSnapshots: repaired suspicious empty snapshots=${repaired.repaired}, warnings=${repaired.warnings.length}`,
      );
    }
  } catch (error) {
    console.warn('[Evolution World] restoreWorldbookFromSnapshots: suspicious empty snapshot repair failed:', error);
  }

  const allFloors = await collectAllFloorSnapshots();
  const dynMerged = new Map<string, DynSnapshot>();
  const controllers = new Map<string, ControllerEntrySnapshot>();

  // 在 predicate 范围内找到**最新**有快照的楼层，直接使用其完整状态。
  // 每个快照已是全量备份，跨楼层累加合并会导致被后续工作流删除的条目复活。
  let latestSnapshotFloor: FloorSnapshot | null = null;
  for (let i = allFloors.length - 1; i >= 0; i--) {
    const floor = allFloors[i];
    if (!predicate(floor)) continue;
    if (!floor.snapshot) continue;
    latestSnapshotFloor = floor;
    break;
  }

  // 核心安全防护：没有找到有效快照时，禁止破坏性写回
  if (!latestSnapshotFloor?.snapshot) {
    console.info('[EW] restoreWorldbookFromSnapshots: no matching snapshot found, skipping destructive restore');
    return;
  }
  assertSnapshotResolutionSafeForDestructiveWrite(latestSnapshotFloor.resolution, {
    operation: 'restore_from_snapshots',
    messageId: latestSnapshotFloor.messageId,
    matchedVersionKey: latestSnapshotFloor.matched_version_key,
    fileName: latestSnapshotFloor.file_name,
  });
  const latestSnapshot = latestSnapshotFloor.snapshot;

  for (const snapshot of latestSnapshot.controllers.map(normalizeControllerSnapshot)) {
    controllers.set(controllerSnapshotKey(snapshot), snapshot);
  }
  for (const snap of latestSnapshot.dyn_entries) {
    if (snap.name && typeof snap.content === 'string') {
      dynMerged.set(snap.name, snap);
    }
  }

  // Apply to worldbook (same pattern as purgeAndRestoreForChat)
  const target = await resolveTargetWorldbook(settings);
  if (!target) {
    console.info('[Evolution World] restoreWorldbookFromSnapshots: no worldbook available, skipping');
    return;
  }
  const nextEntries = klona(target.entries).filter(entry => !entry.name.startsWith(settings.dynamic_entry_prefix));

  // Clear all existing controller entries.
  const ctrlEntries = nextEntries.filter(e => e.name.startsWith(settings.controller_entry_prefix));
  for (const entry of ctrlEntries) {
    entry.content = '';
    entry.enabled = false;
  }

  for (const snap of dynMerged.values()) {
    const normalizedSnap = normalizeDynSnapshot(snap);
    const existing = nextEntries.find(e => e.name === snap.name);
    if (existing) {
      applyDynSnapshotToEntry(existing, normalizedSnap);
    } else {
      nextEntries.push(createDynEntryFromSnapshot(normalizedSnap, nextEntries));
    }
  }

  // Restore multi-controllers.
  for (const controllerSnapshot of controllers.values()) {
    const entryName = resolveControllerSnapshotEntryName(settings.controller_entry_prefix, controllerSnapshot);
    const existing = nextEntries.find(e => e.name === entryName);
    if (existing) {
      existing.content = controllerSnapshot.content;
      existing.enabled = true;
    } else {
      nextEntries.push(ensureDefaultEntry(entryName, controllerSnapshot.content, true, nextEntries, true));
    }
  }

  await replaceWorldbook(target.worldbook_name, nextEntries, { render: 'debounced' });
}

export { selectSnapshotFromSources as selectSnapshotFromSourcesForTest };

// ── Event Handlers ──────────────────────────────────────────

async function onChatChanged(settings: EwSettings): Promise<void> {
  try {
    const localization = await localizeSnapshotsForCurrentChat(settings);
    if (localization.localized > 0 || localization.uplifted > 0 || localization.unresolved > 0) {
      console.info(
        `[Evolution World] snapshot localize: localized=${localization.localized}, uplifted=${localization.uplifted}, unresolved=${localization.unresolved}`,
      );
    }
    await purgeAndRestoreForChat(settings);
  } catch (error) {
    console.warn('[Evolution World] chat change handling failed:', error);
  }
}

/**
 * Initialize floor binding event listeners.
 */
export function initFloorBindingEvents(getSettings: () => EwSettings): void {
  disposeFloorBindingEvents();
  refreshObservedMessageVersions();

  floorBindingListenerStops.push(
    onEvent(EVENT_CHAT_CHANGED(), () => {
      refreshObservedMessageVersions();
      const currentSettings = getSettings();
      if (currentSettings.enabled && currentSettings.floor_binding_enabled) {
        scheduleFloorBindingRestore(getSettings, 500);
      }
    }),
  );

  floorBindingListenerStops.push(
    onEvent(EVENT_MESSAGE_DELETED(), () => {
      refreshObservedMessageVersions();
      const currentSettings = getSettings();
      if (currentSettings.enabled && currentSettings.floor_binding_enabled) {
        scheduleFloorBindingRestore(getSettings, 180);
      }
    }),
  );

  floorBindingListenerStops.push(
    onEvent(EVENT_MESSAGE_SWIPED(), messageId => {
      const currentSettings = getSettings();
      if (
        currentSettings.enabled &&
        currentSettings.floor_binding_enabled &&
        shouldReactToVisibleVersionMutation(messageId)
      ) {
        scheduleFloorBindingRestore(getSettings, 300);
      }
    }),
  );

  floorBindingListenerStops.push(
    onEvent(EVENT_MESSAGE_EDITED(), messageId => {
      if (shouldSkipRestoreForMvuExtraAnalysis('MESSAGE_EDITED')) {
        return;
      }

      const currentSettings = getSettings();
      if (
        currentSettings.enabled &&
        currentSettings.floor_binding_enabled &&
        shouldReactToVisibleVersionMutation(messageId)
      ) {
        scheduleFloorBindingRestore(getSettings, 300);
      }
    }),
  );

  floorBindingListenerStops.push(
    onEvent(EVENT_MESSAGE_UPDATED(), messageId => {
      if (shouldSkipRestoreForMvuExtraAnalysis('MESSAGE_UPDATED')) {
        return;
      }

      const currentSettings = getSettings();
      if (
        currentSettings.enabled &&
        currentSettings.floor_binding_enabled &&
        shouldReactToVisibleVersionMutation(messageId)
      ) {
        scheduleFloorBindingRestore(getSettings, 300);
      }
    }),
  );
}

/**
 * Dispose floor binding event listeners.
 */
export function disposeFloorBindingEvents(): void {
  if (floorBindingRestoreTimer) {
    clearTimeout(floorBindingRestoreTimer);
    floorBindingRestoreTimer = null;
  }

  observedMessageVersionKeys.clear();
  for (const stopper of floorBindingListenerStops.splice(0, floorBindingListenerStops.length)) {
    stopper();
  }
}
