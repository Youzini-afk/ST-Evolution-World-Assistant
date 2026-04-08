import { getHostRuntime as getStHostRuntime, tryGetSTContext } from '../st-adapter';
import { renderEjsContent } from './ejs-internal';
import { isEwHiddenMessageIndex } from './hide-engine';
import { isLikelyMvuWorldInfoContent, stripBlockedPromptContents, stripMvuPromptArtifacts } from './mvu-compat';
import { applyTavernRegex } from './regex-engine';
import type { ContextCursor, EwFlowConfig, EwPromptOrderEntry, EwSettings } from './types';
import { collectIgnoredWorldInfoContents, resolveWorldInfo, type ResolvedWiEntry } from './worldinfo-engine';

// SillyTavern 运行时全局变量，在扩展上下文中可用
declare function getCharacterCardFields():
  | {
      description: string;
      personality: string;
      persona: string;
      scenario: string;
      mesExamples: string;
      system: string;
      jailbreak: string;
    }
  | undefined;
declare function getLastMessageId(): number;
declare function getChatMessages(range: string, opts?: Record<string, any>): any[];
declare function getCharData(name: 'current' | string): SillyTavern.v1CharData | null;
declare function getWorldInfoPrompt(
  chat: string[],
  max_context: number,
  is_dry_run: boolean,
): Promise<{
  worldInfoString?: string;
  worldInfoBefore?: string;
  worldInfoAfter?: string;
}>;
declare const this_chid: number | string | undefined;

type PromptDiagnosticKey =
  | 'main'
  | 'charDescription'
  | 'charPersonality'
  | 'scenario'
  | 'personaDescription'
  | 'worldInfoBefore'
  | 'worldInfoAfter'
  | 'dialogueExamples'
  | 'postHistoryInstructions'
  | 'chatHistory';

type PromptDiagnosticAttempt = {
  label: string;
  hasValue: boolean;
  length: number;
  detail?: string;
};

type PromptMarkerDiagnostic = {
  selectedSource?: string;
  attempts: PromptDiagnosticAttempt[];
  note?: string;
  source_mode?: 'host_processed' | 'raw_chat' | 'raw_chat_fallback';
  fallback_reason?: string;
  raw_count?: number;
  processed_count?: number;
  filtered_hidden_count?: number;
  compression_wrapper_detected?: boolean;
  regex_applied?: boolean;
};

type PromptDiagnosticMap = Partial<Record<PromptDiagnosticKey, PromptMarkerDiagnostic>>;

type TextCandidate = {
  label: string;
  value: unknown;
};

function getHostRuntime(): Record<string, any> {
  return getStHostRuntime();
}

function getRuntimeContext(): Record<string, any> | undefined {
  return tryGetSTContext() as Record<string, any> | undefined;
}

function resolveCharacterCardFieldsGetter(): {
  getter?: ({ chid }?: { chid?: number }) => any;
  source?: string;
} {
  const hostRuntime = getHostRuntime();
  const ctx = getRuntimeContext();

  if (typeof ctx?.getCharacterCardFields === 'function') {
    return { getter: ctx.getCharacterCardFields, source: 'ctx.getCharacterCardFields' };
  }
  if (typeof hostRuntime.getCharacterCardFields === 'function') {
    return { getter: hostRuntime.getCharacterCardFields, source: 'hostRuntime.getCharacterCardFields' };
  }
  if (typeof (hostRuntime as any).SillyTavern?.getCharacterCardFields === 'function') {
    return {
      getter: (hostRuntime as any).SillyTavern.getCharacterCardFields,
      source: 'hostRuntime.SillyTavern.getCharacterCardFields',
    };
  }
  if (typeof getCharacterCardFields === 'function') {
    return { getter: getCharacterCardFields, source: 'global getCharacterCardFields' };
  }

  return {};
}

function hasCharacterCardFieldValue(fields: ReturnType<typeof getCharacterCardFields> | undefined): boolean {
  if (!fields) {
    return false;
  }

  return Boolean(
    fields.description?.trim() ||
    fields.personality?.trim() ||
    fields.persona?.trim() ||
    fields.scenario?.trim() ||
    fields.mesExamples?.trim() ||
    fields.system?.trim() ||
    fields.jailbreak?.trim(),
  );
}

function resolveRuntimeCharacterCardFields(): {
  fields?: ReturnType<typeof getCharacterCardFields>;
  source?: string;
  note?: string;
} {
  const { getter, source } = resolveCharacterCardFieldsGetter();
  if (typeof getter !== 'function') {
    return { note: '未检测到 getCharacterCardFields getter' };
  }

  const chid = getRuntimeCharacterId();
  if (Number.isFinite(chid) && chid >= 0) {
    const withChid = getter({ chid });
    if (hasCharacterCardFieldValue(withChid)) {
      return { fields: withChid, source: `${source}({ chid: ${chid} })` };
    }

    const withoutChid = getter();
    if (hasCharacterCardFieldValue(withoutChid)) {
      return {
        fields: withoutChid,
        source: `${source}()`,
        note: `带 chid 调用为空，已回退到无参调用；chid=${chid}`,
      };
    }

    return {
      fields: withChid ?? withoutChid,
      source: `${source}({ chid: ${chid} })`,
      note: `getter 存在，但带 chid 与无参调用都为空；chid=${chid}`,
    };
  }

  const withoutChid = getter();
  return {
    fields: withoutChid,
    source: `${source}()`,
    note: '未解析出有效 chid，直接使用无参调用',
  };
}

function getRuntimeCharacterCardFields(): ReturnType<typeof getCharacterCardFields> {
  return resolveRuntimeCharacterCardFields().fields;
}

function getRuntimeCharacterId(): number {
  const hostRuntime = getHostRuntime();
  const ctx = getRuntimeContext();

  const candidates = [
    ctx?.characterId,
    hostRuntime.SillyTavern?.characterId,
    hostRuntime.this_chid,
    (globalThis as any).this_chid,
    this_chid,
  ];

  for (const value of candidates) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue >= 0) {
      return numberValue;
    }
  }

  return -1;
}

