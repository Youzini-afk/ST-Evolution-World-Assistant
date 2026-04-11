import { getHostRuntime, tryGetSTContext } from '../st-adapter';
import type { EwFlowConfig } from './types';
import type { ResolvedWiEntry } from './worldinfo-engine';

type WorkflowRegexRole = 'system' | 'user' | 'assistant' | 'mixed';
type WorkflowRegexSourceType = 'user_input' | 'ai_output' | 'world_info' | 'reasoning';
type WorkflowRegexTargetKind = 'chat' | 'world_info';

type HostRegexExecutionMode = 'host-formatter' | 'host-fallback' | 'host-unavailable' | 'off';

type RegexScript = {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  sourceFlags: {
    user: boolean;
    assistant: boolean;
    worldInfo: boolean;
    reasoning: boolean;
    system: boolean;
  };
  destinationFlags: {
    prompt: boolean;
    display: boolean;
  };
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number | boolean;
  minDepth: number | null;
  maxDepth: number | null;
  isTavernRule: boolean;
  beautificationReplace: boolean;
  sourceType: 'global' | 'preset' | 'character' | 'local';
  _placementMode?: 'canonical' | 'raw';
};

type WorkflowRegexApplicationSummary = {
  hostEnabled: boolean;
  hostExecutionMode: HostRegexExecutionMode;
  formatterAvailable: boolean;
  hostRuleCount: number;
  localRuleCount: number;
  skippedDisplayOnlyRuleCount: number;
  hostAppliedCount: number;
  localAppliedCount: number;
  chatMessagesProcessed: number;
  chatMessagesChanged: number;
  worldInfoEntriesProcessed: number;
  worldInfoEntriesChanged: number;
};

type RegexTransformDebug = {
  hostApplied: boolean;
  localAppliedRuleCount: number;
};

type TavernRegexGetter = ((option: { type: 'global' | 'preset' | 'character'; name?: string }) => any[]) | undefined;
type CharacterRegexEnabledGetter = (() => boolean) | undefined;
type TavernRegexFormatter =
  | ((
      text: string,
      source: 'user_input' | 'ai_output' | 'slash_command' | 'world_info' | 'reasoning',
      destination: 'display' | 'prompt',
      options?: { depth?: number; character_name?: string },
    ) => string)
  | undefined;

const HTML_TAG_PATTERN =
  /<\/?(?:div|span|p|br|hr|img|details|summary|section|article|aside|header|footer|nav|ul|ol|li|table|tr|td|th|h[1-6]|a|em|strong|blockquote|pre|code|svg|path)\b/i;
const HTML_ATTR_PATTERN = /\b(?:style|class|id|href|src|data-)\s*=/i;

function readArrayPath(root: any, paths: string[][]): any[] {
  for (const path of paths) {
    let current = root;
    let ok = true;
    for (const segment of path) {
      if (current == null || typeof current !== 'object') {
        ok = false;
        break;
      }
      current = current[segment];
    }
    if (ok && Array.isArray(current)) {
      return current;
    }
  }
  return [];
}

