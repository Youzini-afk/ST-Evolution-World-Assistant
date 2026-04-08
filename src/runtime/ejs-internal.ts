/**
 * EJS Internal Engine – self-contained EJS rendering for Evolution World.
 *
 * Bundles the EJS engine directly, providing full control over when and how
 * EJS templates are rendered. Used for workflow prompt assembly where we need
 * to execute worldbook EJS (e.g., Controller getwi calls) independently from ST's pipeline.
 *
 * Also provides `checkEjsSyntax` for syntax validation and `renderEjsContent`
 * as a simple render-without-worldbook-context helper.
 */

// The EJS library is a UMD bundle that self-registers on globalThis.
// We side-import it so webpack bundles it, then access the global it creates.
import '../libs/ejs';
import { getRuntimeState } from './state';

const ejs = (globalThis as any).ejs as {
  compile(template: string, opts?: Record<string, any>): (...args: any[]) => any;
  render(template: string, data?: Record<string, any>, opts?: Record<string, any>): string;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EjsRenderContext {
  /** Flat entry list used for exact worldbook-aware lookup. */
  entries: Array<{ name: string; comment?: string; content: string; worldbook: string }>;
  /** First-match lookup across all entries, keyed by name/comment alias. */
  allEntries: Map<string, { name: string; comment?: string; content: string; worldbook: string }>;
  /** Exact lookup inside a specific worldbook, keyed by name/comment alias. */
  entriesByWorldbook: Map<string, Map<string, { name: string; comment?: string; content: string; worldbook: string }>>;
  /** Already-rendered entries to prevent infinite recursion */
  renderStack: Set<string>;
  /** Maximum recursion depth for getwi calls */
  maxRecursion: number;
  /** In-memory variable state for a single render pass. */
  variableState: {
    globalVars: Record<string, any>;
    localVars: Record<string, any>;
    messageVars: Record<string, any>;
    cacheVars: Record<string, any>;
  };
  /** Entries activated during the current render pass. */
  activatedEntries: Map<string, { name: string; comment?: string; content: string; worldbook: string }>;
  /** Entries pulled via getwi during the current render pass, in first-seen order. */
  pulledEntries: Map<string, { name: string; comment?: string; content: string; worldbook: string }>;
}

// ---------------------------------------------------------------------------
// ST Runtime Accessors
// ---------------------------------------------------------------------------

declare const SillyTavern: { getContext(): Record<string, any> } | undefined;

function getStContext(): Record<string, any> {
  try {
    return SillyTavern?.getContext?.() ?? {};
  } catch {
    return {};
  }
}

function getChatMetadataVariables(): Record<string, any> {
  try {
    const ctx = getStContext();
    return ctx.chatMetadata?.variables ?? {};
  } catch {
    return {};
  }
}

function getGlobalVariables(): Record<string, any> {
  try {
    const ctx = getStContext();
    return ctx.extensionSettings?.variables?.global ?? {};
  } catch {
    return {};
  }
}

function getCurrentMessageVariables(): Record<string, any> {
  try {
    const chat = getStChat();
    const message = chat[chat.length - 1];
    const swipeId = Number(message?.swipe_id ?? 0);
    const vars = message?.variables?.[swipeId];
    return _.isPlainObject(vars) ? _.cloneDeep(vars) : {};
  } catch {
    return {};
  }
}

function getCurrentWorkflowUserInput(): string {
  try {
    const runtimeState = getRuntimeState();
    const candidates = [
      runtimeState.last_send_intent?.user_input,
      runtimeState.last_send?.user_input,
      runtimeState.after_reply.pending_user_input,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
  } catch {
    // ignore runtime-state lookup failures and fall back below
  }

  try {
    const chat = getStChat();
    const lastUserMessage = chat.findLast((msg: any) => msg.is_user)?.mes;
    return typeof lastUserMessage === 'string' ? lastUserMessage : '';
  } catch {
    return '';
  }
}

function createVariableState(): EjsRenderContext['variableState'] {
  const globalVars = _.cloneDeep(getGlobalVariables());
  const localVars = _.cloneDeep(getChatMetadataVariables());
  const messageVars = _.cloneDeep(getCurrentMessageVariables());
  return {
    globalVars,
    localVars,
    messageVars,
    cacheVars: {
      ...globalVars,
      ...localVars,
      ...messageVars,
    },
  };
}

function rebuildVariableCache(state: EjsRenderContext['variableState']): void {
  state.cacheVars = {
    ...state.globalVars,
    ...state.localVars,
    ...state.messageVars,
  };
}

// ---------------------------------------------------------------------------
// substituteParams – macro replacement (Fix #1)
// ---------------------------------------------------------------------------

/**
 * Replace common ST macros in text before rendering.
 * Mirrors SillyTavern's `substituteParams()` for the most common macros.
 */
function buildPromptTemplateContext(templateContext: Record<string, any> = {}): Record<string, any> {
  const ctx = getStContext();
  const userName = ctx.name1 ?? '';
  const charName = ctx.name2 ?? '';
  const personaDescription = ctx.persona ?? '';
  const providedUserInput = typeof templateContext.user_input === 'string' ? templateContext.user_input : undefined;
  const workflowUserInput = providedUserInput ?? getCurrentWorkflowUserInput();

  return _.merge(
    {
      user: userName,
      char: charName,
      persona: personaDescription,
      lastUserMessage: workflowUserInput,
      last_user_message: workflowUserInput,
      userInput: workflowUserInput,
      user_input: workflowUserInput,
      original: '',
      input: '',
      lastMessage: '',
      lastMessageId: '',
      newline: '\n',
      trim: '',
    },
    templateContext,
  );
}

function substituteParams(text: string, templateContext: Record<string, any> = {}): string {
  if (!text || !text.includes('{{')) return text;

  const context = buildPromptTemplateContext(templateContext);

  return text.replace(/\{\{\s*([a-zA-Z0-9_.$]+)\s*\}\}/g, (_match, path) => {
    const value = _.get(context, path);
    if (_.isPlainObject(value) || Array.isArray(value)) {
      return JSON.stringify(value);
    }
    return value === undefined ? '' : String(value);
  });
}

// ---------------------------------------------------------------------------
// Variable Access (simplified ST-compatible implementation)
// ---------------------------------------------------------------------------

function getVariable(state: EjsRenderContext['variableState'], path: string, opts: Record<string, any> = {}): any {
  const scope = opts.scope;

  if (scope === 'global') {
    return _.get(state.globalVars, path, opts.defaults);
  }

  if (scope === 'message') {
    return _.get(state.messageVars, path, opts.defaults);
  }

  if (scope === 'local') {
    return _.get(state.localVars, path, opts.defaults);
  }

  // Default: cache scope, matching Prompt Template's getvar fallback.
  return _.get(state.cacheVars, path, opts.defaults);
}

function setVariable(
  state: EjsRenderContext['variableState'],
  path: string,
  value: unknown,
  opts: Record<string, any> = {},
): void {
  const scope = opts.scope ?? 'message';
  const target = scope === 'global' ? state.globalVars : scope === 'local' ? state.localVars : state.messageVars;

  if (value === undefined) {
    _.unset(target, path);
  } else {
    _.set(target, path, _.cloneDeep(value));
  }

  rebuildVariableCache(state);
}

// ---------------------------------------------------------------------------
// Chat Message Access (Fix #4)
// ---------------------------------------------------------------------------

declare function getChatMessages(range: string, opts?: Record<string, any>): any[];
declare function getLastMessageId(): number;

function getStChat(): any[] {
  try {
    const ctx = getStContext();
    return ctx.chat ?? [];
  } catch {
    return [];
  }
}

function stGetChatMessage(id: number): any {
  const chat = getStChat();
  if (id >= 0 && id < chat.length) return chat[id];
  return null;
}

void stGetChatMessage;

function processChatMessage(msg: any): string {
  return String(msg?.mes ?? msg?.message ?? '');
}

function stGetChatMessages(range: string, _opts?: Record<string, any>): any[] {
  try {
    if (typeof getChatMessages === 'function') {
      return getChatMessages(range, _opts);
    }
  } catch {
    /* fallback below */
  }

  // Simple fallback: parse range "start-end" and slice chat
  const chat = getStChat();
  const [startStr, endStr] = range.split('-');
  const start = parseInt(startStr, 10) || 0;
  const end = endStr !== undefined ? parseInt(endStr, 10) : chat.length - 1;
  return chat.slice(start, end + 1);
}

void stGetChatMessages;

function stMatchChatMessages(pattern: string | RegExp): any[] {
  const chat = getStChat();
  const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
  return chat.filter((msg: any) => regex.test(msg.mes ?? ''));
}

void stMatchChatMessages;

function getChatMessageCompat(index: number, role?: 'user' | 'assistant' | 'system'): string {
  const chat = getStChat()
    .filter(
      (msg: any) =>
        !role ||
        (role === 'user' && msg.is_user) ||
        (role === 'system' && msg.is_system) ||
        (role === 'assistant' && !msg.is_user && !msg.is_system),
    )
    .map(processChatMessage);
  const resolvedIndex = index >= 0 ? index : chat.length + index;
  return chat[resolvedIndex] ?? '';
}

function getChatMessagesCompat(
  startOrCount: number = getStChat().length,
  endOrRole?: number | 'user' | 'assistant' | 'system',
  role?: 'user' | 'assistant' | 'system',
): string[] {
  const all = getStChat().map((msg: any, index: number) => ({
    raw: msg,
    id: index,
    text: processChatMessage(msg),
  }));

  const filterRole = (items: typeof all, currentRole?: 'user' | 'assistant' | 'system') =>
    !currentRole
      ? items
      : items.filter(
          item =>
            (currentRole === 'user' && item.raw.is_user) ||
            (currentRole === 'system' && item.raw.is_system) ||
            (currentRole === 'assistant' && !item.raw.is_user && !item.raw.is_system),
        );

  if (endOrRole == null) {
    return (startOrCount > 0 ? all.slice(0, startOrCount) : all.slice(startOrCount)).map(item => item.text);
  }

  if (typeof endOrRole === 'string') {
    const filtered = filterRole(all, endOrRole);
    return (startOrCount > 0 ? filtered.slice(0, startOrCount) : filtered.slice(startOrCount)).map(item => item.text);
  }

  const filtered = filterRole(all, role);
  return filtered.slice(startOrCount, endOrRole).map(item => item.text);
}

function matchChatMessagesCompat(pattern: string | RegExp): boolean {
  const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
  return getStChat().some((msg: any) => regex.test(processChatMessage(msg)));
}

function normalizeEntryKey(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function findEntry(
  ctx: EjsRenderContext,
  currentWorldbook: string,
  worldbookOrEntry: string | null,
  entryNameOrData?: string | Record<string, unknown>,
): { name: string; comment?: string; content: string; worldbook: string } | undefined {
  const explicitWorldbook = typeof entryNameOrData === 'string' ? normalizeEntryKey(worldbookOrEntry) : '';
  const fallbackWorldbook = normalizeEntryKey(currentWorldbook);
  const identifier = normalizeEntryKey(typeof entryNameOrData === 'string' ? entryNameOrData : worldbookOrEntry);

  if (!identifier) {
    return undefined;
  }

  const lookupInWorldbook = (worldbook: string) => {
    if (!worldbook) return undefined;
    return ctx.entriesByWorldbook.get(worldbook)?.get(identifier);
  };

  return lookupInWorldbook(explicitWorldbook) ?? lookupInWorldbook(fallbackWorldbook) ?? ctx.allEntries.get(identifier);
}

function activationKey(entry: { worldbook: string; name: string; comment?: string }): string {
  return `${entry.worldbook}::${entry.comment || entry.name}`;
}

async function activateWorldInfoInContext(
  ctx: EjsRenderContext,
  currentWorldbook: string,
  world: string | null,
  entryOrForce?: string | boolean,
  maybeForce?: boolean,
): Promise<{ world: string; comment: string; content: string } | null> {
  const force = typeof entryOrForce === 'boolean' ? entryOrForce : maybeForce;
  const explicitWorldbook = typeof entryOrForce === 'string' ? world : null;
  const identifier = typeof entryOrForce === 'string' ? entryOrForce : world;
  const entry = identifier
    ? findEntry(ctx, currentWorldbook, explicitWorldbook, normalizeEntryKey(identifier))
    : undefined;
  if (!entry) {
    return null;
  }

  const normalizedEntry = force ? { ...entry, content: entry.content.replaceAll('@@dont_activate', '') } : entry;
  ctx.activatedEntries.set(activationKey(normalizedEntry), normalizedEntry);
  return {
    world: normalizedEntry.worldbook,
    comment: normalizedEntry.comment || normalizedEntry.name,
    content: normalizedEntry.content,
  };
}

// ---------------------------------------------------------------------------
// getwi implementation (Fix #1: substituteParams on entry content)
// ---------------------------------------------------------------------------

async function getwi(
  ctx: EjsRenderContext,
  currentWorldbook: string,
  worldbookOrEntry: string | null,
  entryNameOrData?: string | Record<string, unknown>,
): Promise<string> {
  const entry = findEntry(ctx, currentWorldbook, worldbookOrEntry, entryNameOrData);
  if (!entry) {
    const missing = typeof entryNameOrData === 'string' ? entryNameOrData : worldbookOrEntry;
    console.debug(`[EW EJS Internal] getwi: entry '${String(missing ?? '')}' not found`);
    return '';
  }

  const entryKey = activationKey(entry);

  // Recursion guard
  if (ctx.renderStack.has(entryKey)) {
    console.warn(`[EW EJS Internal] getwi: circular reference detected for '${entry.comment || entry.name}'`);
    return substituteParams(entry.content);
  }

  if (ctx.renderStack.size >= ctx.maxRecursion) {
    console.warn(`[EW EJS Internal] getwi: max recursion depth (${ctx.maxRecursion}) reached`);
    return substituteParams(entry.content);
  }

  // Fix #1: Apply substituteParams before rendering
  const processed = substituteParams(entry.content);
  let finalContent = processed;

  // If content contains EJS, render it recursively
  if (processed.includes('<%')) {
    ctx.renderStack.add(entryKey);
    try {
      finalContent = await evalEjsTemplate(processed, ctx, {
        world_info: { comment: entry.comment || entry.name, name: entry.name, world: entry.worldbook },
      });
    } finally {
      ctx.renderStack.delete(entryKey);
    }
  }

  if (!ctx.pulledEntries.has(entryKey)) {
    ctx.pulledEntries.set(entryKey, {
      name: entry.name,
      comment: entry.comment,
      content: finalContent,
      worldbook: entry.worldbook,
    });
  }

  return finalContent;
}

// ---------------------------------------------------------------------------
// EJS Template Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an EJS template with the workflow-specific context.
 *
 * Provides a comprehensive subset of ST-Prompt-Template's context functions
 * sufficient for rendering worldbook entries including Controller EJS.
 */
export async function evalEjsTemplate(
  content: string,
  renderCtx: EjsRenderContext,
  extraEnv: Record<string, any> = {},
): Promise<string> {
  if (!content.includes('<%')) return content;

  const stCtx = getStContext();
  const chat = getStChat();
  const workflowUserInput = getCurrentWorkflowUserInput();

  // Build the evaluation context
  const context: Record<string, any> = {
    // Lodash
    _,

    // Console
    console,

    // ── Character info ──
    userName: stCtx.name1 ?? '',
    charName: stCtx.name2 ?? '',
    assistantName: stCtx.name2 ?? '',
    characterId: stCtx.characterId,

    get chatId() {
      return stCtx.chatId ?? (typeof getCurrentChatId === 'function' ? getCurrentChatId() : '');
    },

    get variables() {
      return renderCtx.variableState.cacheVars;
    },

    // ── Fix #2: Message variables ──
    get lastUserMessageId() {
      return chat.findLastIndex((msg: any) => msg.is_user);
    },

    get lastUserMessage() {
      return workflowUserInput || (chat.findLast((msg: any) => msg.is_user)?.mes ?? '');
    },

    get last_user_message() {
      return workflowUserInput || (chat.findLast((msg: any) => msg.is_user)?.mes ?? '');
    },

    get userInput() {
      return workflowUserInput;
    },

    get user_input() {
      return workflowUserInput;
    },

    get lastCharMessageId() {
      return chat.findLastIndex((msg: any) => !msg.is_user && !msg.is_system);
    },

    get lastCharMessage() {
      return chat.findLast((msg: any) => !msg.is_user && !msg.is_system)?.mes ?? '';
    },

    get lastMessageId() {
      return chat.length - 1;
    },

    // ── Fix #3: Lorebook variables ──
    get charLoreBook() {
      try {
        const chars = stCtx.characters;
        const chid = stCtx.characterId;
        return chars?.[chid]?.data?.extensions?.world ?? '';
      } catch {
        return '';
      }
    },

    get userLoreBook() {
      try {
        return stCtx.extensionSettings?.persona_description_lorebook ?? '';
      } catch {
        return '';
      }
    },

    get chatLoreBook() {
      try {
        return stCtx.chatMetadata?.world ?? '';
      } catch {
        return '';
      }
    },

    // Avatar URLs
    get charAvatar() {
      try {
        const chars = stCtx.characters;
        const chid = stCtx.characterId;
        return chars?.[chid]?.avatar ? `/characters/${chars[chid].avatar}` : '';
      } catch {
        return '';
      }
    },

    userAvatar: '',

    // Groups
    groups: stCtx.groups ?? [],
    groupId: stCtx.selectedGroupId ?? null,

    // Model
    get model() {
      try {
        return stCtx.onlineStatus ?? '';
      } catch {
        return '';
      }
    },

    // SillyTavern context proxy
    get SillyTavern() {
      return getStContext();
    },

    // ── World info functions ──
    getwi: (worldbookOrEntry: string | null, entryNameOrData?: string | Record<string, unknown>) =>
      getwi(renderCtx, String(context.world_info?.world ?? ''), worldbookOrEntry, entryNameOrData),
    getWorldInfo: (worldbookOrEntry: string | null, entryNameOrData?: string | Record<string, unknown>) =>
      getwi(renderCtx, String(context.world_info?.world ?? ''), worldbookOrEntry, entryNameOrData),

    // ── Variable functions (read-only for workflow assembly) ──
    getvar: (path: string, opts?: Record<string, any>) => getVariable(renderCtx.variableState, path, opts),
    getLocalVar: (path: string, opts: Record<string, any> = {}) =>
      getVariable(renderCtx.variableState, path, { ...opts, scope: 'local' }),
    getGlobalVar: (path: string, opts: Record<string, any> = {}) =>
      getVariable(renderCtx.variableState, path, { ...opts, scope: 'global' }),
    getMessageVar: (path: string, opts: Record<string, any> = {}) =>
      getVariable(renderCtx.variableState, path, { ...opts, scope: 'message' }),

    // Write functions keep in-memory state for the current render pass.
    setvar: (path: string, value: unknown, opts?: Record<string, any>) =>
      setVariable(renderCtx.variableState, path, value, opts),
    setLocalVar: (path: string, value: unknown, opts: Record<string, any> = {}) =>
      setVariable(renderCtx.variableState, path, value, { ...opts, scope: 'local' }),
    setGlobalVar: (path: string, value: unknown, opts: Record<string, any> = {}) =>
      setVariable(renderCtx.variableState, path, value, { ...opts, scope: 'global' }),
    setMessageVar: (path: string, value: unknown, opts: Record<string, any> = {}) =>
      setVariable(renderCtx.variableState, path, value, { ...opts, scope: 'message' }),
    incvar: () => undefined,
    decvar: () => undefined,
    delvar: () => undefined,
    insvar: () => undefined,
    incLocalVar: () => undefined,
    incGlobalVar: () => undefined,
    incMessageVar: () => undefined,
    decLocalVar: () => undefined,
    decGlobalVar: () => undefined,
    decMessageVar: () => undefined,
    patchVariables: () => undefined,

    // ── Fix #4: Chat message functions ──
    getChatMessage: (id: number, role?: 'user' | 'assistant' | 'system') => getChatMessageCompat(id, role),
    getChatMessages: (
      startOrCount: number,
      endOrRole?: number | 'user' | 'assistant' | 'system',
      role?: 'user' | 'assistant' | 'system',
    ) => getChatMessagesCompat(startOrCount, endOrRole, role),
    matchChatMessages: (pattern: string | RegExp) => matchChatMessagesCompat(pattern),

    // ── Fix #5: High-level functions (safe stubs for workflow context) ──

    // getchr / getchar / getChara — return character data
    getchr: (_name?: string | RegExp) => {
      try {
        const chars = stCtx.characters;
        const chid = stCtx.characterId;
        const char = chars?.[chid];
        if (!char) return '';
        return char.data?.description ?? '';
      } catch {
        return '';
      }
    },
    getchar: undefined as any, // aliased below
    getChara: undefined as any,

    // getprp / getpreset / getPresetPrompt — stub (workflow doesn't use preset prompts)
    getprp: async () => '',
    getpreset: async () => '',
    getPresetPrompt: async () => '',

    // execute (slash command) — no-op in workflow context
    execute: async (_cmd: string) => '',

    // define — no-op (SharedDefines not needed in workflow)
    define: (_name: string, _value: unknown) => undefined,

    // evalTemplate — recursive EJS within workflow context
    evalTemplate: async (content: string, data: Record<string, any> = {}) => {
      return await evalEjsTemplate(content, renderCtx, data);
    },

    // getqr / getQuickReply — stub
    getqr: async () => '',
    getQuickReply: async () => '',

    // findVariables — stub
    findVariables: () => ({}),

    // World info data access
    getWorldInfoData: async () => {
      const entries: any[] = [];
      for (const entry of renderCtx.entries) {
        entries.push({ comment: entry.comment || entry.name, content: entry.content, world: entry.worldbook });
      }
      return entries;
    },
    getWorldInfoActivatedData: async () =>
      Array.from(renderCtx.activatedEntries.values()).map(entry => ({
        comment: entry.comment || entry.name,
        content: entry.content,
        world: entry.worldbook,
      })),
    getEnabledWorldInfoEntries: async () =>
      renderCtx.entries.map(entry => ({
        comment: entry.comment || entry.name,
        content: entry.content,
        world: entry.worldbook,
      })),
    selectActivatedEntries: () => [],
    activateWorldInfoByKeywords: async () => [],
    getEnabledLoreBooks: () => Array.from(new Set(renderCtx.entries.map(entry => entry.worldbook))),

    // World info activation for controller compatibility.
    activewi: async (world: string | null, entryOrForce?: string | boolean, maybeForce?: boolean) =>
      activateWorldInfoInContext(renderCtx, String(context.world_info?.world ?? ''), world, entryOrForce, maybeForce),
    activateWorldInfo: async (world: string | null, entryOrForce?: string | boolean, maybeForce?: boolean) =>
      activateWorldInfoInContext(renderCtx, String(context.world_info?.world ?? ''), world, entryOrForce, maybeForce),

    // Regex
    activateRegex: () => undefined,

    // Prompt injection
    injectPrompt: () => undefined,
    getPromptsInjected: () => [],
    hasPromptsInjected: () => false,

    // JSON utils
    jsonPatch: () => undefined,
    parseJSON: (str: string) => {
      try {
        return JSON.parse(str);
      } catch {
        return null;
      }
    },

    // Print function for EJS
    print: (...args: any[]) => args.filter(x => x !== undefined && x !== null).join(''),

    // Merge any extra environment (e.g., world_info metadata from getwi)
    ...extraEnv,
  };

  // Alias getchr variants
  context.getchar = context.getchr;
  context.getChara = context.getchr;

  try {
    const compiled = ejs.compile(content, {
      async: true,
      outputFunctionName: 'print',
      _with: true,
      localsName: 'locals',
      client: true,
    });
    // Fix #6: rethrow signature matches EJS lib (5 params: err, str, flnm, lineno, esc)
    const result = await compiled.call(
      context,
      context,
      (s: string) => s, // escapeFn (identity, no HTML escaping)
      () => ({ filename: '', template: '' }), // includer (stub)
      rethrow,
    );
    return result ?? '';
  } catch (e) {
    console.warn('[EW EJS Internal] Template render failed:', e);
    // Return raw content on failure rather than breaking the pipeline
    return content;
  }
}

// Fix #6: rethrow signature matches EJS internal (5 params)
function rethrow(err: Error, str: string, flnm: string, lineno: number, _esc?: (s: string) => string) {
  const lines = str.split('\n');
  const start = Math.max(lineno - 3, 0);
  const end = Math.min(lines.length, lineno + 3);
  const filename = typeof _esc === 'function' ? _esc(flnm) : flnm || 'ejs';
  const context = lines
    .slice(start, end)
    .map((line, i) => {
      const curr = i + start + 1;
      return (curr === lineno ? ' >> ' : '    ') + curr + '| ' + line;
    })
    .join('\n');
  err.message = filename + ':' + lineno + '\n' + context + '\n\n' + err.message;
  throw err;
}

// Declare getCurrentChatId for optional use
declare function getCurrentChatId(): string;

/**
 * Create a render context from a flat list of worldbook entries.
 */
export function createRenderContext(
  entries: Array<{ name: string; comment?: string; content: string; worldbook: string }>,
  maxRecursion = 10,
): EjsRenderContext {
  const allEntries = new Map<string, { name: string; comment?: string; content: string; worldbook: string }>();
  const entriesByWorldbook = new Map<
    string,
    Map<string, { name: string; comment?: string; content: string; worldbook: string }>
  >();
  const normalizedEntries = entries.map(entry => ({
    ...entry,
    name: normalizeEntryKey(entry.name),
    comment: normalizeEntryKey(entry.comment),
  }));

  const registerLookup = (
    lookup: Map<string, { name: string; comment?: string; content: string; worldbook: string }>,
    key: string,
    entry: { name: string; comment?: string; content: string; worldbook: string },
  ) => {
    if (!key || lookup.has(key)) return;
    lookup.set(key, entry);
  };

  for (const normalized of normalizedEntries) {
    registerLookup(allEntries, normalized.name, normalized);
    registerLookup(allEntries, normalized.comment || '', normalized);

    let worldbookLookup = entriesByWorldbook.get(normalized.worldbook);
    if (!worldbookLookup) {
      worldbookLookup = new Map();
      entriesByWorldbook.set(normalized.worldbook, worldbookLookup);
    }
    registerLookup(worldbookLookup, normalized.name, normalized);
    registerLookup(worldbookLookup, normalized.comment || '', normalized);
  }
  return {
    entries: normalizedEntries,
    allEntries,
    entriesByWorldbook,
    renderStack: new Set(),
    maxRecursion,
    variableState: createVariableState(),
    activatedEntries: new Map(),
    pulledEntries: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Simple EJS render (no worldbook context, for user-defined prompts)
// ---------------------------------------------------------------------------

/**
 * Render EJS content without worldbook context.
 *
 * Used for user-defined prompt entries that may contain EJS tags
 * but don't need worldbook getwi access.
 */
export async function renderEjsContent(content: string, templateContext: Record<string, any> = {}): Promise<string> {
  const processed = substituteParams(content, templateContext);
  if (!processed.includes('<%')) return processed;
  const ctx = createRenderContext([]);
  try {
    return await evalEjsTemplate(processed, ctx);
  } catch (e) {
    console.warn('[EW EJS Internal] renderEjsContent failed:', e);
    return processed;
  }
}

// ---------------------------------------------------------------------------
// EJS Syntax Check
// ---------------------------------------------------------------------------

/**
 * Check EJS syntax without executing.
 *
 * @returns A human-readable error string if syntax is invalid, or `null` if valid.
 */
export function checkEjsSyntax(content: string): string | null {
  if (!content.includes('<%')) return null;
  try {
    ejs.compile(content, {
      async: true,
      client: true,
      _with: true,
      localsName: 'locals',
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