function getRuntimeCharacters(): SillyTavern.v1CharData[] {
  const hostRuntime = getHostRuntime();
  const ctx = getRuntimeContext();
  const candidates = [
    hostRuntime.SillyTavern?.characters,
    ctx?.characters,
    hostRuntime.characters,
    (globalThis as any).SillyTavern?.characters,
    (globalThis as any).characters,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate as SillyTavern.v1CharData[];
    }
  }

  return [];
}

function getRuntimeCharData(): { value: SillyTavern.v1CharData | null; source?: string; note?: string } {
  const hostRuntime = getHostRuntime();
  const ctx = getRuntimeContext();
  const characterId = getRuntimeCharacterId();
  const runtimeCharacters = getRuntimeCharacters();

  if (typeof hostRuntime.getCharData === 'function') {
    const current = hostRuntime.getCharData('current') ?? null;
    if (current) {
      return { value: current, source: 'hostRuntime.getCharData(current)' };
    }
  }

  if (typeof getCharData === 'function') {
    const current = getCharData('current') ?? null;
    if (current) {
      return { value: current, source: 'global getCharData(current)' };
    }
  }

  if (Number.isFinite(characterId) && characterId >= 0 && runtimeCharacters[characterId]) {
    return {
      value: runtimeCharacters[characterId] as SillyTavern.v1CharData,
      source: `runtimeCharacters[${characterId}]`,
    };
  }

  if (Number.isFinite(Number(ctx?.characterId)) && Number(ctx?.characterId) >= 0 && Array.isArray(ctx?.characters)) {
    return {
      value: (ctx.characters[Number(ctx.characterId)] as SillyTavern.v1CharData) ?? null,
      source: `ctx.characters[${Number(ctx.characterId)}]`,
    };
  }

  return {
    value: null,
    note: `characterId=${characterId}; runtimeCharacters=${runtimeCharacters.length}; ctx.characterId=${String(ctx?.characterId ?? '')}`,
  };
}

function getRuntimeLastMessageId(): number {
  const hostRuntime = getHostRuntime();
  if (typeof hostRuntime.getLastMessageId === 'function') {
    return Number(hostRuntime.getLastMessageId());
  }

  return getLastMessageId();
}

function getRuntimeChatMessages(range: string, opts?: Record<string, any>): any[] {
  const hostRuntime = getHostRuntime();
  if (typeof hostRuntime.getChatMessages === 'function') {
    return hostRuntime.getChatMessages(range, opts);
  }

  return getChatMessages(range, opts);
}

function getRuntimeRawChat(): any[] {
  const ctx = getRuntimeContext();
  if (Array.isArray(ctx?.chat)) {
    return ctx.chat;
  }

  const hostRuntime = getHostRuntime();
  const hostChat = hostRuntime.SillyTavern?.getContext?.()?.chat;
  if (Array.isArray(hostChat)) {
    return hostChat;
  }

  return [];
}

function resolveWorkflowChatRole(msg: any): 'system' | 'user' | 'assistant' {
  if (msg?.role === 'system' || msg?.role === 'user' || msg?.role === 'assistant') {
    return msg.role;
  }
  if (msg?.is_user === true) {
    return 'user';
  }
  if (msg?.is_system === true) {
    return 'system';
  }
  return 'assistant';
}

function resolveWorkflowChatText(msg: any): string {
  const candidates = [msg?.mes, msg?.message, msg?.text];
  for (const value of candidates) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function resolveWorkflowChatMessageId(msg: any, fallbackIndex: number): number {
  const resolved = Number(msg?.message_id ?? msg?.mesid ?? fallbackIndex);
  return Number.isFinite(resolved) ? Math.max(0, Math.trunc(resolved)) : Math.max(0, fallbackIndex);
}

function shouldFilterWorkflowHiddenMessage(settings: EwSettings | undefined, messageId: number): boolean {
  const hideState = settings?.hide_settings;
  if (!hideState?.enabled || !hideState.affect_workflow_context) {
    return false;
  }
  return isEwHiddenMessageIndex(messageId);
}

type WorkflowChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
  message_id: number;
};

type WorkflowChatCollectionResult = {
  messages: WorkflowChatMessage[];
  total_count: number;
  filtered_hidden_count: number;
};

function collectProcessedWorkflowChatMessages(
  lastId: number,
  settings?: EwSettings,
): WorkflowChatCollectionResult {
  if (lastId < 0) {
    return { messages: [], total_count: 0, filtered_hidden_count: 0 };
  }

  const msgs = getRuntimeChatMessages(`0-${lastId}`);
  let filteredHiddenCount = 0;
  const normalized = (Array.isArray(msgs) ? msgs : [])
    .map<WorkflowChatMessage | null>((msg: any, index: number) => {
      const messageId = resolveWorkflowChatMessageId(msg, index);
      if (shouldFilterWorkflowHiddenMessage(settings, messageId)) {
        filteredHiddenCount += 1;
        return null;
      }

      const sanitized = sanitizeWorkflowChatMessage(resolveWorkflowChatText(msg), settings);
      return {
        role: resolveWorkflowChatRole(msg),
        content: sanitized.content,
        name: typeof msg?.name === 'string' ? msg.name : undefined,
        message_id: messageId,
      } satisfies WorkflowChatMessage;
    })
    .filter((msg): msg is WorkflowChatMessage => Boolean(msg && msg.content.trim()));

  return {
    messages: normalized,
    total_count: normalized.length,
    filtered_hidden_count: filteredHiddenCount,
  };
}

