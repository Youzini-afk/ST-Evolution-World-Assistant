import { markFloorEntries } from './floor-binding';
import { getMessageVersionInfo } from './helpers';
import { saveControllerBackup } from './settings';
import { klona } from 'klona';
import {
  CommitSummary,
  ControllerEntrySnapshot,
  ControllerTemplateSlot,
  DynSnapshot,
  EwSettings,
  MergedPlan,
  MergedWorldbookDesiredEntry,
  MergedWorldbookRemoveEntry,
} from './types';
import { createWorkflowRuntimeError } from './workflow-error';
import {
  applyDynWriteConfigToEntry,
  buildDynSnapshotFromEntry,
  createDynEntryFromWriteConfig,
  ensureDefaultEntry,
  resolveTargetWorldbook,
} from './worldbook-runtime';
import { getChatId, getChatMessages } from './compat/character';
import { replaceWorldbook, type WbEntry } from './compat/worldbook';

type CommitResult = CommitSummary & {
  worldbook_name: string;
  chat_id: string;
};

type MarkdownItemSet = {
  header: string;
  items: string[];
};

function isManagedEntryName(settings: EwSettings, name: string): boolean {
  if (name.startsWith(settings.controller_entry_prefix)) {
    return true;
  }
  return name.startsWith(settings.dynamic_entry_prefix);
}

function compareContributionApplyOrder(lhs: MergedWorldbookDesiredEntry, rhs: MergedWorldbookDesiredEntry): number {
  if (lhs.priority !== rhs.priority) {
    return lhs.priority - rhs.priority;
  }
  return lhs.flow_order - rhs.flow_order;
}

function parseMarkdownItemSet(raw: string): MarkdownItemSet | null {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) {
    return { header: '', items: [] };
  }

  const lines = text.split('\n');
  const headerLines: string[] = [];
  const items: string[] = [];
  let currentItem: string[] | null = null;
  let sawBullet = false;

  const flushCurrentItem = () => {
    if (!currentItem) {
      return;
    }
    const normalized = currentItem
      .join('\n')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized) {
      items.push(normalized);
    }
    currentItem = null;
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bulletMatch) {
      sawBullet = true;
      flushCurrentItem();
      currentItem = [bulletMatch[1].trim()];
      continue;
    }

    if (!sawBullet) {
      headerLines.push(line);
      continue;
    }

    if (!currentItem) {
      return null;
    }

    if (!line.trim()) {
      continue;
    }

    currentItem.push(line.trim());
  }

  flushCurrentItem();
  const header = headerLines.join('\n').trim();

  if (!sawBullet) {
    return null;
  }

  return { header, items };
}

function normalizeMarkdownItem(item: string): string {
  return String(item ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeMarkdownItems(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = normalizeMarkdownItem(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function renderMarkdownItemSet(set: MarkdownItemSet): string {
  const header = set.header.trim();
  const items = dedupeMarkdownItems(set.items);
  const body = items.map(item => `- ${item}`).join('\n');
  if (header && body) {
    return `${header}\n\n${body}`;
  }
  if (body) {
    return body;
  }
  return header;
}

function applyMarkdownMerge(
  currentContent: string,
  incomingContent: string,
  mode: 'add' | 'add_remove',
): { ok: true; content: string } | { ok: false; reason: string } {
  const current = parseMarkdownItemSet(currentContent);
  const incoming = parseMarkdownItemSet(incomingContent);
  if (!current) {
    return { ok: false, reason: 'current_markdown_parse_failed' };
  }
  if (!incoming) {
    return { ok: false, reason: 'incoming_markdown_parse_failed' };
  }

  const header = incoming.header.trim() ? incoming.header.trim() : current.header.trim();
  if (mode === 'add') {
    return {
      ok: true,
      content: renderMarkdownItemSet({
        header,
        items: [...current.items, ...incoming.items],
      }),
    };
  }

  return {
    ok: true,
    content: renderMarkdownItemSet({
      header,
      items: incoming.items,
    }),
  };
}

function pickWinningContribution(contributions: MergedWorldbookDesiredEntry[]): MergedWorldbookDesiredEntry {
  return [...contributions].sort(compareContributionApplyOrder)[contributions.length - 1];
}

function groupDesiredEntries(entries: MergedWorldbookDesiredEntry[]): Map<string, MergedWorldbookDesiredEntry[]> {
  const grouped = new Map<string, MergedWorldbookDesiredEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.name) ?? [];
    bucket.push(entry);
    grouped.set(entry.name, bucket);
  }
  return grouped;
}

type DynWriteConflict = {
  name: string;
  desired: MergedWorldbookDesiredEntry[];
  removals: MergedWorldbookRemoveEntry[];
};

function groupRemoveEntries(entries: MergedWorldbookRemoveEntry[]): Map<string, MergedWorldbookRemoveEntry[]> {
  const grouped = new Map<string, MergedWorldbookRemoveEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.name) ?? [];
    bucket.push(entry);
    grouped.set(entry.name, bucket);
  }
  return grouped;
}

