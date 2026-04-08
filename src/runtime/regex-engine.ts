import { getHostRuntime, tryGetSTContext } from '../st-adapter';

/**
 * 酒馆正则处理引擎
 *
 * 收集预设、全局、角色卡三个来源的正则脚本，
 * 按 placement 过滤后对聊天消息执行查找替换。
 */

// ── 正则脚本数据结构 ──────────────────────────────────────────
interface RegexScript {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  /** 规范化后的作用域：0=user, 1=assistant, 2=slash, 3=world info, 4=reasoning */
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number | boolean;
  minDepth: number | null;
  maxDepth: number | null;
  _placementMode?: 'canonical' | 'raw';
}

// ── 收集所有正则脚本 ──────────────────────────────────────────

/**
 * 从三个来源收集正则脚本：全局、预设绑定、角色卡局部。
 * 返回合并后的脚本数组（去重依据 id）。
 */
type TavernRegexGetter = ((option: { type: 'global' | 'preset' | 'character'; name?: string }) => any[]) | undefined;
type CharacterRegexEnabledGetter = (() => boolean) | undefined;

export function collectAllRegexScripts(): RegexScript[] {
  const scriptsById = new Map<string, RegexScript>();
  const win = getHostRuntime() as any;

  // 获取 ST 上下文
  const ctx = tryGetSTContext() as Record<string, any> | undefined;
  const getTavernRegexes: TavernRegexGetter = ctx?.getTavernRegexes ?? win.getTavernRegexes;
  const isCharacterTavernRegexesEnabled: CharacterRegexEnabledGetter =
    ctx?.isCharacterTavernRegexesEnabled ?? win.isCharacterTavernRegexesEnabled;

  let globalCount = 0;
  let presetCount = 0;
  let characterCount = 0;

  const addScripts = (items: any[], source: 'global' | 'preset' | 'character') => {
    items.forEach((item, index) => {
      if (!item) return;
      const normalized = normalizeScript(item);
      if (normalized.disabled || !normalized.findRegex) return;

      const key = normalized.id || `${source}:${index}:${normalized.scriptName}:${normalized.findRegex}`;
      scriptsById.set(key, normalized);

      if (source === 'global') globalCount += 1;
      if (source === 'preset') presetCount += 1;
      if (source === 'character') characterCount += 1;
    });
  };

  const readArrayPath = (root: any, paths: string[][]): any[] => {
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
      if (ok && Array.isArray(current)) return current;
    }
    return [];
  };

  const collectViaApi = (source: 'global' | 'preset' | 'character'): any[] => {
    if (typeof getTavernRegexes !== 'function') return [];
    try {
      if (source === 'global') return getTavernRegexes({ type: 'global' }) ?? [];
      if (source === 'preset') return getTavernRegexes({ type: 'preset', name: 'in_use' }) ?? [];
      if (source === 'character') {
        if (typeof isCharacterTavernRegexesEnabled === 'function' && !isCharacterTavernRegexesEnabled()) {
          return [];
        }
        return getTavernRegexes({ type: 'character', name: 'current' }) ?? [];
      }
    } catch (error) {
      console.debug(`[EW Regex] getTavernRegexes(${source}) 读取失败，回退上下文路径:`, error);
    }
    return [];
  };

  // 来源 1：全局正则（ST 正则扩展存储在 extension_settings.regex 中）
  try {
    const apiScripts = collectViaApi('global');
    if (apiScripts.length > 0) {
      addScripts(apiScripts, 'global');
    } else {
      const extSettings = ctx?.extensionSettings ?? win.extension_settings;
      addScripts(readArrayPath(extSettings, [['regex'], ['regex', 'regex_scripts']]), 'global');
    }
  } catch {
    /* 全局正则不可用，跳过 */
  }

  // 来源 2：预设绑定正则（当前预设 JSON 的 extensions.regex_scripts）
  try {
    const apiScripts = collectViaApi('preset');
    if (apiScripts.length > 0) {
      addScripts(apiScripts, 'preset');
    } else {
      const oaiSettings = ctx?.chatCompletionSettings ?? win.oai_settings;
      addScripts(readArrayPath(oaiSettings, [['regex_scripts'], ['extensions', 'regex_scripts']]), 'preset');
    }
  } catch {
    /* 预设正则不可用，跳过 */
  }

  // 来源 3：角色卡局部正则（优先 character.extensions.regex_scripts）
  try {
    const apiScripts = collectViaApi('character');
    if (apiScripts.length > 0) {
      addScripts(apiScripts, 'character');
    } else {
      const charId = ctx?.characterId;
      const characters = ctx?.characters;
      if (charId !== undefined && characters) {
        const char = characters[Number(charId)];
        addScripts(
          readArrayPath(char, [
            ['extensions', 'regex_scripts'],
            ['data', 'extensions', 'regex_scripts'],
          ]),
          'character',
        );
      }
    }
  } catch {
    /* 角色卡正则不可用，跳过 */
  }

  const scripts = [...scriptsById.values()];
  normalizePlacementMode(scripts);

  console.debug(
    `[EW Regex] 收集完成: global=${globalCount}, preset=${presetCount}, character=${characterCount}, total=${scripts.length}`,
  );

  return scripts;
}