function collectRawWorkflowChatMessages(lastId: number, settings?: EwSettings): WorkflowChatCollectionResult {
  if (lastId < 0) {
    return { messages: [], total_count: 0, filtered_hidden_count: 0 };
  }

  const rawChat = getRuntimeRawChat().slice(0, lastId + 1);
  let filteredHiddenCount = 0;
  const normalized = rawChat
    .map<WorkflowChatMessage | null>((msg: any, index: number) => {
      const messageId = resolveWorkflowChatMessageId(msg, index);
      if (shouldFilterWorkflowHiddenMessage(settings, messageId)) {
        filteredHiddenCount += 1;
        return null;
      }

      const sanitized = sanitizeWorkflowChatMessage(resolveWorkflowChatText(msg), settings);
      return {
        role: resolveWorkflowChatRole(msg),
        content: sanitized.content,
        name: typeof msg?.name === 'string' ? msg.name : undefined,
        message_id: messageId,
      } satisfies WorkflowChatMessage;
    })
    .filter((msg): msg is WorkflowChatMessage => Boolean(msg && msg.content.trim()));

  return {
    messages: normalized,
    total_count: normalized.length,
    filtered_hidden_count: filteredHiddenCount,
  };
}

const WORKFLOW_CHAT_COMPRESSION_MARKERS = [
  /【压缩相邻消息_聊天记录开头】/i,
  /【压缩相邻消息_聊天记录结尾】/i,
  /<chathistory>/i,
  /<\/chathistory>/i,
];

function detectCompressedWorkflowChatHistory(
  processedMessages: WorkflowChatMessage[],
  rawCount: number,
): { detected: boolean; reason?: string } {
  if (processedMessages.length === 0) {
    return { detected: false };
  }

  const allContent = processedMessages.map(msg => msg.content).join('\n');
  const containsKnownMarkers = WORKFLOW_CHAT_COMPRESSION_MARKERS.some(pattern => pattern.test(allContent));
  const additionalSettingsCount = (allContent.match(/<\/?additional_settings>/gi) ?? []).length;
  const allSystem = processedMessages.every(msg => msg.role === 'system');
  const dialogueCount = processedMessages.filter(msg => msg.role === 'user' || msg.role === 'assistant').length;
  const suspiciouslyFewMessages =
    rawCount >= 6 && processedMessages.length <= Math.max(2, Math.floor(rawCount / 4));

  if (containsKnownMarkers && allSystem) {
    return { detected: true, reason: '宿主聊天历史命中了压缩相邻消息包装标记，且当前结果只剩 system 块。' };
  }

  if (containsKnownMarkers && suspiciouslyFewMessages && dialogueCount === 0) {
    return { detected: true, reason: '宿主聊天历史被压缩包装后只剩少量 system 块，缺少正常 user/assistant 轮次。' };
  }

  if (additionalSettingsCount >= 2 && suspiciouslyFewMessages && dialogueCount === 0) {
    return { detected: true, reason: '宿主聊天历史主要由 additional_settings 包装壳组成，已判定为压缩污染。' };
  }

  return { detected: false };
}

function describeAttempt(label: string, value: unknown, detail?: string): PromptDiagnosticAttempt {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return {
      label,
      hasValue: trimmed.length > 0,
      length: trimmed.length,
      detail,
    };
  }

  if (Array.isArray(value)) {
    return {
      label,
      hasValue: value.length > 0,
      length: value.length,
      detail: detail ?? `array(${value.length})`,
    };
  }

  if (value && typeof value === 'object') {
    const size = Object.keys(value as Record<string, unknown>).length;
    return {
      label,
      hasValue: size > 0,
      length: size,
      detail: detail ?? `object(${size})`,
    };
  }

  return {
    label,
    hasValue: Boolean(value),
    length: 0,
    detail: detail ?? (value == null ? 'nullish' : String(value)),
  };
}

function resolveTextCandidate(
  candidates: TextCandidate[],
  note?: string,
): { value: string; diagnostic: PromptMarkerDiagnostic } {
  const attempts = candidates.map(candidate => describeAttempt(candidate.label, candidate.value));
  const selected = candidates.find(candidate => typeof candidate.value === 'string' && candidate.value.trim());

  return {
    value: typeof selected?.value === 'string' ? selected.value : '',
    diagnostic: {
      selectedSource: selected?.label,
      attempts,
      note,
    },
  };
}

function appendDiagnosticNote(
  diagnostic: PromptMarkerDiagnostic | undefined,
  note: string,
): PromptMarkerDiagnostic | undefined {
  if (!diagnostic) {
    return diagnostic;
  }

  return {
    ...diagnostic,
    note: diagnostic.note ? `${diagnostic.note}; ${note}` : note,
  };
}

function sanitizeWorkflowExtensionPrompt(content: string, blockedContents: string[] = []): string {
  const sanitized = stripBlockedPromptContents(stripMvuPromptArtifacts(content), blockedContents);
  if (isLikelyMvuWorldInfoContent(content) || isLikelyMvuWorldInfoContent(sanitized)) {
    return '';
  }
  return sanitized;
}

const WORKFLOW_IMAGE_BLOCK_PATTERNS = [
  /<image>\s*[\s\S]*?image###[\s\S]*?###\s*<\/image>/gi,
  /<image>[\s\S]*?<\/image>/gi,
];

function stripWorkflowImageBlocks(content: string): { content: string; removedCount: number } {
  if (!content.trim()) {
    return { content, removedCount: 0 };
  }

  let nextContent = content;
  let removedCount = 0;

  for (const pattern of WORKFLOW_IMAGE_BLOCK_PATTERNS) {
    nextContent = nextContent.replace(pattern, match => {
      removedCount += 1;
      return match.includes('\n\n') ? '\n\n' : '\n';
    });
  }

  nextContent = nextContent.replace(/\n{3,}/g, '\n\n').trim();
  return { content: nextContent, removedCount };
}

function sanitizeWorkflowChatMessage(
  content: string,
  settings?: EwSettings,
): { content: string; removedCount: number } {
  if (!settings?.strip_workflow_image_blocks) {
    return { content, removedCount: 0 };
  }

  return stripWorkflowImageBlocks(content);
}

function formatAttempt(attempt: PromptDiagnosticAttempt): string {
  const base = `${attempt.label}: ${attempt.hasValue ? `hit (${attempt.length})` : 'miss (0)'}`;
  return attempt.detail ? `${base} [${attempt.detail}]` : base;
}