function collectDynWriteConflicts(
  groupedDesiredEntries: Map<string, MergedWorldbookDesiredEntry[]>,
  groupedRemoveEntries: Map<string, MergedWorldbookRemoveEntry[]>,
  settings: EwSettings,
): DynWriteConflict[] {
  const conflicts: DynWriteConflict[] = [];
  const conflictNames = new Set<string>();

  for (const [entryName, contributions] of groupedDesiredEntries.entries()) {
    if (!entryName.startsWith(settings.dynamic_entry_prefix)) {
      continue;
    }

    const removals = groupedRemoveEntries.get(entryName) ?? [];
    const hasMultiWriterConflict =
      contributions.length > 1 && !contributions.every(entry => entry.dyn_write.mode === 'add');
    const hasWriteRemoveConflict = removals.length > 0;

    if (!hasMultiWriterConflict && !hasWriteRemoveConflict) {
      continue;
    }

    if (conflictNames.has(entryName)) {
      continue;
    }
    conflictNames.add(entryName);
    conflicts.push({
      name: entryName,
      desired: contributions,
      removals,
    });
  }

  return conflicts;
}

function describeDynWriteConflicts(conflicts: DynWriteConflict[]): string {
  return conflicts
    .map(conflict => {
      const desired = conflict.desired.map(
        entry =>
          `${entry.source_flow_name}（${entry.source_flow_id}，写入模式=${entry.dyn_write.mode}）`,
      );
      const removals = conflict.removals.map(
        entry => `${entry.source_flow_name}（${entry.source_flow_id}，删除条目）`,
      );
      return `${conflict.name}: ${[...desired, ...removals].join(' ; ')}`;
    })
    .join('\n');
}

export function collectDynWriteConflictsForTest(
  groupedDesiredEntries: Map<string, MergedWorldbookDesiredEntry[]>,
  groupedRemoveEntries: Map<string, MergedWorldbookRemoveEntry[]>,
  settings: EwSettings,
): DynWriteConflict[] {
  return collectDynWriteConflicts(groupedDesiredEntries, groupedRemoveEntries, settings);
}

function materializeDynEntryContent(
  entryName: string,
  currentContent: string,
  contributions: MergedWorldbookDesiredEntry[],
): { content: string; winner: MergedWorldbookDesiredEntry } {
  const ordered = [...contributions].sort(compareContributionApplyOrder);
  const winner = ordered[ordered.length - 1];

  if (ordered.every(entry => entry.dyn_write.mode === 'add')) {
    let nextContent = currentContent;
    for (const contribution of ordered) {
      const merged = applyMarkdownMerge(nextContent, contribution.content, 'add');
      if (!merged.ok) {
        throw createWorkflowRuntimeError('unknown', 'commit', {
          message: `动态条目 "${entryName}" 无法按 add 模式合并，已阻止本轮写回。`,
          detail: `${entryName}: ${merged.reason}`,
          flow_id: contribution.source_flow_id,
          flow_name: contribution.source_flow_name,
        });
      }
      nextContent = merged.content;
    }
    return { content: nextContent, winner };
  }

  if (winner.dyn_write.mode === 'overwrite') {
    return { content: winner.content, winner };
  }

  const merged = applyMarkdownMerge(currentContent, winner.content, winner.dyn_write.mode);
  if (!merged.ok) {
    throw createWorkflowRuntimeError('unknown', 'commit', {
      message: `动态条目 "${entryName}" 无法按 ${winner.dyn_write.mode} 模式物化，已阻止本轮写回。`,
      detail: `${entryName}: ${merged.reason}`,
      flow_id: winner.source_flow_id,
      flow_name: winner.source_flow_name,
    });
  }

  return { content: merged.content, winner };
}