/** 将来源不同的脚本数据统一为 RegexScript 结构 */
function normalizeScript(raw: any): RegexScript {
  const placementFromSource = normalizePlacementFromSource(raw?.source);
  const trimStrings = Array.isArray(raw.trimStrings)
    ? raw.trimStrings
    : typeof raw.trim_strings === 'string'
      ? raw.trim_strings
          .split('\n')
          .map((item: string) => item.trim())
          .filter(Boolean)
      : [];

  const replaceString = raw.replaceString ?? raw.replace_string ?? '';
  const destination = raw?.destination;
  const promptOnly =
    typeof destination === 'object'
      ? Boolean(destination.prompt) && !Boolean(destination.display)
      : Boolean(raw.promptOnly);
  const markdownOnly =
    typeof destination === 'object'
      ? Boolean(destination.display) && !Boolean(destination.prompt)
      : Boolean(raw.markdownOnly);

  return {
    id: raw.id ?? '',
    scriptName: raw.scriptName ?? raw.script_name ?? '',
    findRegex: raw.findRegex ?? raw.find_regex ?? '',
    replaceString,
    trimStrings,
    placement:
      placementFromSource ??
      (Array.isArray(raw.placement) ? raw.placement.filter((item: unknown) => typeof item === 'number') : []),
    disabled: raw.enabled === false ? true : Boolean(raw.disabled),
    markdownOnly,
    promptOnly,
    runOnEdit: Boolean(raw.runOnEdit ?? raw.run_on_edit),
    substituteRegex: raw.substituteRegex ?? 0,
    minDepth: raw.minDepth ?? null,
    maxDepth: raw.maxDepth ?? null,
    _placementMode: placementFromSource ? 'canonical' : 'raw',
  };
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

  console.debug('[EW Regex] 检测到新版 placement 编码，已转换为内部统一编号');
}

// ── 美化正则检测 ──────────────────────────────────────────────

/**
 * 检测 replaceString 是否为美化/渲染用途。
 * 包含 HTML 标签、style/class 属性或 CSS 相关内容时判定为美化正则。
 */
const HTML_TAG_PATTERN =
  /<\/?(?:div|span|p|br|hr|img|details|summary|section|article|aside|header|footer|nav|ul|ol|li|table|tr|td|th|h[1-6]|a|em|strong|blockquote|pre|code|svg|path)\b/i;
const HTML_ATTR_PATTERN = /\b(?:style|class|id|href|src|data-)\s*=/i;

export function isBeautificationReplace(replaceString: string): boolean {
  if (!replaceString) return false;
  return HTML_TAG_PATTERN.test(replaceString) || HTML_ATTR_PATTERN.test(replaceString);
}

// ── 执行正则替换 ──────────────────────────────────────────────

/**
 * 对单条消息内容执行一组正则脚本。
 *
 * @param content   消息文本
 * @param scripts   要执行的脚本数组
 * @param role      消息角色，决定使用 placement 0(user) 还是 1(assistant)
 * @returns 处理后的文本
 */
function applyRegexScripts(content: string, scripts: RegexScript[], role: 'user' | 'assistant' | 'system'): string {
  // 内部统一编号：0 = user input, 1 = AI output
  // system 消息暂按 AI output 处理（与 ST 行为一致）
  const targetPlacement = role === 'user' ? 0 : 1;

  let result = content;
  for (const script of scripts) {
    // 跳过禁用脚本
    if (script.disabled) continue;
    // 只保留 markdownOnly=false 的脚本（prompt 场景不是 markdown 渲染）
    if (script.markdownOnly) continue;
    // 检查 placement 是否匹配
    if (!script.placement.includes(targetPlacement)) continue;
    // 空正则跳过
    if (!script.findRegex) continue;

    try {
      const regex = parseRegexFromString(script.findRegex);
      if (!regex) continue;

      // 美化正则检测：replaceString 包含 HTML 标签 → 说明是用于渲染的美化正则，
      // 在 prompt 场景中我们要的是干净正文，所以将其替换为空字符串（仅本地处理，不改酒馆原始正则）
      let effectiveReplace = script.replaceString;
      if (isBeautificationReplace(effectiveReplace)) {
        console.debug(`[EW Regex] 检测到美化正则 "${script.scriptName}"，替换为空以获取干净正文`);
        effectiveReplace = '';
      }

      result = result.replace(regex, effectiveReplace);

      // 执行 trimStrings
      for (const trim of script.trimStrings) {
        if (trim) {
          result = result.split(trim).join('');
        }
      }
    } catch (e) {
      console.warn(`[EW Regex] 脚本 "${script.scriptName}" 执行失败:`, e);
    }
  }
  return result;
}

/**
 * 将 ST 格式的正则字符串解析为 RegExp 对象。
 * ST 格式："/pattern/flags" 或纯字符串。
 */
function parseRegexFromString(regexStr: string): RegExp | null {
  if (!regexStr) return null;
  // 尝试解析 /pattern/flags 格式
  const match = regexStr.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  // 纯字符串 → 当字面量使用
  return new RegExp(regexStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

// ── 公开接口 ──────────────────────────────────────────────────

/**
 * 对一组聊天消息应用酒馆的正则处理。
 * 收集全局 + 预设 + 角色卡的正则脚本，跳过 markdownOnly 脚本，
 * 按 placement 匹配消息角色后执行查找替换。
 *
 * @param messages  聊天消息数组（会被原地修改）
 */
export function applyTavernRegex(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>,
): void {
  const scripts = collectAllRegexScripts();
  if (!scripts.length) {
    console.debug('[EW Regex] 没有可用的正则脚本');
    return;
  }

  console.debug(`[EW Regex] 收集到 ${scripts.length} 条正则脚本，开始处理 ${messages.length} 条消息`);

  for (const msg of messages) {
    const original = msg.content;
    msg.content = applyRegexScripts(msg.content, scripts, msg.role);
    if (msg.content !== original) {
      console.debug(`[EW Regex] 消息已处理 (role=${msg.role}, name=${msg.name ?? 'N/A'})`);
    }
  }
}