function formatDiagnosticBlock(
  diagnostic: PromptMarkerDiagnostic | undefined,
  rawLength: number,
  renderedLength?: number,
): string {
  if (!diagnostic) {
    return [`原始长度: ${rawLength}`, renderedLength === undefined ? '' : `渲染长度: ${renderedLength}`]
      .filter(Boolean)
      .join('\n');
  }

  const lines = [
    `原始长度: ${rawLength}`,
    renderedLength === undefined ? '' : `渲染长度: ${renderedLength}`,
    `命中来源: ${diagnostic.selectedSource ?? '无'}`,
    diagnostic.source_mode ? `上下文源: ${diagnostic.source_mode}` : '',
    diagnostic.fallback_reason ? `回退原因: ${diagnostic.fallback_reason}` : '',
    diagnostic.raw_count === undefined ? '' : `原始聊天条数: ${diagnostic.raw_count}`,
    diagnostic.processed_count === undefined ? '' : `宿主处理后条数: ${diagnostic.processed_count}`,
    diagnostic.filtered_hidden_count === undefined ? '' : `过滤隐藏楼层: ${diagnostic.filtered_hidden_count}`,
    diagnostic.compression_wrapper_detected === undefined
      ? ''
      : `检测到聊天压缩包装: ${diagnostic.compression_wrapper_detected ? '是' : '否'}`,
    diagnostic.regex_applied === undefined ? '' : `已应用酒馆正则: ${diagnostic.regex_applied ? '是' : '否'}`,
    diagnostic.note ? `附加信息: ${diagnostic.note}` : '',
    '来源尝试:',
    ...diagnostic.attempts.map(attempt => `- ${formatAttempt(attempt)}`),
  ].filter(Boolean);

  return lines.join('\n');
}

function getRuntimePersonaDescription(): { value: string; diagnostic: PromptMarkerDiagnostic } {
  const hostRuntime = getHostRuntime();
  const ctx = getRuntimeContext();

  return resolveTextCandidate(
    [
      { label: 'ctx.powerUserSettings.persona_description', value: ctx?.powerUserSettings?.persona_description },
      { label: 'ctx.persona_description', value: ctx?.persona_description },
      { label: 'hostRuntime.power_user.persona_description', value: hostRuntime.power_user?.persona_description },
      {
        label: 'hostRuntime.SillyTavern.powerUserSettings.persona_description',
        value: hostRuntime.SillyTavern?.powerUserSettings?.persona_description,
      },
      {
        label: 'globalThis.power_user.persona_description',
        value: (globalThis as any).power_user?.persona_description,
      },
      { label: 'getCharacterCardFields().persona', value: getRuntimeCharacterCardFields()?.persona },
    ],
    '按 persona_description 的多路径回退顺序选取',
  );
}

function getRuntimeCharacterFields(): {
  main: string;
  jailbreak: string;
  charDescription: string;
  charPersonality: string;
  scenario: string;
  personaDescription: string;
  dialogueExamples: string;
  diagnostics: PromptDiagnosticMap;
} {
  const helperResult = resolveRuntimeCharacterCardFields();
  const helperFields = helperResult.fields;
  const charDataResult = getRuntimeCharData();
  const charData = charDataResult.value;
  const ctx = getRuntimeContext();
  const helperSource = helperResult.source;
  const charDataState = charData
    ? `charData available (${charData.name || charData.avatar || 'unnamed'}) from ${charDataResult.source ?? 'unknown'}`
    : `charData unavailable${charDataResult.note ? `; ${charDataResult.note}` : ''}`;

  const main = resolveTextCandidate(
    [
      { label: 'getCharacterCardFields().system', value: helperFields?.system },
      { label: 'charData.data.system_prompt', value: charData?.data?.system_prompt },
    ],
    '主系统提示词来源',
  );

  const jailbreak = resolveTextCandidate(
    [
      { label: 'getCharacterCardFields().jailbreak', value: helperFields?.jailbreak },
      { label: 'charData.data.post_history_instructions', value: charData?.data?.post_history_instructions },
    ],
    '后历史指令来源',
  );

  const charDescription = resolveTextCandidate(
    [
      { label: 'getCharacterCardFields().description', value: helperFields?.description },
      { label: 'charData.description', value: charData?.description },
      { label: 'charData.data.description', value: charData?.data?.description },
      { label: 'ctx.name2_description', value: ctx?.name2_description },
    ],
    '角色描述多路径回退',
  );

  const charPersonality = resolveTextCandidate(
    [
      { label: 'getCharacterCardFields().personality', value: helperFields?.personality },
      { label: 'charData.personality', value: charData?.personality },
      { label: 'charData.data.personality', value: charData?.data?.personality },
      { label: 'ctx.name2_personality', value: ctx?.name2_personality },
    ],
    '角色性格多路径回退',
  );

  const scenario = resolveTextCandidate(
    [
      { label: 'getCharacterCardFields().scenario', value: helperFields?.scenario },
      { label: 'charData.scenario', value: charData?.scenario },
      { label: 'charData.data.scenario', value: charData?.data?.scenario },
    ],
    '场景字段回退',
  );

  const dialogueExamples = resolveTextCandidate(
    [
      { label: 'getCharacterCardFields().mesExamples', value: helperFields?.mesExamples },
      { label: 'charData.mes_example', value: charData?.mes_example },
      { label: 'charData.data.mes_example', value: charData?.data?.mes_example },
    ],
    '示例对话字段回退',
  );

  const personaDescription = getRuntimePersonaDescription();

  return {
    main: main.value,
    jailbreak: jailbreak.value,
    charDescription: charDescription.value,
    charPersonality: charPersonality.value,
    scenario: scenario.value,
    personaDescription: personaDescription.value,
    dialogueExamples: dialogueExamples.value,
    diagnostics: {
      main: appendDiagnosticNote(main.diagnostic, `helper=${helperSource ?? 'none'}; ${charDataState}`)!,
      postHistoryInstructions: appendDiagnosticNote(
        jailbreak.diagnostic,
        [helperResult.note, `helper=${helperSource ?? 'none'}; ${charDataState}`].filter(Boolean).join('; '),
      )!,
      charDescription: appendDiagnosticNote(
        charDescription.diagnostic,
        [helperResult.note, `helper=${helperSource ?? 'none'}; ${charDataState}`].filter(Boolean).join('; '),
      )!,
      charPersonality: appendDiagnosticNote(
        charPersonality.diagnostic,
        [helperResult.note, `helper=${helperSource ?? 'none'}; ${charDataState}`].filter(Boolean).join('; '),
      )!,
      scenario: appendDiagnosticNote(
        scenario.diagnostic,
        [helperResult.note, `helper=${helperSource ?? 'none'}; ${charDataState}`].filter(Boolean).join('; '),
      )!,
      personaDescription: appendDiagnosticNote(
        personaDescription.diagnostic,
        [helperResult.note, `helper=${helperSource ?? 'none'}; ${charDataState}`].filter(Boolean).join('; '),
      )!,
      dialogueExamples: appendDiagnosticNote(
        dialogueExamples.diagnostic,
        [helperResult.note, `helper=${helperSource ?? 'none'}; ${charDataState}`].filter(Boolean).join('; '),
      )!,
    },
  };
}