function applyResolvedManagedEntries(
  nextEntries: WbEntry[],
  resolvedEntries: Array<{ name: string; content: string; enabled: boolean }>,
): void {
  const indexByName = new Map<string, number>();
  for (let i = 0; i < nextEntries.length; i++) {
    indexByName.set(nextEntries[i].name, i);
  }

  for (const desired of resolvedEntries) {
    const existingIndex = indexByName.get(desired.name);
    if (existingIndex !== undefined) {
      nextEntries[existingIndex].content = desired.content;
      nextEntries[existingIndex].enabled = desired.enabled;
      continue;
    }

    const newEntry = ensureDefaultEntry(desired.name, desired.content, desired.enabled, nextEntries);
    indexByName.set(desired.name, nextEntries.length);
    nextEntries.push(newEntry);
  }
}

function collectManagedDynSnapshots(nextEntries: WbEntry[], settings: EwSettings): DynSnapshot[] {
  return nextEntries
    .filter(entry => entry.name.startsWith(settings.dynamic_entry_prefix))
    .map(entry => buildDynSnapshotFromEntry(entry));
}

function collectControllerBackupEntries(entries: WbEntry[], settings: EwSettings): ControllerEntrySnapshot[] {
  return entries
    .filter(entry => entry.name.startsWith(settings.controller_entry_prefix))
    .map(entry => ({
      entry_name: entry.name,
      content: entry.content,
    }));
}

function collectManagedControllerSnapshots(nextEntries: WbEntry[], settings: EwSettings): ControllerEntrySnapshot[] {
  return collectControllerBackupEntries(nextEntries, settings).filter(entry => entry.content);
}

