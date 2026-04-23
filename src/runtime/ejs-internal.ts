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
import { getHostRuntime, tryGetSTContext } from '../st-adapter';

function getEjsRuntime(): {
  compile(template: string, opts?: Record<string, any>): (...args: any[]) => any;
  render(template: string, data?: Record<string, any>, opts?: Record<string, any>): string;
} {
  return (globalThis as any).ejs as {
    compile(template: string, opts?: Record<string, any>): (...args: any[]) => any;
    render(template: string, data?: Record<string, any>, opts?: Record<string, any>): string;
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RenderWorldInfoEntry = {
  uid?: number;
  name: string;
  comment?: string;
  content: string;
  worldbook: string;
};

const DEFAULT_CHAR_DEFINE = `<% if (name) { %><<%- name %>><% if (system_prompt) { %>System: <%- system_prompt %><% } %>name: <%- name %><% if (personality) { %>personality: <%- personality %><% } %><% if (description) { %>description: <%- description %><% } %><% if (message_example) { %>example:\n<%- message_example %><% } %><% if (depth_prompt) { %>System: <%- depth_prompt %><% } %></<%- name %>><% } %>`;

export interface EjsRenderContext {
  /** Flat entry list used for exact worldbook-aware lookup. */
  entries: RenderWorldInfoEntry[];
  /** First-match lookup across all entries, keyed by name/comment alias. */
  allEntries: Map<string, RenderWorldInfoEntry>;
  /** Exact lookup inside a specific worldbook, keyed by name/comment alias. */
  entriesByWorldbook: Map<string, Map<string, RenderWorldInfoEntry>>;
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
  /** Shared define() values for nested renders. */
  sharedDefines: Record<string, unknown>;
  /** Entries activated during the current render pass. */
  activatedEntries: Map<string, RenderWorldInfoEntry>;
  /** Entries pulled via getwi during the current render pass, in first-seen order. */
  pulledEntries: Map<string, RenderWorldInfoEntry>;
}

// ---------------------------------------------------------------------------
// ST Runtime Accessors
// ---------------------------------------------------------------------------

function getStContext(): Record<string, any> {
  try {
    return (tryGetSTContext() as Record<string, any> | undefined) ?? {};
  } catch {
    return {};
  }
}

function getHost(): Record<string, any> {
  return getHostRuntime() as Record<string, any>;
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

function readMessageVariables(message: any): Record<string, any> {
  const swipeId = Number(message?.swipe_id ?? 0);
  const vars = message?.variables?.[swipeId];
  return _.isPlainObject(vars) ? _.cloneDeep(vars) : {};
}

function findPreviousMessageVariables(messageId: number = getStChat().length, key?: string): Record<string, any> {
  const chat = getStChat();
  const end = Math.min(Math.max(messageId, 0), chat.length);
  for (let index = end - 1; index >= 0; index -= 1) {
    const vars = readMessageVariables(chat[index]);
    if (!_.isPlainObject(vars)) {
      continue;
    }
    if (key == null || _.get(vars, key, null) != null) {
      return vars;
    }
  }
  return {};
}

function getCurrentMessageVariables(): Record<string, any> {
  try {
    const chat = getStChat();
    if (!chat.length) {
      return {};
    }
    const messageId = chat.length - 1;
    const previousVars = messageId > 0 ? findPreviousMessageVariables(messageId) : {};
    const currentVars = readMessageVariables(chat[messageId]);
    return _.merge({}, previousVars, currentVars);
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
  const currentMessageId = Math.max(getStChat().length - 1, 0);
  const globalVars = _.cloneDeep(getGlobalVariables());
  const localVars = _.cloneDeep(getChatMetadataVariables());
  const messageVars = _.cloneDeep(getCurrentMessageVariables());
  const cacheVars = {
    ...globalVars,
    ...localVars,
    ...messageVars,
    _modify_id: 0,
  };
  void currentMessageId;
  return {
    globalVars,
    localVars,
    messageVars,
    cacheVars,
  };
}

function rebuildVariableCache(state: EjsRenderContext['variableState']): void {
  const modifyId = Number(state.cacheVars?._modify_id ?? 0);
  state.cacheVars = {
    ...state.globalVars,
    ...state.localVars,
    ...state.messageVars,
    _modify_id: modifyId,
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

  try {
    const stCtx = getStContext() as Record<string, any>;
    const host = getHost();
    const hostExtended = stCtx.substituteParamsExtended ?? host.substituteParamsExtended;
    if (typeof hostExtended === 'function') {
      return String(hostExtended(text, context, (value: unknown) => (value == null ? '' : String(value))) ?? '');
    }
  } catch {
    // fall back to local replacement
  }

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

function getVariableTarget(
  state: EjsRenderContext['variableState'],
  scope: 'cache' | 'global' | 'local' | 'message' = 'cache',
): Record<string, any> {
  if (scope === 'global') {
    return state.globalVars;
  }
  if (scope === 'local') {
    return state.localVars;
  }
  if (scope === 'message') {
    return state.messageVars;
  }
  return state.cacheVars;
}

function mergeVariableValues(oldValue: unknown, value: unknown): unknown {
  if ((oldValue === undefined || Array.isArray(oldValue)) && Array.isArray(value)) {
    return _.concat(oldValue ?? [], value);
  }
  if ((oldValue === undefined || _.isPlainObject(oldValue)) && _.isPlainObject(value)) {
    return _.mergeWith(_.cloneDeep(oldValue ?? {}), value, (_dst: unknown, src: unknown) =>
      Array.isArray(src) ? src : undefined,
    );
  }
  return _.cloneDeep(value);
}

function getVariable(state: EjsRenderContext['variableState'], path: string, opts: Record<string, any> = {}): any {
  const target = getVariableTarget(state, opts.scope ?? 'cache');
  return _.get(target, path, opts.defaults);
}

function setVariable(
  state: EjsRenderContext['variableState'],
  path: string,
  value: unknown,
  opts: Record<string, any> = {},
): any {
  const target = getVariableTarget(state, opts.scope ?? 'message');
  const oldValue = opts.results === 'old' || opts.merge ? _.get(target, path) : undefined;
  const nextValue = opts.merge ? mergeVariableValues(oldValue, value) : _.cloneDeep(value);

  if (nextValue === undefined) {
    _.unset(target, path);
  } else {
    _.set(target, path, nextValue);
  }

  rebuildVariableCache(state);
  state.cacheVars._modify_id = Number(state.cacheVars._modify_id ?? 0) + 1;

  if (opts.results === 'old') {
    return oldValue;
  }
  if (opts.results === 'fullcache') {
    return state.cacheVars;
  }
  return nextValue;
}

function increaseVariable(
  state: EjsRenderContext['variableState'],
  path: string,
  value = 1,
  opts: Record<string, any> = {},
): any {
  const currentValue = Number(getVariable(state, path, { ...opts, defaults: 0, scope: opts.inscope ?? opts.scope }) ?? 0);
  const nextValue = currentValue + Number(value ?? 1);
  return setVariable(state, path, nextValue, { ...opts, scope: opts.outscope ?? opts.scope });
}

function decreaseVariable(
  state: EjsRenderContext['variableState'],
  path: string,
  value = 1,
  opts: Record<string, any> = {},
): any {
  return increaseVariable(state, path, -Number(value ?? 1), opts);
}

function removeVariable(
  state: EjsRenderContext['variableState'],
  path: string,
  index: unknown = undefined,
  opts: Record<string, any> = {},
): any {
  if (index == null) {
    return setVariable(state, path, undefined, opts);
  }
  const currentValue = getVariable(state, path, opts);
  if (Array.isArray(currentValue)) {
    const next = [...currentValue];
    const foundIndex = next.indexOf(index);
    if (foundIndex !== -1) {
      next.splice(foundIndex, 1);
      return setVariable(state, path, next, opts);
    }
  }
  if (_.isPlainObject(currentValue)) {
    const next = _.cloneDeep(currentValue);
    delete next[String(index)];
    return setVariable(state, path, next, opts);
  }
  if (typeof currentValue === 'string' && typeof index === 'string') {
    return setVariable(state, path, currentValue.replace(index, ''), opts);
  }
  return undefined;
}

function insertVariable(
  state: EjsRenderContext['variableState'],
  path: string,
  value: unknown,
  index: number | string | undefined = undefined,
  opts: Record<string, any> = {},
): any {
  const currentValue = getVariable(state, path, opts);
  if (Array.isArray(currentValue)) {
    const next = [...currentValue];
    if (index == null) {
      next.push(value);
    } else {
      const position = Number(index) < 0 ? next.length + Number(index) : Number(index);
      next.splice(position, 0, value);
    }
    return setVariable(state, path, next, opts);
  }
  if (_.isPlainObject(currentValue) && index != null) {
    const next = _.cloneDeep(currentValue);
    next[String(index)] = value;
    return setVariable(state, path, next, opts);
  }
  if (typeof currentValue === 'string') {
    if (typeof index === 'string') {
      const foundIndex = currentValue.indexOf(index);
      if (foundIndex === -1) {
        return undefined;
      }
      return setVariable(
        state,
        path,
        `${currentValue.slice(0, foundIndex)}${String(value ?? '')}${currentValue.slice(foundIndex + index.length)}`,
        opts,
      );
    }
    const position = index == null ? currentValue.length : Number(index) < 0 ? currentValue.length + Number(index) : Number(index);
    return setVariable(
      state,
      path,
      `${currentValue.slice(0, position)}${String(value ?? '')}${currentValue.slice(position)}`,
      opts,
    );
  }
  return undefined;
}

function jsonPatchDocument(doc: any, patches: Array<Record<string, any>>): any {
  const next = _.cloneDeep(doc ?? {});
  for (const patch of Array.isArray(patches) ? patches : []) {
    const op = String(patch?.op ?? '');
    const rawPath = String(patch?.path ?? '');
    const path = rawPath
      .split('/')
      .slice(1)
      .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (op === 'remove') {
      _.unset(next, path);
      continue;
    }
    if (op === 'copy' || op === 'move') {
      const from = String(patch?.from ?? '')
        .split('/')
        .slice(1)
        .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      const value = _.get(next, from);
      if (op === 'move') {
        _.unset(next, from);
      }
      _.set(next, path, value);
      continue;
    }
    if (op === 'test') {
      if (!_.isEqual(_.get(next, path), patch?.value)) {
        return doc;
      }
      continue;
    }
    _.set(next, path, patch?.value);
  }
  return next;
}

function parseJSONCompat(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function patchVariables(
  state: EjsRenderContext['variableState'],
  path: string,
  change: Array<Record<string, any>> | string,
  opts: Record<string, any> = {},
): any {
  const patch = typeof change === 'string' ? parseJSONCompat(change) : change;
  if (!Array.isArray(patch)) {
    return undefined;
  }
  return setVariable(state, path, jsonPatchDocument(getVariable(state, path, opts), patch), opts);
}

// ---------------------------------------------------------------------------
// Chat Message Access (Fix #4)
// ---------------------------------------------------------------------------

declare function getChatMessages(range: string, opts?: Record<string, any>): any[];
declare function getLastMessageId(): number;

function resolvePromptRegexFormatter():
  | ((
      text: string,
      source: 'user_input' | 'ai_output' | 'world_info' | 'slash_command' | 'reasoning',
      destination: 'display' | 'prompt',
      options?: { depth?: number; character_name?: string },
    ) => string)
  | undefined {
  const stCtx = getStContext() as Record<string, any>;
  const host = getHost();
  return stCtx.formatAsTavernRegexedString ?? host.formatAsTavernRegexedString;
}

function applyPromptRegex(
  text: string,
  source: 'user_input' | 'ai_output' | 'world_info' | 'slash_command' | 'reasoning',
  options: { depth?: number; character_name?: string } = {},
): string {
  const formatter = resolvePromptRegexFormatter();
  if (typeof formatter !== 'function' || !text) {
    return text;
  }
  try {
    return String(formatter(text, source, 'prompt', options) ?? '');
  } catch {
    return text;
  }
}

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

function processChatMessage(msg: any, index = -1): string {
  const source = msg?.is_user ? 'user_input' : 'ai_output';
  const depth = index >= 0 ? Math.max(getStChat().length - index - 1, 0) : undefined;
  return substituteParams(
    applyPromptRegex(String(msg?.mes ?? msg?.message ?? ''), source, {
      depth,
      character_name: typeof msg?.name === 'string' ? msg.name : undefined,
    }),
  );
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
    .map((msg: any, messageIndex: number) => ({ msg, messageIndex }))
    .filter(
      item =>
        !role ||
        (role === 'user' && item.msg.is_user) ||
        (role === 'system' && item.msg.is_system) ||
        (role === 'assistant' && !item.msg.is_user && !item.msg.is_system),
    )
    .map(item => processChatMessage(item.msg, item.messageIndex));
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
    text: processChatMessage(msg, index),
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
  return getStChat().some((msg: any, index: number) => regex.test(processChatMessage(msg, index)));
}

function normalizeEntryKey(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function getCharacterData(name: string | RegExp | number | undefined): any | null {
  const stCtx = getStContext();
  const chars = Array.isArray(stCtx.characters) ? stCtx.characters : [];
  const resolvedName = name ?? stCtx.characterId;
  if (resolvedName == null) {
    return null;
  }
  if (typeof resolvedName === 'number') {
    return chars[resolvedName] ?? null;
  }
  return chars.find((char: any) => char?.name === resolvedName || (resolvedName instanceof RegExp && String(char?.name ?? '').match(resolvedName))) ?? null;
}

function getCharacterDefineData(name: string | RegExp | number | undefined): Record<string, any> | null {
  const char = getCharacterData(name);
  if (!char) {
    return null;
  }

  let example = String(char.mes_example ?? '').trim();
  if (example && example.startsWith('<START>')) {
    example = example.slice(7).trim();
  }
  example = example.replace('<START>', '```\n```');
  if (example && example.includes('```')) {
    example += '\n```';
  }

  return {
    name: char.name,
    description: char.description,
    personality: char.personality,
    scenario: char.scenario,
    first_message: char.first_mes,
    message_example: example,
    creator_notes: char.data?.creator_notes,
    creatorcomment: char.creatorcomment,
    system_prompt: char.data?.system_prompt,
    post_history_instructions: char.data?.post_history_instructions,
    alternate_greetings: char.data?.alternate_greetings,
    depth_prompt: char.data?.depth_prompt,
    creator: char.data?.creator,
  };
}

function getPresetPromptContent(name: string | RegExp): string | null {
  const prompts = getStContext().chatCompletionSettings?.prompts;
  if (!Array.isArray(prompts)) {
    return null;
  }
  const preset = prompts.find((item: any) => item?.name === name || (name instanceof RegExp && String(item?.name ?? '').match(name)));
  return typeof preset?.content === 'string' ? preset.content : null;
}

function getQuickReplyContent(name: string | RegExp, label: string | RegExp): string {
  const config = getStContext().extensionSettings?.quickReplyV2?.config;
  if (!config) {
    return '';
  }
  const setLink = config.setList?.find((link: any) => link?.set?.name === name || (name instanceof RegExp && String(link?.set?.name ?? '').match(name)));
  const quickReply = setLink?.set?.qrList?.find((item: any) => item?.label === label || (label instanceof RegExp && String(item?.label ?? '').match(label)));
  return typeof quickReply?.message === 'string' ? quickReply.message : '';
}

function cloneDefinesForContext(self: Record<string, unknown>, source: Record<string, unknown> | unknown[]): Record<string, unknown> | unknown[] {
  const result: Record<string, unknown> | unknown[] = Array.isArray(source) ? [] : {};
  for (const [name, value] of Object.entries(source)) {
    if (_.isFunction(value)) {
      (result as Record<string, unknown>)[name] = value.bind(self);
    } else if (Array.isArray(value) || _.isPlainObject(value)) {
      (result as Record<string, unknown>)[name] = cloneDefinesForContext(self, value as any);
    } else {
      (result as Record<string, unknown>)[name] = value;
    }
  }
  return result;
}

function findEntry(
  ctx: EjsRenderContext,
  currentWorldbook: string,
  worldbookOrEntry: string | RegExp | number | null,
  entryNameOrData?: string | RegExp | number | Record<string, unknown>,
): { name: string; comment?: string; content: string; worldbook: string } | undefined {
  const explicitWorldbook =
    typeof entryNameOrData === 'string' || entryNameOrData instanceof RegExp || typeof entryNameOrData === 'number'
      ? normalizeEntryKey(worldbookOrEntry as string | null | undefined)
      : '';
  const fallbackWorldbook = normalizeEntryKey(currentWorldbook);
  const identifier =
    _.isPlainObject(entryNameOrData) || entryNameOrData === undefined ? worldbookOrEntry : entryNameOrData;

  if (identifier == null || (typeof identifier === 'string' && !normalizeEntryKey(identifier))) {
    return undefined;
  }

  const matchesIdentifier = (entry: { name: string; comment?: string; content: string; worldbook: string }) => {
    if (identifier instanceof RegExp) {
      return Boolean(String(entry.comment ?? '').match(identifier) || String(entry.name ?? '').match(identifier));
    }
    if (typeof identifier === 'number') {
      return Number((entry as RenderWorldInfoEntry).uid) === identifier;
    }
    const normalizedIdentifier = normalizeEntryKey(identifier as string | null | undefined);
    return (
      normalizedIdentifier === normalizeEntryKey(entry.comment) || normalizedIdentifier === normalizeEntryKey(entry.name)
    );
  };

  const lookupInWorldbook = (worldbook: string) => {
    if (!worldbook) return undefined;
    if (typeof identifier === 'string') {
      const exact = ctx.entriesByWorldbook.get(worldbook)?.get(normalizeEntryKey(identifier));
      if (exact) {
        return exact;
      }
    }
    return ctx.entries.find(entry => entry.worldbook === worldbook && matchesIdentifier(entry));
  };

  if (typeof identifier === 'string') {
    const exact = ctx.allEntries.get(normalizeEntryKey(identifier));
    if (exact) {
      return lookupInWorldbook(explicitWorldbook) ?? lookupInWorldbook(fallbackWorldbook) ?? exact;
    }
  }

  return lookupInWorldbook(explicitWorldbook) ?? lookupInWorldbook(fallbackWorldbook) ?? ctx.entries.find(matchesIdentifier);
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
  worldbookOrEntry: string | RegExp | number | null,
  entryNameOrData?: string | RegExp | number | Record<string, unknown>,
  data: Record<string, unknown> = {},
): Promise<string> {
  const entry = _.isPlainObject(entryNameOrData)
    ? findEntry(ctx, currentWorldbook, worldbookOrEntry, undefined)
    : findEntry(ctx, currentWorldbook, worldbookOrEntry, entryNameOrData);
  if (!entry) {
    const missing =
      typeof entryNameOrData === 'string' || entryNameOrData instanceof RegExp || typeof entryNameOrData === 'number'
        ? entryNameOrData
        : worldbookOrEntry;
    console.debug(`[EW EJS Internal] getwi: entry '${String(missing ?? '')}' not found`);
    return '';
  }

  const entryKey = activationKey(entry);
  const entryEnv = _.merge({}, _.isPlainObject(entryNameOrData) ? entryNameOrData : {}, data, {
    world_info: { comment: entry.comment || entry.name, name: entry.name, world: entry.worldbook },
  });

  // Recursion guard
  if (ctx.renderStack.has(entryKey)) {
    console.warn(`[EW EJS Internal] getwi: circular reference detected for '${entry.comment || entry.name}'`);
    return substituteParams(applyPromptRegex(entry.content, 'world_info'), entryEnv);
  }

  if (ctx.renderStack.size >= ctx.maxRecursion) {
    console.warn(`[EW EJS Internal] getwi: max recursion depth (${ctx.maxRecursion}) reached`);
    return substituteParams(applyPromptRegex(entry.content, 'world_info'), entryEnv);
  }

  const processed = substituteParams(applyPromptRegex(entry.content, 'world_info'), entryEnv);
  let finalContent = processed;

  if (processed.includes('<%')) {
    ctx.renderStack.add(entryKey);
    try {
      finalContent = await evalEjsTemplate(processed, ctx, entryEnv);
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
        const avatar = chars?.[chid]?.avatar;
        const getThumbnailUrl = (stCtx as any).getThumbnailUrl ?? getHost().getThumbnailUrl;
        return avatar && typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', avatar) : '';
      } catch {
        return '';
      }
    },

    get userAvatar() {
      try {
        const host = getHost();
        const avatar = (host as any).user_avatar ?? (stCtx as any).user_avatar ?? '';
        const getUserAvatar = host.getUserAvatar;
        const getThumbnailUrl = (stCtx as any).getThumbnailUrl ?? host.getThumbnailUrl;
        if (avatar && typeof getUserAvatar === 'function') {
          return getUserAvatar(avatar);
        }
        if (avatar && typeof getThumbnailUrl === 'function') {
          return getThumbnailUrl('persona', avatar);
        }
        return avatar ? `User Avatars/${avatar}` : '';
      } catch {
        return '';
      }
    },

    // Groups
    groups: stCtx.groups ?? [],
    groupId: stCtx.selectedGroupId ?? null,

    // Model
    get model() {
      try {
        const getChatCompletionModel = (stCtx as any).getChatCompletionModel ?? getHost().getChatCompletionModel;
        if (typeof getChatCompletionModel === 'function') {
          const resolved = getChatCompletionModel((stCtx as any).chatCompletionSettings);
          if (typeof resolved === 'string' && resolved.trim()) {
            return resolved.trim();
          }
        }
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
    getwi: (
      worldbookOrEntry: string | RegExp | number | null,
      entryNameOrData?: string | RegExp | number | Record<string, unknown>,
      data: Record<string, unknown> = {},
    ) => getwi(renderCtx, String(context.world_info?.world ?? ''), worldbookOrEntry, entryNameOrData, data),
    getWorldInfo: (
      worldbookOrEntry: string | RegExp | number | null,
      entryNameOrData?: string | RegExp | number | Record<string, unknown>,
      data: Record<string, unknown> = {},
    ) => getwi(renderCtx, String(context.world_info?.world ?? ''), worldbookOrEntry, entryNameOrData, data),

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
    incvar: (path: string, value = 1, opts?: Record<string, any>) => increaseVariable(renderCtx.variableState, path, value, opts),
    decvar: (path: string, value = 1, opts?: Record<string, any>) => decreaseVariable(renderCtx.variableState, path, value, opts),
    delvar: (path: string, index?: unknown, opts?: Record<string, any>) => removeVariable(renderCtx.variableState, path, index, opts),
    insvar: (path: string, value: unknown, index?: number | string, opts?: Record<string, any>) =>
      insertVariable(renderCtx.variableState, path, value, index, opts),
    incLocalVar: (path: string, value = 1, opts: Record<string, any> = {}) =>
      increaseVariable(renderCtx.variableState, path, value, { ...opts, outscope: 'local' }),
    incGlobalVar: (path: string, value = 1, opts: Record<string, any> = {}) =>
      increaseVariable(renderCtx.variableState, path, value, { ...opts, outscope: 'global' }),
    incMessageVar: (path: string, value = 1, opts: Record<string, any> = {}) =>
      increaseVariable(renderCtx.variableState, path, value, { ...opts, outscope: 'message' }),
    decLocalVar: (path: string, value = 1, opts: Record<string, any> = {}) =>
      decreaseVariable(renderCtx.variableState, path, value, { ...opts, outscope: 'local' }),
    decGlobalVar: (path: string, value = 1, opts: Record<string, any> = {}) =>
      decreaseVariable(renderCtx.variableState, path, value, { ...opts, outscope: 'global' }),
    decMessageVar: (path: string, value = 1, opts: Record<string, any> = {}) =>
      decreaseVariable(renderCtx.variableState, path, value, { ...opts, outscope: 'message' }),
    patchVariables: (path: string, change: Array<Record<string, any>> | string, opts?: Record<string, any>) =>
      patchVariables(renderCtx.variableState, path, change, opts),

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
    getchr: async (name?: string | RegExp | number, template = DEFAULT_CHAR_DEFINE, data: Record<string, any> = {}) => {
      const defs = getCharacterDefineData(name);
      if (!defs) return '';
      const renderEnv = _.merge({}, context, data, defs, { char: defs.name, chara_name: defs.name });
      const rendered = await evalEjsTemplate(template, renderCtx, renderEnv);
      return substituteParams(rendered, renderEnv);
    },
    getchar: undefined as any, // aliased below
    getChara: undefined as any,

    getprp: async (name: string | RegExp, data: Record<string, any> = {}) => {
      const prompt = getPresetPromptContent(name);
      if (!prompt) return '';
      const renderEnv = _.merge({}, context, data, { prompt_name: name });
      return substituteParams(await evalEjsTemplate(prompt, renderCtx, renderEnv), renderEnv);
    },
    getpreset: undefined as any,
    getPresetPrompt: undefined as any,

    execute: async (cmd: string) => {
      const executor = (stCtx as any).executeSlashCommandsWithOptions ?? getHost().executeSlashCommandsWithOptions;
      if (typeof executor !== 'function') {
        return '';
      }
      try {
        const result = await executor(cmd);
        return result?.pipe ?? '';
      } catch {
        return '';
      }
    },

    define: (name: string, value: unknown, merge = false) => {
      const oldValue = _.get(renderCtx.sharedDefines, name, undefined);
      const nextValue = merge ? mergeVariableValues(oldValue, value) : value;
      _.set(renderCtx.sharedDefines, name, nextValue);
      _.set(context, name, nextValue);
      return oldValue;
    },

    // evalTemplate — recursive EJS within workflow context
    evalTemplate: async (content: string, data: Record<string, any> = {}) => {
      const renderEnv = _.merge({}, context, data);
      return substituteParams(await evalEjsTemplate(content, renderCtx, renderEnv), renderEnv);
    },

    getqr: async (name: string | RegExp, label: string | RegExp, data: Record<string, any> = {}) => {
      const reply = getQuickReplyContent(name, label);
      if (!reply) return '';
      const renderEnv = _.merge({}, context, data, { qr_name: name, qr_label: label });
      return substituteParams(await evalEjsTemplate(reply, renderCtx, renderEnv), renderEnv);
    },
    getQuickReply: undefined as any,

    findVariables: (key?: string, messageId: number = chat.length) => findPreviousMessageVariables(messageId, key),

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
    jsonPatch: (_doc: any, patches: Array<Record<string, any>>) => jsonPatchDocument(_doc, patches),
    parseJSON: (str: string) => parseJSONCompat(str),

    // Print function for EJS
    print: (...args: any[]) => args.filter(x => x !== undefined && x !== null).join(''),

    // Merge any extra environment (e.g., world_info metadata from getwi)
    ...extraEnv,
  };

  // Alias getchr variants
  context.getchar = context.getchr;
  context.getChara = context.getchr;
  context.getpreset = context.getprp;
  context.getPresetPrompt = context.getprp;
  context.getQuickReply = context.getqr;
  Object.assign(context, cloneDefinesForContext(context, renderCtx.sharedDefines));

  try {
    const compiled = getEjsRuntime().compile(content, {
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
  entries: Array<{ uid?: number; name: string; comment?: string; content: string; worldbook: string }>,
  maxRecursion = 10,
): EjsRenderContext {
  const allEntries = new Map<string, { uid?: number; name: string; comment?: string; content: string; worldbook: string }>();
  const entriesByWorldbook = new Map<
    string,
    Map<string, { uid?: number; name: string; comment?: string; content: string; worldbook: string }>
  >();
  const normalizedEntries = entries.map(entry => ({
    ...entry,
    name: normalizeEntryKey(entry.name),
    comment: normalizeEntryKey(entry.comment),
  }));

  const registerLookup = (
    lookup: Map<string, { uid?: number; name: string; comment?: string; content: string; worldbook: string }>,
    key: string,
    entry: { uid?: number; name: string; comment?: string; content: string; worldbook: string },
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
    sharedDefines: {},
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
    return await evalEjsTemplate(processed, ctx, templateContext);
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
    getEjsRuntime().compile(content, {
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
