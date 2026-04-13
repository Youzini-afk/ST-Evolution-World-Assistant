/**
 * File-based artifact storage via ST's /api/files endpoint.
 *
 * Stores per-message worldbook snapshots plus workflow execution artifacts
 * as JSON files on the server, keeping chat message data lightweight.
 *
 * File naming: ew__{charName}__{chatId}__fp-{fingerprint}__msg-{messageId}.json
 * (flat layout — ST file API doesn't support subdirectories)
 */

import { buildMessageVersionKey, simpleHash } from './helpers';
import type { ControllerEntrySnapshot, DynSnapshot } from './types';
import { normalizeDynSnapshotData } from './worldbook-runtime';

export const FILE_ARTIFACT_VERSION = 'ew-message-store/v3';
export const FILE_ARTIFACT_REVISION_LIMIT = 2;

export type SnapshotData = {
  controllers: ControllerEntrySnapshot[];
  dyn_entries: DynSnapshot[];
  /** 写入快照时 assistant 消息的 swipe_id，用于版本校验 */
  swipe_id?: number;
  /** assistant 消息当前可见文本的哈希，检测 edit/update */
  content_hash?: string;
};

export type ExternalArtifactVersionMap = Record<string, Record<string, unknown>>;
export type ExternalArtifactKind = 'workflow_execution' | 'replay_capsules';

export type SnapshotVersionStore = {
  version: typeof FILE_ARTIFACT_VERSION;
  updated_at: number;
  versions: Record<string, SnapshotData>;
  workflow_execution: ExternalArtifactVersionMap;
  replay_capsules: ExternalArtifactVersionMap;
  owner?: SnapshotStoreOwner;
};

export type SnapshotStoreOwner = {
  char_name: string;
  chat_id: string;
  chat_fingerprint: string;
};

/**
 * Upgrade legacy snapshot formats to the new multi-controller array structure.
 */
export function upgradeSnapshotData(raw: any): SnapshotData | null {
  if (!raw || typeof raw !== 'object') return null;
  const dynEntries = Array.isArray(raw.dyn_entries)
    ? raw.dyn_entries
        .map((entry: unknown) => normalizeDynSnapshotData(entry))
        .filter((entry: DynSnapshot | null): entry is DynSnapshot => Boolean(entry))
    : [];

  if (Array.isArray(raw.controllers)) {
    return {
      controllers: raw.controllers
        .filter((entry: unknown) => entry && typeof entry === 'object')
        .map((entry: ControllerEntrySnapshot) => ({
          entry_name: String(entry.entry_name ?? ''),
          content: String(entry.content ?? ''),
          flow_id: entry.flow_id,
          flow_name: entry.flow_name,
          legacy: Boolean(entry.legacy),
        }))
        .filter((entry: ControllerEntrySnapshot) => entry.content),
      dyn_entries: dynEntries,
      swipe_id: typeof raw.swipe_id === 'number' ? raw.swipe_id : undefined,
      content_hash: typeof raw.content_hash === 'string' ? raw.content_hash : undefined,
    };
  }

  if (raw.controllers && typeof raw.controllers === 'object' && !Array.isArray(raw.controllers)) {
    return {
      controllers: Object.entries(raw.controllers as Record<string, unknown>).map(([key, value]) => ({
        entry_name: key.startsWith('EW/Controller/') ? key : '',
        flow_name: key.startsWith('EW/Controller/') ? undefined : key,
        content: String(value ?? ''),
        legacy: key === 'legacy',
      })),
      dyn_entries: dynEntries,
      swipe_id: typeof raw.swipe_id === 'number' ? raw.swipe_id : undefined,
      content_hash: typeof raw.content_hash === 'string' ? raw.content_hash : undefined,
    };
  }

  if (typeof raw.controller === 'string') {
    return {
      controllers: raw.controller
        ? [{ entry_name: '', flow_name: 'Legacy Controller', content: raw.controller, legacy: true }]
        : [],
      dyn_entries: dynEntries,
      swipe_id: typeof raw.swipe_id === 'number' ? raw.swipe_id : undefined,
      content_hash: typeof raw.content_hash === 'string' ? raw.content_hash : undefined,
    };
  }

  return null;
}