function normalizeTrimStrings(rawTrim: unknown): string[] {
  if (Array.isArray(rawTrim)) {
    return rawTrim.map(item => String(item ?? '')).filter(Boolean);
  }
  if (typeof rawTrim === 'string') {
    return rawTrim
      .split('\n')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePlacementFromSource(source: any): number[] | null {
  if (!source || typeof source !== 'object') return null;

  const placement: number[] = [];
  if (source.user_input) placement.push(0);
  if (source.ai_output) placement.push(1);
  if (source.slash_command) placement.push(2);
  if (source.world_info) placement.push(3);
  if (source.reasoning) placement.push(4);
  return placement;
}

function normalizePlacementMode(scripts: RegexScript[]): void {
  const hasModernRawPlacement = scripts.some(
    script => script._placementMode === 'raw' && script.placement.some(value => value >= 5),
  );

  if (!hasModernRawPlacement) return;

  const modernPlacementMap: Record<number, number> = {
    1: 0,
    2: 1,
    3: 2,
    5: 3,
    6: 4,
  };

  for (const script of scripts) {
    if (script._placementMode !== 'raw') continue;
    script.placement = [...new Set(script.placement.map(value => modernPlacementMap[value] ?? value))];
    script._placementMode = 'canonical';
  }
}

function buildSourceFlags(source: any, placement: number[], isTavernRule: boolean): RegexScript['sourceFlags'] {
  if (source && typeof source === 'object') {
    const user = Boolean(source.user_input);
    const assistant = Boolean(source.ai_output);
    const worldInfo = Boolean(source.world_info);
    const reasoning = Boolean(source.reasoning);
    return {
      user,
      assistant,
      worldInfo,
      reasoning,
      system: assistant || worldInfo || reasoning,
    };
  }

  if (isTavernRule && placement.length > 0) {
    const user = placement.includes(0);
    const assistant = placement.includes(1);
    const worldInfo = placement.includes(3);
    const reasoning = placement.includes(4);
    return {
      user,
      assistant,
      worldInfo,
      reasoning,
      system: assistant || worldInfo || reasoning,
    };
  }

  return {
    user: true,
    assistant: true,
    worldInfo: true,
    reasoning: true,
    system: true,
  };
}

function normalizeScript(raw: any, sourceType: RegexScript['sourceType'], index: number, isTavernRule: boolean): RegexScript {
  const source = raw?.source && typeof raw.source === 'object' ? raw.source : null;
  const destination = raw?.destination && typeof raw.destination === 'object' ? raw.destination : null;
  const placementFromSource = normalizePlacementFromSource(source);
  const placement =
    placementFromSource ??
    (Array.isArray(raw?.placement) ? raw.placement.map((item: unknown) => Number(item)).filter(Number.isFinite) : []);
  const replaceString = String(raw?.replaceString ?? raw?.replace_string ?? '');

  return {
    id: String(raw?.id ?? `${sourceType}:${index}`),
    scriptName: String(raw?.scriptName ?? raw?.script_name ?? raw?.name ?? ''),
    findRegex: String(raw?.findRegex ?? raw?.find_regex ?? ''),
    replaceString,
    trimStrings: normalizeTrimStrings(raw?.trimStrings ?? raw?.trim_strings),
    sourceFlags: buildSourceFlags(source, placement, isTavernRule),
    destinationFlags: {
      prompt: destination ? Boolean(destination.prompt) : raw?.markdownOnly === true ? false : true,
      display: destination ? Boolean(destination.display) : Boolean(raw?.markdownOnly),
    },
    placement,
    disabled: raw?.enabled === false || Boolean(raw?.disabled),
    markdownOnly: Boolean(raw?.markdownOnly),
    promptOnly: Boolean(raw?.promptOnly),
    runOnEdit: Boolean(raw?.runOnEdit ?? raw?.run_on_edit),
    substituteRegex: raw?.substituteRegex ?? 0,
    minDepth: Number.isFinite(Number(raw?.minDepth ?? raw?.min_depth)) ? Number(raw?.minDepth ?? raw?.min_depth) : null,
    maxDepth: Number.isFinite(Number(raw?.maxDepth ?? raw?.max_depth)) ? Number(raw?.maxDepth ?? raw?.max_depth) : null,
    isTavernRule,
    beautificationReplace: isBeautificationReplace(replaceString),
    sourceType,
    _placementMode: placementFromSource ? 'canonical' : 'raw',
  };
}

function parseRegexFromString(regexStr: string): RegExp | null {
  if (!regexStr) return null;
  const match = regexStr.trim().match(/^\/([\s\S]+)\/([gimsuy]*)$/);
  if (match) {
    try {
      return new RegExp(match[1], match[2]);
    } catch {
      return null;
    }
  }

  try {
    return new RegExp(regexStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } catch {
    return null;
  }
}

function roleToSourceType(role: WorkflowRegexRole): WorkflowRegexSourceType {
  return role === 'user' ? 'user_input' : 'ai_output';
}

function sourceMatchesRule(rule: RegexScript, sourceType: WorkflowRegexSourceType, role: WorkflowRegexRole): boolean {
  if (sourceType === 'user_input') {
    return role === 'mixed' ? rule.sourceFlags.user || rule.sourceFlags.assistant : rule.sourceFlags.user;
  }
  if (sourceType === 'ai_output') {
    if (role === 'mixed') return rule.sourceFlags.user || rule.sourceFlags.assistant;
    if (role === 'user') return rule.sourceFlags.user;
    return rule.sourceFlags.assistant;
  }
  if (sourceType === 'world_info') {
    return rule.sourceFlags.worldInfo;
  }
  return rule.sourceFlags.reasoning;
}

function depthMatchesRule(rule: RegexScript, depth: number | null | undefined): boolean {
  if (!Number.isFinite(Number(depth))) {
    return true;
  }
  const normalizedDepth = Number(depth);
  if (rule.minDepth != null && normalizedDepth < Number(rule.minDepth)) {
    return false;
  }
  if (rule.maxDepth != null && normalizedDepth > Number(rule.maxDepth)) {
    return false;
  }
  return true;
}

function applyRule(text: string, rule: RegexScript): { text: string; changed: boolean; error?: string } {
  const regex = parseRegexFromString(rule.findRegex);
  if (!regex) {
    return { text, changed: false, error: 'invalid_regex' };
  }

  let next = text.replace(regex, rule.replaceString || '');
  for (const trimText of rule.trimStrings) {
    if (!trimText) continue;
    next = next.split(trimText).join('');
  }

  return {
    text: next,
    changed: next !== text,
  };
}

function resolveRegexHost(): {
  getTavernRegexes: TavernRegexGetter;
  isCharacterTavernRegexesEnabled: CharacterRegexEnabledGetter;
  formatAsTavernRegexedString: TavernRegexFormatter;
  sourceLabel: string;
} {
  const ctx = tryGetSTContext() as Record<string, any> | undefined;
  const win = getHostRuntime() as any;

  return {
    getTavernRegexes: ctx?.getTavernRegexes ?? win.getTavernRegexes,
    isCharacterTavernRegexesEnabled: ctx?.isCharacterTavernRegexesEnabled ?? win.isCharacterTavernRegexesEnabled,
    formatAsTavernRegexedString: ctx?.formatAsTavernRegexedString ?? win.formatAsTavernRegexedString,
    sourceLabel: ctx?.formatAsTavernRegexedString
      ? 'ctx.formatAsTavernRegexedString'
      : win.formatAsTavernRegexedString
        ? 'window.formatAsTavernRegexedString'
        : ctx?.getTavernRegexes
          ? 'ctx.getTavernRegexes'
          : win.getTavernRegexes
            ? 'window.getTavernRegexes'
            : 'unavailable',
  };
}

function collectViaApi(
  source: 'global' | 'preset' | 'character',
  host: ReturnType<typeof resolveRegexHost>,
): { items: any[]; supported: boolean } {
  const getter = host.getTavernRegexes;
  if (typeof getter !== 'function') {
    return { items: [], supported: false };
  }

  try {
    if (source === 'global') {
      return { items: getter({ type: 'global' }) ?? [], supported: true };
    }
    if (source === 'preset') {
      return { items: getter({ type: 'preset', name: 'in_use' }) ?? [], supported: true };
    }
    if (typeof host.isCharacterTavernRegexesEnabled === 'function' && !host.isCharacterTavernRegexesEnabled()) {
      return { items: [], supported: true };
    }
    return { items: getter({ type: 'character', name: 'current' }) ?? [], supported: true };
  } catch {
    return { items: [], supported: false };
  }
}

export function collectAllRegexScripts(): RegexScript[] {
  const scriptsById = new Map<string, RegexScript>();
  const host = resolveRegexHost();
  const ctx = tryGetSTContext() as Record<string, any> | undefined;
  const win = getHostRuntime() as any;

  const addScripts = (items: any[], sourceType: 'global' | 'preset' | 'character') => {
    items.forEach((item, index) => {
      if (!item) return;
      const normalized = normalizeScript(item, sourceType, index, true);
      if (normalized.disabled || !normalized.findRegex) return;

      const key = normalized.id || `${sourceType}:${index}:${normalized.scriptName}:${normalized.findRegex}`;
      scriptsById.set(key, normalized);
    });
  };

  const globalViaApi = collectViaApi('global', host);
  if (globalViaApi.supported) {
    addScripts(globalViaApi.items, 'global');
  } else {
    addScripts(readArrayPath(ctx?.extensionSettings ?? win.extension_settings, [['regex'], ['regex', 'regex_scripts']]), 'global');
  }

  const presetViaApi = collectViaApi('preset', host);
  if (presetViaApi.supported) {
    addScripts(presetViaApi.items, 'preset');
  } else {
    addScripts(readArrayPath(ctx?.chatCompletionSettings ?? win.oai_settings, [['regex_scripts'], ['extensions', 'regex_scripts']]), 'preset');
  }

  const characterViaApi = collectViaApi('character', host);
  if (characterViaApi.supported) {
    addScripts(characterViaApi.items, 'character');
  } else {
    const charId = Number(ctx?.characterId);
    const char = Number.isFinite(charId) && Array.isArray(ctx?.characters) ? ctx?.characters[charId] : null;
    addScripts(readArrayPath(char, [['extensions', 'regex_scripts'], ['data', 'extensions', 'regex_scripts']]), 'character');
  }

  const scripts = [...scriptsById.values()];
  normalizePlacementMode(scripts);
  return scripts;
}

function collectLocalRegexRules(flow: EwFlowConfig): RegexScript[] {
  return (Array.isArray(flow.custom_regex_rules) ? flow.custom_regex_rules : [])
    .map((rule, index) => normalizeScript(rule, 'local', index, false))
    .filter(rule => !rule.disabled && Boolean(rule.findRegex));
}

export function isBeautificationReplace(replaceString: string): boolean {
  if (!replaceString) return false;
  return HTML_TAG_PATTERN.test(replaceString) || HTML_ATTR_PATTERN.test(replaceString);
}

function buildHostExecutionMode(flow: EwFlowConfig, host: ReturnType<typeof resolveRegexHost>): HostRegexExecutionMode {
  if (!flow.use_tavern_regex) {
    return 'off';
  }
  if (typeof host.formatAsTavernRegexedString === 'function') {
    return 'host-formatter';
  }
  if (typeof host.getTavernRegexes === 'function') {
    return 'host-fallback';
  }
  return 'host-unavailable';
}

function applyTavernRegexFallback(
  text: string,
  rules: RegexScript[],
  sourceType: WorkflowRegexSourceType,
  role: WorkflowRegexRole,
  depth: number | null | undefined,
): { text: string; appliedCount: number; skippedDisplayOnlyRuleCount: number } {
  let next = text;
  let appliedCount = 0;
  let skippedDisplayOnlyRuleCount = 0;

  for (const rule of rules) {
    if (!rule.destinationFlags.prompt || rule.markdownOnly || rule.promptOnly) {
      skippedDisplayOnlyRuleCount += 1;
      continue;
    }
    if (rule.beautificationReplace) {
      skippedDisplayOnlyRuleCount += 1;
      continue;
    }
    if (!sourceMatchesRule(rule, sourceType, role)) continue;
    if (!depthMatchesRule(rule, depth)) continue;

    const result = applyRule(next, rule);
    if (result.error) {
      console.warn(`[EW Regex] 酒馆正则 "${rule.scriptName || rule.id}" 无效，已跳过`);
      continue;
    }
    if (result.changed) {
      appliedCount += 1;
      next = result.text;
    }
  }

  return {
    text: next,
    appliedCount,
    skippedDisplayOnlyRuleCount,
  };
}

function applyLocalRegexRules(
  text: string,
  localRules: RegexScript[],
  sourceType: WorkflowRegexSourceType,
  role: WorkflowRegexRole,
  depth: number | null | undefined,
): { text: string; appliedCount: number } {
  let next = text;
  let appliedCount = 0;

  for (const rule of localRules) {
    if (!rule.destinationFlags.prompt || rule.markdownOnly) continue;
    if (!sourceMatchesRule(rule, sourceType, role)) continue;
    if (!depthMatchesRule(rule, depth)) continue;

    const result = applyRule(next, rule);
    if (result.error) {
      console.warn(`[EW Regex] 自定义正则 "${rule.scriptName || rule.id}" 无效，已跳过`);
      continue;
    }
    if (result.changed) {
      appliedCount += 1;
      next = result.text;
    }
  }

  return {
    text: next,
    appliedCount,
  };
}

function transformTextWithWorkflowRegex(
  flow: EwFlowConfig,
  text: string,
  options: {
    sourceType: WorkflowRegexSourceType;
    role: WorkflowRegexRole;
    depth?: number | null;
    hostRules: RegexScript[];
    localRules: RegexScript[];
    hostExecutionMode: HostRegexExecutionMode;
    formatter: TavernRegexFormatter;
  },
): { text: string; debug: RegexTransformDebug; skippedDisplayOnlyRuleCount: number } {
  let next = text;
  let hostApplied = false;
  let localAppliedRuleCount = 0;
  let skippedDisplayOnlyRuleCount = 0;

  if (options.hostExecutionMode === 'host-formatter' && typeof options.formatter === 'function') {
    try {
      const formatted = String(
        options.formatter(next, options.sourceType, 'prompt', {
          ...(Number.isFinite(Number(options.depth)) ? { depth: Number(options.depth) } : {}),
        }) ?? next,
      );
      hostApplied = formatted !== next;
      next = formatted;
    } catch (error) {
      console.debug('[EW Regex] 宿主 formatter 执行失败，回退插件侧兼容执行', error);
      const fallback = applyTavernRegexFallback(next, options.hostRules, options.sourceType, options.role, options.depth);
      next = fallback.text;
      hostApplied = fallback.appliedCount > 0;
      skippedDisplayOnlyRuleCount += fallback.skippedDisplayOnlyRuleCount;
    }
  } else if (options.hostExecutionMode === 'host-fallback') {
    const fallback = applyTavernRegexFallback(next, options.hostRules, options.sourceType, options.role, options.depth);
    next = fallback.text;
    hostApplied = fallback.appliedCount > 0;
    skippedDisplayOnlyRuleCount += fallback.skippedDisplayOnlyRuleCount;
  }

  const localResult = applyLocalRegexRules(next, options.localRules, options.sourceType, options.role, options.depth);
  next = localResult.text;
  localAppliedRuleCount = localResult.appliedCount;

  return {
    text: next,
    debug: {
      hostApplied,
      localAppliedRuleCount,
    },
    skippedDisplayOnlyRuleCount,
  };
}

function summarizeWorkflowRegex(
  flow: EwFlowConfig,
  hostExecutionMode: HostRegexExecutionMode,
  formatterAvailable: boolean,
  hostRules: RegexScript[],
  localRules: RegexScript[],
): WorkflowRegexApplicationSummary {
  return {
    hostEnabled: flow.use_tavern_regex,
    hostExecutionMode,
    formatterAvailable,
    hostRuleCount: hostRules.length,
    localRuleCount: localRules.length,
    skippedDisplayOnlyRuleCount: 0,
    hostAppliedCount: 0,
    localAppliedCount: 0,
    chatMessagesProcessed: 0,
    chatMessagesChanged: 0,
    worldInfoEntriesProcessed: 0,
    worldInfoEntriesChanged: 0,
  };
}

function applyRegexToChatMessages(
  flow: EwFlowConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>,
  hostRules: RegexScript[],
  localRules: RegexScript[],
  hostExecutionMode: HostRegexExecutionMode,
  formatter: TavernRegexFormatter,
  summary: WorkflowRegexApplicationSummary,
): void {
  const total = messages.length;
  messages.forEach((message, index) => {
    summary.chatMessagesProcessed += 1;
    const depth = Math.max(total - index - 1, 0);
    const original = message.content;
    const result = transformTextWithWorkflowRegex(flow, message.content, {
      sourceType: roleToSourceType(message.role),
      role: message.role,
      depth,
      hostRules,
      localRules,
      hostExecutionMode,
      formatter,
    });
    summary.skippedDisplayOnlyRuleCount += result.skippedDisplayOnlyRuleCount;
    if (result.debug.hostApplied) summary.hostAppliedCount += 1;
    if (result.debug.localAppliedRuleCount > 0) summary.localAppliedCount += result.debug.localAppliedRuleCount;
    if (result.text !== original) {
      summary.chatMessagesChanged += 1;
      message.content = result.text;
    }
  });
}

function applyRegexToWorldInfoEntries(
  flow: EwFlowConfig,
  entries: ResolvedWiEntry[],
  hostRules: RegexScript[],
  localRules: RegexScript[],
  hostExecutionMode: HostRegexExecutionMode,
  formatter: TavernRegexFormatter,
  summary: WorkflowRegexApplicationSummary,
): void {
  for (const entry of entries) {
    summary.worldInfoEntriesProcessed += 1;
    const original = entry.content;
    const result = transformTextWithWorkflowRegex(flow, entry.content, {
      sourceType: 'world_info',
      role: entry.role === 'user' || entry.role === 'assistant' ? entry.role : 'system',
      depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : null,
      hostRules,
      localRules,
      hostExecutionMode,
      formatter,
    });
    summary.skippedDisplayOnlyRuleCount += result.skippedDisplayOnlyRuleCount;
    if (result.debug.hostApplied) summary.hostAppliedCount += 1;
    if (result.debug.localAppliedRuleCount > 0) summary.localAppliedCount += result.debug.localAppliedRuleCount;
    if (result.text !== original) {
      summary.worldInfoEntriesChanged += 1;
      entry.content = result.text;
    }
  }
}

export function applyWorkflowPromptRegex(
  flow: EwFlowConfig,
  targets: {
    chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>;
    worldInfoBefore: ResolvedWiEntry[];
    worldInfoAfter: ResolvedWiEntry[];
  },
): WorkflowRegexApplicationSummary {
  const host = resolveRegexHost();
  const hostExecutionMode = buildHostExecutionMode(flow, host);
  const hostRules = flow.use_tavern_regex ? collectAllRegexScripts() : [];
  const localRules = collectLocalRegexRules(flow);
  const summary = summarizeWorkflowRegex(
    flow,
    hostExecutionMode,
    typeof host.formatAsTavernRegexedString === 'function',
    hostRules,
    localRules,
  );

  if (targets.chatMessages.length > 0) {
    applyRegexToChatMessages(
      flow,
      targets.chatMessages,
      hostRules,
      localRules,
      hostExecutionMode,
      host.formatAsTavernRegexedString,
      summary,
    );
  }

  if (targets.worldInfoBefore.length > 0) {
    applyRegexToWorldInfoEntries(
      flow,
      targets.worldInfoBefore,
      hostRules,
      localRules,
      hostExecutionMode,
      host.formatAsTavernRegexedString,
      summary,
    );
  }

  if (targets.worldInfoAfter.length > 0) {
    applyRegexToWorldInfoEntries(
      flow,
      targets.worldInfoAfter,
      hostRules,
      localRules,
      hostExecutionMode,
      host.formatAsTavernRegexedString,
      summary,
    );
  }

  return summary;
}

export function describeWorkflowRegexSummary(summary: WorkflowRegexApplicationSummary): string {
  const hostLabel =
    summary.hostExecutionMode === 'off'
      ? '关闭'
      : summary.hostExecutionMode === 'host-formatter'
        ? '宿主直用'
        : summary.hostExecutionMode === 'host-fallback'
          ? '插件回退'
          : '宿主不可用';
  return `已执行正则链：宿主=${hostLabel}，宿主规则=${summary.hostRuleCount}，本地规则=${summary.localRuleCount}，聊天命中=${summary.chatMessagesChanged}/${summary.chatMessagesProcessed}，世界书命中=${summary.worldInfoEntriesChanged}/${summary.worldInfoEntriesProcessed}`;
}

export function applyTavernRegex(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>,
): void {
  const host = resolveRegexHost();
  const hostExecutionMode: HostRegexExecutionMode =
    typeof host.formatAsTavernRegexedString === 'function'
      ? 'host-formatter'
      : typeof host.getTavernRegexes === 'function'
        ? 'host-fallback'
        : 'host-unavailable';
  const hostRules = collectAllRegexScripts();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const result = transformTextWithWorkflowRegex(
      {
        use_tavern_regex: true,
        custom_regex_rules: [],
      } as unknown as EwFlowConfig,
      message.content,
      {
        sourceType: roleToSourceType(message.role),
        role: message.role,
        depth: Math.max(messages.length - index - 1, 0),
        hostRules,
        localRules: [],
        hostExecutionMode,
        formatter: host.formatAsTavernRegexedString,
      },
    );
    message.content = result.text;
  }
}

export function applyTavernRegexFallbackForTest(
  text: string,
  rawRules: any[],
  sourceType: WorkflowRegexSourceType,
  role: WorkflowRegexRole,
  depth?: number | null,
): { text: string; appliedCount: number; skippedDisplayOnlyRuleCount: number } {
  return applyTavernRegexFallback(
    text,
    rawRules.map((rule, index) => normalizeScript(rule, 'global', index, true)),
    sourceType,
    role,
    depth,
  );
}

export function applyLocalWorkflowRegexForTest(
  text: string,
  rawRules: any[],
  sourceType: WorkflowRegexSourceType,
  role: WorkflowRegexRole,
  depth?: number | null,
): { text: string; appliedCount: number } {
  return applyLocalRegexRules(
    text,
    rawRules.map((rule, index) => normalizeScript(rule, 'local', index, false)),
    sourceType,
    role,
    depth,
  );
}