function buildCommitSummary(
  beforeEntries: WbEntry[],
  afterEntries: WbEntry[],
  settings: EwSettings,
  targetWorldbookName: string,
  requestedDynEntryCount: number,
  requestedControllerEntryCount: number,
  worldbookVerified: boolean,
): CommitSummary {
  const beforeDyn = new Map(
    beforeEntries
      .filter(entry => entry.name.startsWith(settings.dynamic_entry_prefix))
      .map(entry => [entry.name, buildDynSnapshotFromEntry(entry)]),
  );
  const afterDyn = new Map(
    afterEntries
      .filter(entry => entry.name.startsWith(settings.dynamic_entry_prefix))
      .map(entry => [entry.name, buildDynSnapshotFromEntry(entry)]),
  );

  const beforeControllers = new Map(
    beforeEntries
      .filter(entry => entry.name.startsWith(settings.controller_entry_prefix))
      .map(entry => [entry.name, { content: entry.content, enabled: entry.enabled }]),
  );
  const afterControllers = new Map(
    afterEntries
      .filter(entry => entry.name.startsWith(settings.controller_entry_prefix))
      .map(entry => [entry.name, { content: entry.content, enabled: entry.enabled }]),
  );

  let dynEntriesCreated = 0;
  let dynEntriesUpdated = 0;
  let dynEntriesRemoved = 0;

  for (const name of _.uniq([...beforeDyn.keys(), ...afterDyn.keys()])) {
    const before = beforeDyn.get(name);
    const after = afterDyn.get(name);
    if (!before && after) {
      dynEntriesCreated += 1;
      continue;
    }
    if (before && !after) {
      dynEntriesRemoved += 1;
      continue;
    }
    if (before && after && !_.isEqual(before, after)) {
      dynEntriesUpdated += 1;
    }
  }

  let controllerEntriesUpdated = 0;
  for (const name of _.uniq([...beforeControllers.keys(), ...afterControllers.keys()])) {
    const before = beforeControllers.get(name);
    const after = afterControllers.get(name);
    if (!before || !after) {
      controllerEntriesUpdated += 1;
      continue;
    }
    if (before.content !== after.content || before.enabled !== after.enabled) {
      controllerEntriesUpdated += 1;
    }
  }

  const hasDynChanges = dynEntriesCreated + dynEntriesUpdated + dynEntriesRemoved > 0;
  const hasControllerChanges = controllerEntriesUpdated > 0;
  let writeScope: CommitSummary['write_scope'] = 'none';
  if (hasDynChanges && hasControllerChanges) {
    writeScope = 'dyn_and_controller';
  } else if (hasDynChanges) {
    writeScope = 'dyn_only';
  } else if (hasControllerChanges) {
    writeScope = 'controller_only';
  }

  return {
    target_worldbook_name: targetWorldbookName,
    dyn_entries_requested: requestedDynEntryCount,
    dyn_entries_created: dynEntriesCreated,
    dyn_entries_updated: dynEntriesUpdated,
    dyn_entries_removed: dynEntriesRemoved,
    controller_entries_requested: requestedControllerEntryCount,
    controller_entries_updated: controllerEntriesUpdated,
    write_scope: writeScope,
    worldbook_verified: worldbookVerified,
    effective_change_count: dynEntriesCreated + dynEntriesUpdated + dynEntriesRemoved + controllerEntriesUpdated,
  };
}