async function populateWorldInfoComponents(components: PromptComponents, settings: EwSettings): Promise<void> {
  components.blockedWorldInfoContents = await collectIgnoredWorldInfoContents();

  try {
    const chatTexts = components.chatMessages.map(msg => msg.content).filter(Boolean);
    const resolved = await resolveWorldInfo(settings, chatTexts);

    components.worldInfoBefore = resolved.before;
    components.worldInfoAfter = resolved.after;
    components.activatedWorldInfoEntries = [...resolved.before, ...resolved.after, ...resolved.atDepth];

    // atDepth entries → depth injection system
    for (const entry of resolved.atDepth) {
      components.depthInjections.push({
        content: `【${entry.name}】\n${entry.content}`,
        depth: entry.depth,
        role: entry.role,
      });
    }

    components.diagnostics.worldInfoBefore = {
      selectedSource: 'ew-worldinfo-engine',
      attempts: [
        {
          label: 'resolveWorldInfo().before',
          hasValue: resolved.before.length > 0,
          length: resolved.before.length,
          detail: `${resolved.before.length} entries`,
        },
      ],
      note: `内置世界书引擎: ${resolved.before.length} 条 before 条目`,
    };
    components.diagnostics.worldInfoAfter = {
      selectedSource: 'ew-worldinfo-engine',
      attempts: [
        {
          label: 'resolveWorldInfo().after',
          hasValue: resolved.after.length > 0,
          length: resolved.after.length,
          detail: `${resolved.after.length} entries`,
        },
      ],
      note: `内置世界书引擎: ${resolved.after.length} 条 after 条目, ${resolved.atDepth.length} 条 atDepth 条目`,
    };
  } catch (e) {
    components.diagnostics.worldInfoBefore = appendDiagnosticNote(
      components.diagnostics.worldInfoBefore,
      `world info 读取异常: ${String(e)}`,
    );
    components.diagnostics.worldInfoAfter = appendDiagnosticNote(
      components.diagnostics.worldInfoAfter,
      `world info 读取异常: ${String(e)}`,
    );
    console.debug('[Evolution World] world info engine failed:', e);
  }
}

/**
 * Raw prompt components collected from SillyTavern's runtime environment.
 * Marker-type entries in prompt_order will source their content from here.
 */
export type PromptComponents = {
  main: string;
  jailbreak: string;
  charDescription: string;
  charPersonality: string;
  scenario: string;
  personaDescription: string;
  worldInfoBefore: ResolvedWiEntry[];
  worldInfoAfter: ResolvedWiEntry[];
  activatedWorldInfoEntries: ResolvedWiEntry[];
  dialogueExamples: string;
  chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>;
  /** Extension prompts that need depth-based injection into chat history (ST position=IN_CHAT) */
  depthInjections: Array<{ content: string; depth: number; role: 'system' | 'user' | 'assistant' }>;
  /** Extension prompts that go before all other prompts (ST position=BEFORE_PROMPT) */
  beforePromptInjections: string[];
  /** Exact prompt bodies cloned from ignored world info entries. */
  blockedWorldInfoContents?: string[];
  diagnostics: PromptDiagnosticMap;
};

export type PromptPreviewMessage = AssembledMessage & {
  debugOnly?: boolean;
  previewTitle?: string;
};

type AssemblePreviewOptions = {
  includeMarkerPlaceholders?: boolean;
  templateContext?: Record<string, any>;
};

/**
 * Collect all prompt components from SillyTavern's runtime environment.
 *
 * Gathers raw content for every system marker that can appear in a flow's
 * prompt_order: character card fields, world info, jailbreak, and chat messages.
 */