function snapshotVersionKey(data: SnapshotData): string {
  return buildMessageVersionKey(Number(data.swipe_id ?? 0), String(data.content_hash ?? '').trim());
}

type ParsedArchivedVersionKey = {
  baseKey: string;
  stamp: number;
  counter: number;
};

function parseArchivedVersionKey(key: string): ParsedArchivedVersionKey | null {
  const marker = '@rev:';
  const markerIndex = key.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const baseKey = key.slice(0, markerIndex);
  const suffix = key.slice(markerIndex + marker.length);
  const [stampRaw, counterRaw] = suffix.split('_');
  const stamp = Number(stampRaw);
  const counter = Number(counterRaw ?? 0);
  if (!Number.isFinite(stamp)) {
    return null;
  }

  return {
    baseKey,
    stamp,
    counter: Number.isFinite(counter) ? counter : 0,
  };
}

export function buildArchivedSnapshotVersionKey(
  baseKey: string,
  store: Pick<SnapshotVersionStore, 'versions'>,
  revisionStamp = Date.now(),
): { archivedKey: string; collisionCount: number } {
  let candidate = `${baseKey}@rev:${revisionStamp}`;
  let counter = 0;
  while (store.versions[candidate]) {
    counter += 1;
    candidate = `${baseKey}@rev:${revisionStamp}_${counter}`;
  }
  return {
    archivedKey: candidate,
    collisionCount: counter,
  };
}

export function buildArchivedArtifactVersionKey<T>(
  baseKey: string,
  map: Record<string, T>,
  revisionStamp = Date.now(),
): string {
  let candidate = `${baseKey}@rev:${revisionStamp}`;
  let counter = 0;
  while (map[candidate]) {
    counter += 1;
    candidate = `${baseKey}@rev:${revisionStamp}_${counter}`;
  }
  return candidate;
}

export function pruneArchivedVersionedEntries<T>(
  map: Record<string, T>,
  baseKey: string,
  keepRecent = FILE_ARTIFACT_REVISION_LIMIT,
): void {
  const archivedEntries = Object.keys(map)
    .map(key => ({ key, parsed: parseArchivedVersionKey(key) }))
    .filter(
      (entry): entry is { key: string; parsed: ParsedArchivedVersionKey } =>
        entry.parsed !== null && entry.parsed.baseKey === baseKey,
    )
    .sort((left, right) => {
      if (left.parsed.stamp !== right.parsed.stamp) {
        return right.parsed.stamp - left.parsed.stamp;
      }
      return right.parsed.counter - left.parsed.counter;
    });

  for (const entry of archivedEntries.slice(Math.max(0, keepRecent))) {
    delete map[entry.key];
  }
}

export function pruneAllVersionedEntries<T>(
  map: Record<string, T>,
  keepRecent = FILE_ARTIFACT_REVISION_LIMIT,
): void {
  const baseKeys = new Set<string>();
  for (const key of Object.keys(map)) {
    const archived = parseArchivedVersionKey(key);
    baseKeys.add(archived ? archived.baseKey : key);
  }
  for (const baseKey of baseKeys) {
    pruneArchivedVersionedEntries(map, baseKey, keepRecent);
  }
}

function buildChatFingerprint(chatId: string): string {
  return simpleHash(String(chatId ?? ''))
    .replace(/^h/, '')
    .slice(0, 12);
}

function buildSnapshotStoreOwner(charName: string, chatId: string): SnapshotStoreOwner {
  return {
    char_name: String(charName ?? ''),
    chat_id: String(chatId ?? ''),
    chat_fingerprint: buildChatFingerprint(chatId),
  };
}

function normalizeSnapshotStoreOwner(raw: unknown): SnapshotStoreOwner | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const owner = raw as Record<string, unknown>;
  const charName = String(owner.char_name ?? '').trim();
  const chatId = String(owner.chat_id ?? '').trim();
  const chatFingerprint = String(owner.chat_fingerprint ?? '').trim();
  if (!charName || !chatId || !chatFingerprint) {
    return undefined;
  }

  return {
    char_name: charName,
    chat_id: chatId,
    chat_fingerprint: chatFingerprint,
  };
}