export async function commitMergedPlan(
  settings: EwSettings,
  mergedPlan: MergedPlan,
  controllerTemplates: ControllerTemplateSlot[],
  _requestId: string,
  messageId: number,
): Promise<CommitResult> {
  const target = await resolveTargetWorldbook(settings);
  const beforeEntries = target.entries;
  const chatId = getChatId();
  const requestedDynEntryCount = new Set(
    [
      ...mergedPlan.worldbook.desired_entries
        .filter(entry => entry.name.startsWith(settings.dynamic_entry_prefix))
        .map(entry => entry.name),
      ...mergedPlan.worldbook.remove_entries
        .filter(entry => entry.name.startsWith(settings.dynamic_entry_prefix))
        .map(entry => entry.name),
    ],
  ).size;
  const requestedControllerEntryCount = new Set(controllerTemplates.map(slot => slot.entry_name)).size;

  const allNames = [
    ...mergedPlan.worldbook.desired_entries.map(entry => entry.name),
    ...mergedPlan.worldbook.remove_entries.map(entry => entry.name),
  ];
  const unmanaged = allNames.filter(name => !isManagedEntryName(settings, name));
  if (unmanaged.length > 0) {
    throw createWorkflowRuntimeError('unknown', 'commit', {
      message: `存在未受管的条目写入目标，已阻止本轮写回：${unmanaged.join(', ')}`,
      detail: unmanaged.join(', '),
    });
  }

  const nextEntries = klona(beforeEntries).filter(
    entry => !mergedPlan.worldbook.remove_entries.some(removal => removal.name === entry.name),
  );
  const desiredEntriesByName = groupDesiredEntries(mergedPlan.worldbook.desired_entries);
  const removeEntriesByName = groupRemoveEntries(mergedPlan.worldbook.remove_entries);
  const dynWriteConflicts = collectDynWriteConflicts(
    desiredEntriesByName,
    removeEntriesByName,
    settings,
  );
  if (dynWriteConflicts.length > 0) {
    throw createWorkflowRuntimeError('entry_conflict', 'commit', {
      message: `检测到 ${dynWriteConflicts.length} 个动态条目在同一轮被竞争写入，已阻止本轮写回。`,
      summary: '多个工作流同时竞争同名动态条目，已阻止本轮写回。',
      detail: describeDynWriteConflicts(dynWriteConflicts),
      conflict_entries: dynWriteConflicts.map(conflict => conflict.name),
      target_worldbook_name: target.worldbook_name,
    });
  }
  const resolvedNonDynEntries: Array<{ name: string; content: string; enabled: boolean }> = [];

  for (const [entryName, contributions] of desiredEntriesByName.entries()) {
    if (entryName.startsWith(settings.dynamic_entry_prefix)) {
      continue;
    }
    const winner = pickWinningContribution(contributions);
    resolvedNonDynEntries.push({
      name: entryName,
      content: winner.content,
      enabled: winner.enabled,
    });
  }

  applyResolvedManagedEntries(nextEntries, resolvedNonDynEntries);

  for (const [entryName, contributions] of desiredEntriesByName.entries()) {
    if (!entryName.startsWith(settings.dynamic_entry_prefix)) {
      continue;
    }

    const existing = nextEntries.find(entry => entry.name === entryName);
    const materialized = materializeDynEntryContent(entryName, existing?.content ?? '', contributions);

    if (existing) {
      applyDynWriteConfigToEntry(existing, entryName, materialized.content, materialized.winner.dyn_write);
    } else {
      nextEntries.push(createDynEntryFromWriteConfig(entryName, materialized.content, nextEntries, materialized.winner.dyn_write));
    }
  }

  if (controllerTemplates.length > 0) {
    const desiredControllerByName = new Map(controllerTemplates.map(slot => [slot.entry_name, slot]));

    for (const entry of nextEntries) {
      if (!entry.name.startsWith(settings.controller_entry_prefix)) {
        continue;
      }
      const desiredController = desiredControllerByName.get(entry.name);
      if (desiredController) {
        entry.content = desiredController.content;
        entry.enabled = true;
      } else {
        entry.content = '';
        entry.enabled = false;
      }
    }

    for (const slot of controllerTemplates) {
      const ctrlExisting = nextEntries.find(entry => entry.name === slot.entry_name);
      if (ctrlExisting) {
        continue;
      }
      nextEntries.push(ensureDefaultEntry(slot.entry_name, slot.content, true, nextEntries, true));
    }
  }

  let worldbookVerified = false;
  let commitSummary = buildCommitSummary(
    beforeEntries,
    nextEntries,
    settings,
    target.worldbook_name,
    requestedDynEntryCount,
    requestedControllerEntryCount,
    worldbookVerified,
  );

  if (commitSummary.effective_change_count > 0) {
    saveControllerBackup(chatId, target.worldbook_name, collectControllerBackupEntries(beforeEntries, settings));
    try {
      await replaceWorldbook(target.worldbook_name, nextEntries, { render: 'debounced' });
    } catch (error) {
      throw createWorkflowRuntimeError('commit_failed', 'commit', {
        message: `写回目标世界书 "${target.worldbook_name}" 失败。`,
        detail: error instanceof Error ? error.message : String(error),
        target_worldbook_name: target.worldbook_name,
        cause: error,
      });
    }
    worldbookVerified = true;
    commitSummary = buildCommitSummary(
      beforeEntries,
      nextEntries,
      settings,
      target.worldbook_name,
      requestedDynEntryCount,
      requestedControllerEntryCount,
      worldbookVerified,
    );

    if (settings.floor_binding_enabled && messageId >= 0) {
      const dynSnapshots = collectManagedDynSnapshots(nextEntries, settings);
      const controllerSnapshots = collectManagedControllerSnapshots(nextEntries, settings);
      const targetMsg = getChatMessages(messageId)[0];
      const versionInfo = getMessageVersionInfo(targetMsg);

      await markFloorEntries(
        settings,
        messageId,
        dynSnapshots.map(entry => entry.name),
        controllerSnapshots,
        dynSnapshots,
        versionInfo.swipe_id,
        versionInfo.content_hash,
        {
          persist_empty_snapshot: true,
        },
      );
    }
  }

  return {
    ...commitSummary,
    worldbook_name: target.worldbook_name,
    chat_id: chatId,
  };
}
