import { readExtensionSettings } from '../st-adapter';
import { validateEjsTemplate } from './controller-renderer';
import { rederiveWorkflowAtFloor, rerollCurrentAfterReplyWorkflow } from './events';
import { localizeSnapshotsForCurrentChat } from './floor-binding';
import { resolveControllerSnapshotEntryName } from './helpers';
import { runWorkflow } from './pipeline';
import { getLastIo, getLastRun, getSettings, patchSettings, readControllerBackup } from './settings';
import { EwSettingsSchema } from './types';
import { resolveTargetWorldbook } from './worldbook-runtime';
import { assertWorkflowSupport } from './workflow-support';
import { getWorldbook, replaceWorldbook } from './compat/worldbook';
import { getChatMessages, getLastMessageId, getChatId } from './compat/character';
import { klona } from 'klona';

// EvolutionWorldAPI 的权威定义。declare global 和 initGlobalApi 共用同一个 interface，
// 避免之前两份签名漂移、要改字段得改两遍的问题。
export interface EvolutionWorldAPI {
  getConfig: () => ReturnType<typeof getSettings>;
  setConfig: (partial: Partial<ReturnType<typeof getSettings>>) => Promise<void>;
  validateConfig: () => { ok: boolean; errors: string[] };
  runNow: (message?: string) => Promise<{ ok: boolean; reason?: string }>;
  getLastRun: () => ReturnType<typeof getLastRun>;
  getLastIo: () => ReturnType<typeof getLastIo>;
  validateControllerSyntax: () => Promise<{ ok: boolean; reason?: string }>;
  rollbackController: () => Promise<{ ok: boolean; reason?: string }>;
  rerollCurrentAfterReply: () => Promise<{ ok: boolean; reason?: string }>;
  rederiveWorkflowAtFloor: (input: {
    message_id: number;
    timing: 'before_reply' | 'after_reply' | 'manual';
    target_version_key?: string;
    confirm_legacy?: boolean;
    capsule_mode?: 'full' | 'light';
  }) => Promise<{
    ok: boolean;
    reason?: string;
    result?: {
      message_id: number;
      anchor_message_id: number;
      legacy_approx: boolean;
      writeback_applied: number;
      writeback_conflicts: number;
      writeback_conflict_names: string[];
    };
  }>;
  localizeSnapshots: () => Promise<{
    ok: boolean;
    reason?: string;
    result?: {
      localized: number;
      uplifted: number;
      unresolved: number;
      skipped: number;
      mutated_messages: number;
      warnings: string[];
    };
  }>;
}

declare global {
  interface Window {
    EvolutionWorldAPI?: EvolutionWorldAPI;
  }
}

async function validateControllerSyntax(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const settings = getSettings();
    const target = await resolveTargetWorldbook(settings);
    const controllerEntries = target.entries.filter(entry => entry.name.startsWith(settings.controller_entry_prefix));
    if (controllerEntries.length === 0) {
      return { ok: false, reason: `no controller entries found with prefix: ${settings.controller_entry_prefix}` };
    }

    const errors: string[] = [];
    for (const entry of controllerEntries) {
      try {
        await validateEjsTemplate(entry.content);
      } catch (error) {
        errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      return { ok: false, reason: errors.join('\n') };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function rollbackController(): Promise<{ ok: boolean; reason?: string }> {
  try {
    assertWorkflowSupport();
    const settings = getSettings();
    const chatId = getChatId();
    const backup = readControllerBackup(chatId);
    if (!backup) {
      return { ok: false, reason: 'no backup found for current chat' };
    }

    const entries = klona(await getWorldbook(backup.worldbook_name));

    const backupByEntryName = new Map(
      backup.controller_content.map(snapshot => [
        resolveControllerSnapshotEntryName(settings.controller_entry_prefix, snapshot),
        snapshot,
      ]),
    );

    for (const entry of entries) {
      if (!entry.name.startsWith(settings.controller_entry_prefix)) {
        continue;
      }
      const restored = backupByEntryName.get(entry.name);
      if (restored) {
        entry.content = restored.content;
        entry.enabled = true;
      } else {
        entry.content = '';
        entry.enabled = false;
      }
    }

    for (const snapshot of backup.controller_content) {
      const entryName = resolveControllerSnapshotEntryName(settings.controller_entry_prefix, snapshot);
      const controller = entries.find(entry => entry.name === entryName);
      if (controller) {
        continue;
      } else {
        const uid = (_.max(entries.map(entry => entry.uid)) ?? 0) + 1;
        entries.push({
          uid,
          name: entryName,
          enabled: true,
          strategy: {
            type: 'constant',
            keys: [],
            keys_secondary: { logic: 'and_any', keys: [] },
            scan_depth: 'same_as_global',
          },
          position: {
            type: 'at_depth',
            role: 'system',
            depth: 0,
            order: 14720,
          },
          content: snapshot.content,
          probability: 100,
          recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
          effect: { sticky: null, cooldown: null, delay: null },
          extra: {},
        });
      }
    }

    await replaceWorldbook(backup.worldbook_name, entries, { render: 'debounced' });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function initGlobalApi() {
  const api: EvolutionWorldAPI = {
    getConfig: () => getSettings(),
    setConfig: async partial => {
      patchSettings(partial);
    },
    validateConfig: () => {
      // 旧实现是 parse(getSettings())，但 getSettings() 已经 normalize 过，
      // 必然通过校验，等同于无效校验。改成读 raw bucket 里的 settings 字段。
      let rawSettings: unknown = null;
      try {
        const bucket = readExtensionSettings();
        rawSettings = (bucket && typeof bucket === 'object' ? (bucket as Record<string, unknown>).settings : null) ?? null;
      } catch (error) {
        return {
          ok: false,
          errors: [`failed to read raw settings: ${error instanceof Error ? error.message : String(error)}`],
        };
      }

      if (rawSettings == null) {
        // 没存过 raw settings 也算「合法」：normalizeSettings 会用全默认值兜底
        return { ok: true, errors: [] };
      }

      const result = EwSettingsSchema.safeParse(rawSettings);
      if (result.success) {
        return { ok: true, errors: [] };
      }

      return {
        ok: false,
        errors: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
      };
    },
    runNow: async message => {
      const text = message ?? '';
      const input = text.trim() || (getChatMessages(-1)[0]?.message ?? '');
      const result = await runWorkflow({
        message_id: getLastMessageId(),
        user_input: input,
        mode: 'manual',
        inject_reply: false,
      });
      return { ok: result.ok, reason: result.reason };
    },
    getLastRun: () => getLastRun(),
    getLastIo: () => getLastIo(),
    validateControllerSyntax,
    rollbackController,
    rerollCurrentAfterReply: () => rerollCurrentAfterReplyWorkflow(),
    rederiveWorkflowAtFloor: input => rederiveWorkflowAtFloor(input),
    localizeSnapshots: async () => {
      try {
        const result = await localizeSnapshotsForCurrentChat(getSettings());
        return { ok: true, result };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  window.EvolutionWorldAPI = api;
}

export function disposeGlobalApi() {
  delete window.EvolutionWorldAPI;
}