export async function collectPromptComponents(
  flow: EwFlowConfig,
  settings?: EwSettings,
  contextCursor?: ContextCursor,
): Promise<PromptComponents> {
  const components: PromptComponents = {
    main: '',
    jailbreak: '',
    charDescription: '',
    charPersonality: '',
    scenario: '',
    personaDescription: '',
    worldInfoBefore: [],
    worldInfoAfter: [],
    activatedWorldInfoEntries: [],
    dialogueExamples: '',
    chatMessages: [],
    depthInjections: [],
    beforePromptInjections: [],
    blockedWorldInfoContents: [],
    diagnostics: {},
  };

  // ── 1. Character card fields ──────────────────────────────────────────
  try {
    const fields = getRuntimeCharacterFields();
    components.charDescription = fields.charDescription;
    components.charPersonality = fields.charPersonality;
    components.scenario = fields.scenario;
    components.personaDescription = fields.personaDescription;
    components.dialogueExamples = fields.dialogueExamples;
    components.main = fields.main;
    components.jailbreak = fields.jailbreak;
    Object.assign(components.diagnostics, fields.diagnostics);
  } catch (e) {
    console.debug('[Evolution World] getCharacterCardFields failed:', e);
  }

  // ── 2. Chat messages ──────────────────────────────────────────────────
  try {
    const runtimeLastId = getRuntimeLastMessageId();
    const boundedTargetId = Number.isFinite(contextCursor?.target_message_id)
      ? Math.max(-1, Math.min(runtimeLastId, Math.trunc(Number(contextCursor?.target_message_id ?? -1))))
      : runtimeLastId;
    const lastId = boundedTargetId;
    const chatHistoryAttempts: PromptDiagnosticAttempt[] = [
      {
        label: 'getLastMessageId()',
        hasValue: Number.isFinite(lastId) && lastId >= 0,
        length: Number.isFinite(lastId) ? lastId + 1 : 0,
        detail: `lastId=${lastId}`,
      },
    ];

    if (lastId >= 0) {
      const processedResult = collectProcessedWorkflowChatMessages(lastId, settings);
      const rawResult = collectRawWorkflowChatMessages(lastId, settings);
      const compressionCheck = detectCompressedWorkflowChatHistory(processedResult.messages, rawResult.total_count);
      const contextMode = settings?.workflow_chat_context_mode ?? 'host_processed';
      const shouldPreferRaw = contextMode === 'raw_chat_preferred' && rawResult.total_count > 0;
      const shouldFallbackToRaw =
        contextMode === 'host_processed' &&
        rawResult.total_count > 0 &&
        (compressionCheck.detected || (processedResult.total_count === 0 && rawResult.total_count > 0));
      const selectedSourceMode = shouldPreferRaw
        ? 'raw_chat'
        : shouldFallbackToRaw
          ? 'raw_chat_fallback'
          : 'host_processed';
      const selectedMessages =
        selectedSourceMode === 'host_processed' || rawResult.total_count === 0
          ? processedResult.messages
          : rawResult.messages;

      chatHistoryAttempts.push({
        label: 'getChatMessages()',
        hasValue: processedResult.total_count > 0,
        length: processedResult.total_count,
        detail: `range=0-${lastId}; filtered_hidden=${processedResult.filtered_hidden_count}`,
      });
      chatHistoryAttempts.push({
        label: 'ctx.chat(raw)',
        hasValue: rawResult.total_count > 0,
        length: rawResult.total_count,
        detail: `range=0-${lastId}; filtered_hidden=${rawResult.filtered_hidden_count}`,
      });
      if (compressionCheck.detected) {
        chatHistoryAttempts.push({
          label: 'compression-wrapper-detected',
          hasValue: true,
          length: processedResult.total_count,
          detail: compressionCheck.reason ?? 'detected',
        });
      }

      components.chatMessages = selectedMessages
        .slice(-flow.context_turns)
        .map(msg => ({ role: msg.role, content: msg.content, name: msg.name }));

      components.diagnostics.chatHistory = {
        selectedSource:
          selectedSourceMode === 'host_processed'
            ? 'getChatMessages()'
            : selectedSourceMode === 'raw_chat_fallback'
              ? 'ctx.chat(raw) ← fallback'
              : 'ctx.chat(raw)',
        attempts: chatHistoryAttempts,
        note:
          selectedSourceMode === 'raw_chat_fallback'
            ? `context_turns=${flow.context_turns}; 实际纳入=${components.chatMessages.length}; 已因聊天压缩污染回退到原始聊天`
            : `context_turns=${flow.context_turns}; 实际纳入=${components.chatMessages.length}`,
        source_mode: selectedSourceMode,
        fallback_reason: selectedSourceMode === 'raw_chat_fallback' ? compressionCheck.reason ?? '宿主聊天结果不可用' : undefined,
        raw_count: rawResult.total_count,
        processed_count: processedResult.total_count,
        filtered_hidden_count:
          selectedSourceMode === 'host_processed'
            ? processedResult.filtered_hidden_count
            : rawResult.filtered_hidden_count,
        compression_wrapper_detected: compressionCheck.detected,
        regex_applied: false,
      };
    } else {
      components.diagnostics.chatHistory = {
        selectedSource: undefined,
        attempts: chatHistoryAttempts,
        note: `context_turns=${flow.context_turns}; 实际纳入=${components.chatMessages.length}`,
        source_mode: settings?.workflow_chat_context_mode === 'raw_chat_preferred' ? 'raw_chat' : 'host_processed',
        raw_count: 0,
        processed_count: 0,
        filtered_hidden_count: 0,
        compression_wrapper_detected: false,
        regex_applied: false,
      };
    }
  } catch (e) {
    console.debug('[Evolution World] getChatMessages failed:', e);
    components.diagnostics.chatHistory = appendDiagnosticNote(
      components.diagnostics.chatHistory,
      `聊天记录读取异常: ${String(e)}`,
    );
  }

  // ── 3. World Info (before/after) ───────────────────────────────────────
  await populateWorldInfoComponents(components, settings ?? ({} as EwSettings));

  // ── 4. Extension prompts (depth injections, before-prompt, etc.) ────────
  // SillyTavern stores computed extension prompts in `extension_prompts`.
  // Each entry: { value: string, position: number, depth: number, role: number }
  //   position: IN_PROMPT(0) = in prompt area, IN_CHAT(1) = depth injection,
  //             BEFORE_PROMPT(2) = before all prompts, NONE(-1) = skip
  //   role:     SYSTEM(0), USER(1), ASSISTANT(2)
  try {
    const ctx2 = getRuntimeContext();
    const extPrompts =
      ctx2?.extensionPrompts ?? getHostRuntime().extension_prompts ?? (globalThis as any).extension_prompts;
    if (extPrompts && typeof extPrompts === 'object') {
      const roleMap: Record<number, 'system' | 'user' | 'assistant'> = {
        0: 'system',
        1: 'user',
        2: 'assistant',
      };
      const promptAreaEntries: Array<{ content: string; label: string }> = [];

      for (const [, prompt] of Object.entries(extPrompts)) {
        const p = prompt as any;
        if (!p || typeof p.value !== 'string' || !p.value.trim()) continue;

        const sanitizedPromptValue = sanitizeWorkflowExtensionPrompt(p.value, components.blockedWorldInfoContents);
        if (!sanitizedPromptValue) continue;

        const role = roleMap[p.role] ?? 'system';

        switch (p.position) {
          case 0: // IN_PROMPT — in the prompt area (near character definitions)
            promptAreaEntries.push({ content: sanitizedPromptValue, label: 'ExtPrompt(IN_PROMPT)' });
            break;
          case 1: // IN_CHAT — depth-based injection into chat history
            components.depthInjections.push({
              content: sanitizedPromptValue,
              depth: typeof p.depth === 'number' ? p.depth : 0,
              role,
            });
            break;
          case 2: // BEFORE_PROMPT — before all other prompts
            components.beforePromptInjections.push(sanitizedPromptValue);
            break;
          // NONE (-1) is intentionally ignored
        }
      }

      // Host IN_PROMPT injections belong to the prompt area near character definitions,
      // so fold them into worldInfoBefore to respect the user's marker placement.
      if (promptAreaEntries.length) {
        for (const promptEntry of promptAreaEntries) {
          components.worldInfoBefore.push({
            name: promptEntry.label,
            content: promptEntry.content,
            role: 'system',
            position: 0,
            depth: 0,
            order: 999,
          });
        }
        components.diagnostics.worldInfoBefore = {
          ...(components.diagnostics.worldInfoBefore ?? { attempts: [] }),
          selectedSource: components.diagnostics.worldInfoBefore?.selectedSource ?? 'extensionPrompts(IN_PROMPT)',
          attempts: [
            ...(components.diagnostics.worldInfoBefore?.attempts ?? []),
            {
              label: 'extensionPrompts(prompt-area)',
              hasValue: true,
              length: promptAreaEntries.length,
              detail: `entries=${promptAreaEntries.length}`,
            },
          ],
          note: components.diagnostics.worldInfoBefore?.note
            ? `${components.diagnostics.worldInfoBefore.note}; 追加了 ${promptAreaEntries.length} 条 prompt-area 扩展提示词`
            : `追加了 ${promptAreaEntries.length} 条 prompt-area 扩展提示词`,
        };
      }

      if (components.beforePromptInjections.length) {
        components.diagnostics.worldInfoBefore = appendDiagnosticNote(
          components.diagnostics.worldInfoBefore,
          `检测到 ${components.beforePromptInjections.length} 条 BEFORE_PROMPT 扩展提示词，已放到请求最前面`,
        );
      }
    }
  } catch (e) {
    console.debug('[Evolution World] extension_prompts read failed:', e);
  }

  // ── 5. 正则处理 ─────────────────────────────────────────────────────
  // 当 flow 启用 use_tavern_regex 时，对聊天消息应用酒馆的正则脚本
  // （预设 + 全局 + 角色卡局部，跳过 markdownOnly）
  if (flow.use_tavern_regex && components.chatMessages.length > 0) {
    applyTavernRegex(components.chatMessages);
    if (components.diagnostics.chatHistory) {
      components.diagnostics.chatHistory.regex_applied = true;
      components.diagnostics.chatHistory.note = components.diagnostics.chatHistory.note
        ? `${components.diagnostics.chatHistory.note}; 已对工作流聊天副本应用酒馆正则`
        : '已对工作流聊天副本应用酒馆正则';
    }
  }

  return components;
}