function normalizeExternalArtifactVersionMap(raw: unknown): ExternalArtifactVersionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const result: ExternalArtifactVersionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    result[String(key)] = { ...(value as Record<string, unknown>) };
  }
  return result;
}

function createEmptyStore(owner?: SnapshotStoreOwner): SnapshotVersionStore {
  return {
    version: FILE_ARTIFACT_VERSION,
    updated_at: Date.now(),
    versions: {},
    workflow_execution: {},
    replay_capsules: {},
    owner,
  };
}

function normalizeSnapshotVersionStore(raw: any): SnapshotVersionStore | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (
    raw.version === FILE_ARTIFACT_VERSION &&
    raw.versions &&
    typeof raw.versions === 'object' &&
    !Array.isArray(raw.versions)
  ) {
    const versions: Record<string, SnapshotData> = {};
    for (const [key, value] of Object.entries(raw.versions as Record<string, unknown>)) {
      const upgraded = upgradeSnapshotData(value);
      if (upgraded) {
        versions[String(key)] = upgraded;
      }
    }
    const workflowExecution = normalizeExternalArtifactVersionMap(raw.workflow_execution);
    const replayCapsules = normalizeExternalArtifactVersionMap(raw.replay_capsules);
    pruneAllVersionedEntries(versions, FILE_ARTIFACT_REVISION_LIMIT);
    pruneAllVersionedEntries(workflowExecution, FILE_ARTIFACT_REVISION_LIMIT);
    pruneAllVersionedEntries(replayCapsules, FILE_ARTIFACT_REVISION_LIMIT);
    return {
      version: FILE_ARTIFACT_VERSION,
      updated_at: Number(raw.updated_at ?? Date.now()),
      versions,
      workflow_execution: workflowExecution,
      replay_capsules: replayCapsules,
      owner: normalizeSnapshotStoreOwner(raw.owner),
    };
  }

  if (
    raw.version === 'ew-snapshot/v2' &&
    raw.versions &&
    typeof raw.versions === 'object' &&
    !Array.isArray(raw.versions)
  ) {
    const versions: Record<string, SnapshotData> = {};
    for (const [key, value] of Object.entries(raw.versions as Record<string, unknown>)) {
      const upgraded = upgradeSnapshotData(value);
      if (upgraded) {
        versions[String(key)] = upgraded;
      }
    }
    pruneAllVersionedEntries(versions, FILE_ARTIFACT_REVISION_LIMIT);
    return {
      version: FILE_ARTIFACT_VERSION,
      updated_at: Number(raw.updated_at ?? Date.now()),
      versions,
      workflow_execution: {},
      replay_capsules: {},
      owner: normalizeSnapshotStoreOwner(raw.owner),
    };
  }

  const upgraded = upgradeSnapshotData(raw);
  if (!upgraded) {
    return null;
  }

  return {
    version: FILE_ARTIFACT_VERSION,
    updated_at: Date.now(),
    versions: {
      [snapshotVersionKey(upgraded)]: upgraded,
    },
    workflow_execution: {},
    replay_capsules: {},
  };
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

function buildFileName(charName: string, chatId: string, messageId: number): string {
  return `ew__${sanitizeSegment(charName)}__${sanitizeSegment(chatId)}__fp-${buildChatFingerprint(chatId)}__msg-${messageId}.json`;
}

function buildFilePrefix(charName: string, chatId: string): string {
  return `ew__${sanitizeSegment(charName)}__${sanitizeSegment(chatId)}__fp-${buildChatFingerprint(chatId)}__`;
}

function buildLegacyFileName(charName: string, chatId: string, messageId: number): string {
  return `ew__${sanitizeSegment(charName)}__${sanitizeSegment(chatId)}__msg-${messageId}.json`;
}

function buildLegacyFilePrefix(charName: string, chatId: string): string {
  return `ew__${sanitizeSegment(charName)}__${sanitizeSegment(chatId)}__`;
}

async function getHeaders(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    ...getRequestHeaders(),
  };
}

function cloneStore(store: SnapshotVersionStore): SnapshotVersionStore {
  return {
    version: FILE_ARTIFACT_VERSION,
    updated_at: Date.now(),
    versions: { ...store.versions },
    workflow_execution: { ...store.workflow_execution },
    replay_capsules: { ...store.replay_capsules },
    owner: store.owner,
  };
}