export type AssembledMessage = { role: 'system' | 'user' | 'assistant'; content: string; name?: string };

function createMarkerPreviewMessage(title: string, content: string): PromptPreviewMessage {
  return {
    role: 'system',
    content,
    debugOnly: true,
    previewTitle: title,
  };
}

async function buildMarkerPreviewMessage(
  entry: EwPromptOrderEntry,
  components: PromptComponents,
  options: AssemblePreviewOptions = {},
): Promise<PromptPreviewMessage> {
  const markerTitle = entry.name?.trim() || entry.identifier;
  const diagnostic = components.diagnostics[entry.identifier as PromptDiagnosticKey];

  if (entry.identifier === 'chatHistory') {
    const count = components.chatMessages.length;
    const summary =
      count > 0
        ? `已读取 ${count} 条聊天消息。触发工作流时，这里会展开为多条 user/assistant 消息。`
        : '当前没有可用的聊天消息，因此这里不会发送任何历史消息。';
    return createMarkerPreviewMessage(
      `📌 ${markerTitle}`,
      [summary, formatDiagnosticBlock(diagnostic, count, count)].filter(Boolean).join('\n\n'),
    );
  }

  const rawContent = resolveMarkerContent(entry.identifier, components);
  const renderedContent = rawContent.trim() ? await renderEjsContent(rawContent, options.templateContext) : '';
  const rawLength = rawContent.trim().length;
  const renderedLength = renderedContent.trim().length;
  const summary =
    renderedLength > 0
      ? `已读取该段内容（渲染后 ${renderedLength} chars）。触发工作流时会发送。`
      : rawLength > 0
        ? '已读取原始内容，但 EJS 渲染后为空。触发工作流时这里不会发送正文。'
        : '当前为空，因此这里不会发送任何内容。';

  return createMarkerPreviewMessage(
    `📌 ${markerTitle}`,
    [summary, formatDiagnosticBlock(diagnostic, rawLength, renderedLength)].filter(Boolean).join('\n\n'),
  );
}

/**
 * Assemble an ordered array of prompt messages according to a flow's prompt_order.
 *
 * This mirrors SillyTavern's `populateChatCompletion()` logic: it walks
 * through the user-configured prompt order and fills each slot with the
 * appropriate content — either from automatically-collected PromptComponents
 * (for markers) or from user-written content (for prompt entries).
 *
 * Supports injection_position='in_chat' + injection_depth for prompts
 * that should be inserted at a specific depth inside the chat history.
 */