export function getExternalArtifactMap(
  store: SnapshotVersionStore | null | undefined,
  kind: ExternalArtifactKind,
): ExternalArtifactVersionMap {
  if (!store) {
    return {};
  }
  return {
    ...(kind === 'workflow_execution' ? store.workflow_execution : store.replay_capsules),
  };
}

export function setExternalArtifactMap(
  store: SnapshotVersionStore,
  kind: ExternalArtifactKind,
  map: ExternalArtifactVersionMap,
): void {
  if (kind === 'workflow_execution') {
    store.workflow_execution = { ...map };
  } else {
    store.replay_capsules = { ...map };
  }
}

export function hasSnapshotStorePayload(store: SnapshotVersionStore | null | undefined): boolean {
  if (!store) {
    return false;
  }
  return Boolean(
    Object.keys(store.versions).length > 0 ||
      Object.keys(store.workflow_execution).length > 0 ||
      Object.keys(store.replay_capsules).length > 0,
  );
}

function prepareSnapshotStoreForPersistence(store: SnapshotVersionStore): SnapshotVersionStore {
  const sanitizedStore = cloneStore(store);
  sanitizedStore.updated_at = Date.now();
  sanitizedStore.version = FILE_ARTIFACT_VERSION;
  pruneAllVersionedEntries(sanitizedStore.versions, FILE_ARTIFACT_REVISION_LIMIT);
  pruneAllVersionedEntries(sanitizedStore.workflow_execution, FILE_ARTIFACT_REVISION_LIMIT);
  pruneAllVersionedEntries(sanitizedStore.replay_capsules, FILE_ARTIFACT_REVISION_LIMIT);
  return sanitizedStore;
}

async function persistPreparedSnapshotStore(fileName: string, store: SnapshotVersionStore): Promise<void> {
  const sanitizedStore = prepareSnapshotStoreForPersistence(store);

  const jsonContent = JSON.stringify(sanitizedStore);
  const base64Content = btoa(unescape(encodeURIComponent(jsonContent)));

  const response = await fetch('/api/files/upload', {
    method: 'POST',
    headers: await getHeaders(),
    body: JSON.stringify({ name: fileName, data: base64Content }),
  });

  if (!response.ok) {
    throw new Error(`[EW] Failed to write snapshot file "${fileName}": ${response.status} ${response.statusText}`);
  }
}

function normalizeStoreForComparison(store: SnapshotVersionStore | null | undefined): Record<string, unknown> | null {
  if (!store) {
    return null;
  }

  const prepared = prepareSnapshotStoreForPersistence(store);
  return {
    version: prepared.version,
    versions: prepared.versions,
    workflow_execution: prepared.workflow_execution,
    replay_capsules: prepared.replay_capsules,
    owner: prepared.owner ?? null,
  };
}

function storesEquivalent(
  actual: SnapshotVersionStore | null | undefined,
  expected: SnapshotVersionStore | null | undefined,
): boolean {
  const actualComparable = normalizeStoreForComparison(actual);
  const expectedComparable = normalizeStoreForComparison(expected);
  return JSON.stringify(actualComparable) === JSON.stringify(expectedComparable);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifySnapshotStoreWrite(fileName: string, expected: SnapshotVersionStore): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const writtenStore = await readSnapshotStore(fileName);
    if (storesEquivalent(writtenStore, expected)) {
      return;
    }

    if (attempt < maxAttempts) {
      await sleep(80);
    }
  }

  throw new Error(`[EW] Snapshot store verification failed for "${fileName}"`);
}

export async function writeSnapshotStore(fileName: string, store: SnapshotVersionStore): Promise<void> {
  const nextStore = prepareSnapshotStoreForPersistence(store);
  await persistPreparedSnapshotStore(fileName, nextStore);
  await verifySnapshotStoreWrite(fileName, nextStore);
}

export async function writeSnapshot(
  charName: string,
  chatId: string,
  messageId: number,
  data: SnapshotData,
): Promise<string> {
  const fileName = buildFileName(charName, chatId, messageId);
  const currentStore =
    (await readSnapshotStore(fileName)) ?? createEmptyStore(buildSnapshotStoreOwner(charName, chatId));
  currentStore.updated_at = Date.now();
  currentStore.owner = buildSnapshotStoreOwner(charName, chatId);
  const versionKey = snapshotVersionKey(data);
  const existing = currentStore.versions[versionKey];
  if (existing) {
    const existingJson = JSON.stringify(existing);
    const nextJson = JSON.stringify(data);
    if (existingJson !== nextJson) {
      const { archivedKey, collisionCount } = buildArchivedSnapshotVersionKey(versionKey, currentStore);
      currentStore.versions[archivedKey] = existing;
      console.debug('[Evolution World] Snapshot version archived before overwrite', {
        file_name: fileName,
        version_key: versionKey,
        archived_key: archivedKey,
        collision_count: collisionCount,
      });
    }
  }
  currentStore.versions[versionKey] = data;
  pruneArchivedVersionedEntries(currentStore.versions, versionKey, FILE_ARTIFACT_REVISION_LIMIT);

  await writeSnapshotStore(fileName, currentStore);

  console.debug(`[Evolution World] Snapshot written: ${fileName}`);
  return fileName;
}

export async function readSnapshotStore(fileName: string): Promise<SnapshotVersionStore | null> {
  try {
    const response = await fetch(`/user/files/${fileName}`, {
      headers: getRequestHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) {
      console.debug(`[Evolution World] Snapshot file not found: ${fileName}`);
      return null;
    }
    const data = await response.json();
    return normalizeSnapshotVersionStore(data);
  } catch (e) {
    console.warn(`[Evolution World] Failed to read snapshot: ${fileName}`, e);
    return null;
  }
}

export async function readSnapshot(fileName: string, versionKey?: string): Promise<SnapshotData | null> {
  const store = await readSnapshotStore(fileName);
  if (!store) {
    return null;
  }

  if (versionKey) {
    return store.versions[versionKey] ?? null;
  }

  const values = Object.values(store.versions);
  return values.length === 1 ? values[0] : null;
}

export async function deleteSnapshot(fileName: string): Promise<void> {
  try {
    const response = await fetch('/api/files/delete', {
      method: 'POST',
      headers: await getHeaders(),
      body: JSON.stringify({ path: `user/files/${fileName}` }),
    });
    if (response.ok) {
      console.debug(`[Evolution World] Snapshot deleted: ${fileName}`);
    }
  } catch (e) {
    console.warn(`[Evolution World] Failed to delete snapshot: ${fileName}`, e);
  }
}

export async function findSnapshotFiles(charName: string, chatId: string, messageIds: number[]): Promise<string[]> {
  const prefix = buildFilePrefix(charName, chatId);
  const legacyPrefix = buildLegacyFilePrefix(charName, chatId);
  const candidates = _.uniq([
    ...messageIds.map(id => `user/files/${prefix}msg-${id}.json`),
    ...messageIds.map(id => `user/files/${legacyPrefix}msg-${id}.json`),
  ]);

  if (candidates.length === 0) return [];

  try {
    const response = await fetch('/api/files/verify', {
      method: 'POST',
      headers: await getHeaders(),
      body: JSON.stringify({ urls: candidates }),
    });
    if (!response.ok) return [];

    const result = (await response.json()) as Record<string, boolean>;
    return Object.entries(result)
      .filter(([, exists]) => exists)
      .map(([url]) => url.replace('user/files/', ''));
  } catch (e) {
    console.warn('[Evolution World] Failed to verify snapshot files:', e);
    return [];
  }
}

export async function cleanupSnapshotFiles(
  charName: string,
  chatId: string,
  allMessageIds: number[],
  keepFileNames: Set<string>,
): Promise<number> {
  const allFiles = await findSnapshotFiles(charName, chatId, allMessageIds);
  let deleted = 0;
  for (const file of allFiles) {
    if (!keepFileNames.has(file)) {
      await deleteSnapshot(file);
      deleted++;
    }
  }
  return deleted;
}

export {
  buildChatFingerprint,
  buildFileName,
  buildFilePrefix,
  buildLegacyFileName,
  buildLegacyFilePrefix,
  buildSnapshotStoreOwner,
  createEmptyStore as createEmptySnapshotStore,
};
import { getRequestHeaders } from '../st-adapter';