export async function assembleOrderedPrompts(
  promptOrder: EwPromptOrderEntry[],
  components: PromptComponents,
  options: AssemblePreviewOptions = {},
): Promise<PromptPreviewMessage[]> {
  const result: PromptPreviewMessage[] = [];
  const previewMarkerOnly = Boolean(options.includeMarkerPlaceholders);
  // Deferred injections: prompts with in_chat position that go inside chat history
  const deferredInjections: Array<{ content: string; role: 'system' | 'user' | 'assistant'; depth: number }> = [];
  let chatHistoryStartIdx = -1;

  for (const content of components.beforePromptInjections) {
    if (content.trim()) {
      result.push({ role: 'system', content });
    }
  }

  for (const entry of promptOrder) {
    if (!entry.enabled) continue;

    if (options.includeMarkerPlaceholders && entry.type === 'marker') {
      result.push(await buildMarkerPreviewMessage(entry, components, options));
    }

    if (previewMarkerOnly && entry.type === 'marker') {
      continue;
    }

    // Defer in_chat injections — they'll be inserted after chat history is placed
    if (entry.injection_position === 'in_chat' && entry.identifier !== 'chatHistory') {
      if (entry.type === 'prompt' && entry.content.trim()) {
        const rendered = await renderEjsContent(entry.content, options.templateContext);
        deferredInjections.push({ content: rendered, role: entry.role, depth: entry.injection_depth });
      } else if (entry.type === 'marker') {
        const content = await renderEjsContent(
          resolveMarkerContent(entry.identifier, components),
          options.templateContext,
        );
        if (content.trim()) {
          deferredInjections.push({ content, role: entry.role, depth: entry.injection_depth });
        }
      }
      continue;
    }

    if (entry.type === 'marker') {
      if (entry.identifier === 'chatHistory') {
        // Mark where chat history starts in result
        chatHistoryStartIdx = result.length;
        // Chat history expands into multiple user/assistant messages
        for (const msg of components.chatMessages) {
          if (msg.content.trim()) {
            result.push({ role: msg.role, content: msg.content, name: msg.name });
          }
        }
        continue;
      }

      // World Info markers expand into individual per-entry messages
      if (entry.identifier === 'worldInfoBefore' || entry.identifier === 'worldInfoAfter') {
        const wiEntries =
          entry.identifier === 'worldInfoBefore' ? components.worldInfoBefore : components.worldInfoAfter;
        for (const wi of wiEntries) {
          if (wi.content.trim()) {
            result.push({ role: wi.role, content: `【${wi.name}】\n${wi.content}` });
          }
        }
        continue;
      }

      const content = await renderEjsContent(
        resolveMarkerContent(entry.identifier, components),
        options.templateContext,
      );
      if (content.trim()) {
        result.push({ role: entry.role, content });
      }
    } else {
      // User-editable prompt — use entry.content, fallback to marker for 'main'
      const raw = entry.content.trim() || (entry.identifier === 'main' ? components.main : '');
      if (raw.trim()) {
        const content = await renderEjsContent(raw, options.templateContext);
        result.push({ role: entry.role, content });
      }
    }
  }

  // ── Merge extension depth injections (WI depth, Author's Note, etc.) ──
  for (const inj of components.depthInjections) {
    deferredInjections.push({ content: inj.content, role: inj.role, depth: inj.depth });
  }

  // ── Insert deferred in_chat injections at the correct depth ──
  // depth=0 means at the end of chat history, depth=1 means before the last
  // chat message, depth=N means before the Nth-from-last message, etc.
  if (deferredInjections.length > 0 && chatHistoryStartIdx >= 0) {
    const chatHistoryEndIdx = result.length;
    const chatLen = chatHistoryEndIdx - chatHistoryStartIdx;

    // Sort by depth descending so deeper injections are inserted first
    // (this preserves correct positions when inserting multiple items)
    // 按 depth 升序排列，从最浅到最深
    deferredInjections.sort((a, b) => a.depth - b.depth);
    // 从后往前插入：每次插入不影响之前已计算的位置
    for (let i = deferredInjections.length - 1; i >= 0; i--) {
      const { role, content, depth } = deferredInjections[i];
      const insertIdx = Math.max(chatHistoryStartIdx, chatHistoryEndIdx - Math.min(depth, chatLen));
      result.splice(insertIdx, 0, { role, content });
    }
  } else if (deferredInjections.length > 0) {
    // No chat history marker — append deferred items at the end
    for (const { role, content } of deferredInjections) {
      result.push({ role, content });
    }
  }

  return result;
}

/**
 * Resolve the content for a marker-type prompt order entry.
 */
function resolveMarkerContent(identifier: string, components: PromptComponents): string {
  switch (identifier) {
    case 'main':
      return components.main;
    case 'enhanceDefinitions':
      return components.main; // CR-1: ST treats this as an extension of main
    case 'charDescription':
      return components.charDescription;
    case 'charPersonality':
      return components.charPersonality;
    case 'scenario':
      return components.scenario;
    case 'personaDescription':
      return components.personaDescription;
    case 'worldInfoBefore':
    case 'worldInfoAfter':
      return ''; // Handled inline by assembleOrderedPrompts as individual entries
    case 'dialogueExamples':
      return components.dialogueExamples;
    case 'postHistoryInstructions':
      return components.jailbreak;
    default:
      return '';
  }
}

// ── Prompt Preview (Debug) ───────────────────────────────────

/**
 * Build and return the full prompt messages array for debug preview.
 *
 * Runs the same pipeline as the real dispatch (collect components →
 * assemble ordered prompts → inject entry names) but does NOT send
 * anything to the AI. Returns the messages array for UI display.
 */
export async function previewPrompt(flow: EwFlowConfig, settings?: EwSettings): Promise<PromptPreviewMessage[]> {
  const components = await collectPromptComponents(flow, settings);
  const messages = await assembleOrderedPrompts(flow.prompt_order, components, { includeMarkerPlaceholders: true });
  return messages;
}
