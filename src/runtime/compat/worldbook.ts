/**
 * Compat: 世界书系统
 *
 * 替代旧的 getWorldbook / replaceWorldbook / createWorldbook /
 * getCharWorldbookNames / rebindCharWorldbooks 全局函数。
 *
 * 重要协议对齐:
 * - ST 的 `/api/worldinfo/edit` 接受 `{ name, data }`,其中 data.entries
 *   是 Record<uid, entry> (按 uid 为 key 的对象),不是数组。
 * - ST 的 `/api/worldinfo/get` 返回完整的 data 对象 (含 data.entries)。
 * - 角色附加世界书存储在 world_info.charLore[].extraBooks 中,
 *   key 是角色文件名 (avatar),不是 character.data.extensions.world_additional。
 */
import { getSTContext, getRequestHeaders } from '../../st-adapter';

// ── 类型定义 ──────────────────────────────────────────

/** 世界书条目类型 — 替代旧的幽灵 WorldbookEntry。 */
export interface WbEntry {
  uid: number;
  name: string;
  comment?: string;
  content: string;
  enabled: boolean;
  disable?: boolean;
  position: {
    type: string;
    role: string;
    depth: number;
    order: number;
  };
  strategy: {
    type: string;
    keys: string[];
    keys_secondary: { logic: string; keys: string[] };
    scan_depth: string | number;
  };
  probability: number;
  recursion: {
    prevent_incoming: boolean;
    prevent_outgoing: boolean;
    delay_until: number | null;
  };
  effect: {
    sticky: number | null;
    cooldown: number | null;
    delay: number | null;
  };
  extra: Record<string, any>;
}

export type CharWorldbookNames = {
  primary: string | null;
  additional: string[];
};

// ── ST 数据格式 ──────────────────────────────────────

/**
 * ST 世界书的"整体数据对象",entries 是按 uid 为 key 的对象。
 * 这是 `/api/worldinfo/get` 返回和 `/api/worldinfo/edit` 接受的格式。
 */
interface StWorldInfoData {
  entries: Record<number, any>;
  [key: string]: any;
}

function isWorldInfoData(value: unknown): value is StWorldInfoData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as StWorldInfoData).entries === 'object',
  );
}

// ── 枚举映射表 ─────────────────────────────────────
// 必须与 ST 宿主保持完全一致。

/** ST world_info_logic (selectiveLogic 字段值) */
const SELECTIVE_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const;

/** selectiveLogic: 数字 → 字符串 */
const SELECTIVE_LOGIC_NUM_TO_STR: Record<number, string> = {
  [SELECTIVE_LOGIC.AND_ANY]: 'and_any',
  [SELECTIVE_LOGIC.NOT_ALL]: 'not_all',
  [SELECTIVE_LOGIC.NOT_ANY]: 'not_any',
  [SELECTIVE_LOGIC.AND_ALL]: 'and_all',
};

/** selectiveLogic: 字符串 → 数字 */
const SELECTIVE_LOGIC_STR_TO_NUM: Record<string, number> = {
  'and_any': SELECTIVE_LOGIC.AND_ANY,
  'not_all': SELECTIVE_LOGIC.NOT_ALL,
  'not_any': SELECTIVE_LOGIC.NOT_ANY,
  'and_all': SELECTIVE_LOGIC.AND_ALL,
};

/** ST extension_prompt_roles (role 字段值) */
const EXTENSION_PROMPT_ROLES = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
} as const;

/** role: 数字 → 字符串 */
const ROLE_NUM_TO_STR: Record<number, string> = {
  [EXTENSION_PROMPT_ROLES.SYSTEM]: 'system',
  [EXTENSION_PROMPT_ROLES.USER]: 'user',
  [EXTENSION_PROMPT_ROLES.ASSISTANT]: 'assistant',
};

/** role: 字符串 → 数字 */
const ROLE_STR_TO_NUM: Record<string, number> = {
  'system': EXTENSION_PROMPT_ROLES.SYSTEM,
  'user': EXTENSION_PROMPT_ROLES.USER,
  'assistant': EXTENSION_PROMPT_ROLES.ASSISTANT,
};

/** ST world_info_position */
const POSITION = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const;

const POSITION_NUM_TO_STR: Record<number, string> = {
  [POSITION.before]: 'before',
  [POSITION.after]: 'after',
  [POSITION.ANTop]: 'ANTop',
  [POSITION.ANBottom]: 'ANBottom',
  [POSITION.atDepth]: 'atDepth',
  [POSITION.EMTop]: 'EMTop',
  [POSITION.EMBottom]: 'EMBottom',
  [POSITION.outlet]: 'outlet',
};

const POSITION_STR_TO_NUM: Record<string, number> = Object.fromEntries(
  Object.entries(POSITION_NUM_TO_STR).map(([k, v]) => [v, Number(k)]),
);

// ── 内部辅助 ─────────────────────────────────────────

/**
 * 将 ST 原始条目 (keyed object) 转化为 WbEntry 数组。
 * ST 条目字段名是数字枚举,转化为可读字符串。
 */
function stEntriesToArray(entries: Record<number, any>): WbEntry[] {
  if (!entries || typeof entries !== 'object') return [];

  return Object.values(entries).map((raw: any) => {
    const enabled = raw.disable !== undefined ? !raw.disable : (raw.enabled ?? true);
    const name = String(raw.comment ?? raw.key?.[0] ?? '');
    const content = String(raw.content ?? '');

    // 数字 → 字符串映射,未知值打 warning 并使用默认值
    const rawRole = Number(raw.role ?? EXTENSION_PROMPT_ROLES.SYSTEM);
    const roleStr = ROLE_NUM_TO_STR[rawRole];
    if (roleStr === undefined) {
      console.warn(`[Compat] Unknown ST role value: ${rawRole}, defaulting to 'system'`);
    }

    const rawLogic = Number(raw.selectiveLogic ?? SELECTIVE_LOGIC.AND_ANY);
    const logicStr = SELECTIVE_LOGIC_NUM_TO_STR[rawLogic];
    if (logicStr === undefined) {
      console.warn(`[Compat] Unknown ST selectiveLogic value: ${rawLogic}, defaulting to 'and_any'`);
    }

    const rawPos = Number(raw.position ?? POSITION.before);
    const posStr = raw.constant ? 'constant' : (POSITION_NUM_TO_STR[rawPos] ?? String(rawPos));

    return {
      uid: Number(raw.uid ?? 0),
      name,
      comment: raw.comment,
      content,
      enabled,
      disable: raw.disable,
      position: {
        type: posStr,
        role: roleStr ?? 'system',
        depth: Number(raw.depth ?? 0),
        order: Number(raw.order ?? 100),
      },
      strategy: {
        type: raw.constant ? 'constant' : (raw.selective ? 'selective' : 'normal'),
        keys: Array.isArray(raw.key) ? raw.key : [],
        keys_secondary: {
          logic: logicStr ?? 'and_any',
          keys: Array.isArray(raw.keysecondary) ? raw.keysecondary : [],
        },
        scan_depth: raw.scanDepth ?? 'same_as_global',
      },
      probability: Number(raw.probability ?? 100),
      recursion: {
        prevent_incoming: Boolean(raw.excludeRecursion),
        prevent_outgoing: Boolean(raw.preventRecursion),
        delay_until: raw.delayUntilRecursion ?? null,
      },
      effect: {
        sticky: raw.sticky ?? null,
        cooldown: raw.cooldown ?? null,
        delay: raw.delay ?? null,
      },
      extra: {},
    };
  });
}

/**
 * 将 WbEntry 数组转化回 ST 的 keyed entries object。
 * 字符串标签映射回 ST 数字枚举。
 * 未知值打 warning 并回退到宿主默认值。
 */
function arrayToStEntries(entries: WbEntry[]): Record<number, any> {
  const result: Record<number, any> = {};
  for (const entry of entries) {
    // selectiveLogic: 字符串 → 数字 (完整 4 值映射)
    const logicStr = entry.strategy?.keys_secondary?.logic ?? 'and_any';
    let selectiveLogicNum = SELECTIVE_LOGIC_STR_TO_NUM[logicStr];
    if (selectiveLogicNum === undefined) {
      console.warn(`[Compat] Unknown selectiveLogic '${logicStr}', defaulting to AND_ANY (0)`);
      selectiveLogicNum = SELECTIVE_LOGIC.AND_ANY;
    }

    // role: 字符串 → 数字 (完整 3 值映射)
    const roleStr = entry.position?.role ?? 'system';
    let roleNum = ROLE_STR_TO_NUM[roleStr];
    if (roleNum === undefined) {
      console.warn(`[Compat] Unknown role '${roleStr}', defaulting to SYSTEM (0)`);
      roleNum = EXTENSION_PROMPT_ROLES.SYSTEM;
    }

    // position: 字符串 → 数字
    const posType = entry.position?.type ?? 'before';
    const isConstant = entry.strategy?.type === 'constant' || posType === 'constant';
    let positionNum: number;
    if (isConstant) {
      positionNum = POSITION.before; // constant 条目的 position 不重要,ST 用 constant 标志
    } else {
      positionNum = POSITION_STR_TO_NUM[posType] ?? (isNaN(Number(posType)) ? POSITION.before : Number(posType));
    }

    result[entry.uid] = {
      uid: entry.uid,
      comment: entry.name ?? entry.comment ?? '',
      content: entry.content,
      disable: !entry.enabled,
      key: entry.strategy?.keys ?? [],
      keysecondary: entry.strategy?.keys_secondary?.keys ?? [],
      selective: entry.strategy?.type === 'selective',
      selectiveLogic: selectiveLogicNum,
      constant: isConstant,
      position: positionNum,
      role: roleNum,
      depth: entry.position?.depth ?? 0,
      order: entry.position?.order ?? 100,
      excludeRecursion: entry.recursion?.prevent_incoming ?? false,
      preventRecursion: entry.recursion?.prevent_outgoing ?? false,
      delayUntilRecursion: entry.recursion?.delay_until ?? 0,
      probability: entry.probability ?? 100,
      useProbability: true,
      sticky: entry.effect?.sticky ?? null,
      cooldown: entry.effect?.cooldown ?? null,
      delay: entry.effect?.delay ?? null,
      scanDepth: entry.strategy?.scan_depth === 'same_as_global' ? null : entry.strategy?.scan_depth,
    };
  }
  return result;
}

// ── 世界书 CRUD ──────────────────────────────────────

/**
 * 读取指定名称的世界书全部条目。
 * 替代旧 `getWorldbook(name)`。
 *
 * 注意: ST 返回的是完整 data 对象 `{ entries: {...} }`,
 * 此函数将 keyed entries 转化为 WbEntry[]。
 */
export async function getWorldbook(name: string): Promise<WbEntry[]> {
  const headers = getRequestHeaders();
  const response = await fetch('/api/worldinfo/get', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(`[Compat] getWorldbook('${name}') failed: ${response.status}`);
  }
  const data: StWorldInfoData = await response.json();

  // ST 返回完整 data 对象,entries 是 keyed object
  if (data && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
    return stEntriesToArray(data.entries);
  }

  // 兜底: 如果返回的是数组 (旧版本?)
  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

/**
 * 替换世界书的全部条目。
 * 替代旧 `replaceWorldbook(name, entries, opts)`。
 *
 * 重要: ST 的 `/api/worldinfo/edit` 接受 `{ name, data }`,
 * 其中 data = { entries: Record<uid, entry> }。
 * 此函数将 WbEntry[] 转化回 ST 的 keyed format。
 */
export async function replaceWorldbook(
  name: string,
  entries: WbEntry[],
  opts?: { render?: 'debounced' | 'immediate' | 'none' },
): Promise<void> {
  const headers = getRequestHeaders();

  // 先读取现有 data,保留非 entries 的元数据
  const getResponse = await fetch('/api/worldinfo/get', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  if (!getResponse.ok) {
    throw new Error(
      `[Compat] replaceWorldbook('${name}') pre-read failed: ${getResponse.status}`,
    );
  }
  const existing = await getResponse.json();
  let baseData: StWorldInfoData;
  if (isWorldInfoData(existing)) {
    baseData = existing;
  } else if (Array.isArray(existing)) {
    baseData = { entries: arrayToStEntries(existing as WbEntry[]) };
  } else {
    throw new Error(
      `[Compat] replaceWorldbook('${name}') received invalid worldinfo payload`,
    );
  }

  // 用新的 entries 覆盖
  baseData.entries = arrayToStEntries(entries);

  const response = await fetch('/api/worldinfo/edit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, data: baseData }),
  });
  if (!response.ok) {
    throw new Error(`[Compat] replaceWorldbook('${name}') failed: ${response.status}`);
  }

  // 如果需要更新 WI 编辑器
  if (opts?.render !== 'none') {
    try {
      const ctx = getSTContext() as any;
      if (typeof ctx.reloadWorldInfoEditor === 'function') {
        ctx.reloadWorldInfoEditor();
      }
    } catch { /* 静默失败 */ }
  }
}

/**
 * 创建一个新的空世界书。
 * 替代旧 `createWorldbook(name, entries)`。
 *
 * 按照 ST 的 createNewWorldInfo 模式:
 * 创建 `{ entries: {} }` 模板 → saveWorldInfo → 持久化。
 */
export async function createWorldbook(name: string, entries: WbEntry[] = []): Promise<void> {
  const headers = getRequestHeaders();
  const data: StWorldInfoData = {
    entries: entries.length > 0 ? arrayToStEntries(entries) : {},
  };

  const response = await fetch('/api/worldinfo/edit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, data }),
  });
  if (!response.ok) {
    throw new Error(`[Compat] createWorldbook('${name}') failed: ${response.status}`);
  }
}

// ── 角色世界书绑定 ──────────────────────────────────

/**
 * 获取当前角色绑定的世界书名称。
 * 替代旧 `getCharWorldbookNames('current')`。
 *
 * primary: 从 character.data.extensions.world 读取
 * additional: 从 world_info.charLore 读取 (按角色文件名查找)
 */
export function getCharWorldbookNames(): CharWorldbookNames {
  const ctx = getSTContext() as any;
  const chid = ctx.characterId;
  const characters = ctx.characters;

  if (chid == null || !characters?.[chid]) {
    return { primary: null, additional: [] };
  }

  const char = characters[chid];
  const primary = char.data?.extensions?.world ?? char.world ?? null;

  // additional: 从 world_info.charLore 读取
  // charLore 的 key 是角色文件名 (avatar),不是角色名
  const additional: string[] = [];
  try {
    const charFileName = char.avatar ?? '';
    const worldInfo = (ctx as any).worldInfo ?? (window as any).world_info;
    if (worldInfo?.charLore && Array.isArray(worldInfo.charLore)) {
      const charLoreEntry = worldInfo.charLore.find(
        (e: any) => e.name === charFileName,
      );
      if (charLoreEntry?.extraBooks && Array.isArray(charLoreEntry.extraBooks)) {
        additional.push(...charLoreEntry.extraBooks);
      }
    }
  } catch (e) {
    console.debug('[Compat] getCharWorldbookNames: cannot read charLore:', e);
  }

  return {
    primary: primary ? String(primary) : null,
    additional,
  };
}

/**
 * 重新绑定角色的主世界书。
 * 替代旧 `rebindCharWorldbooks('current', { primary, additional })`。
 *
 * 注意:
 * - primary 通过修改角色数据的 extensions.world 实现
 * - additional 通过修改 world_info.charLore 实现 (按 ST 模式)
 */
export async function rebindCharWorldbooks(
  binding: { primary: string; additional: string[] },
): Promise<void> {
  const ctx = getSTContext() as any;
  const chid = ctx.characterId;
  const characters = ctx.characters;

  if (chid == null || !characters?.[chid]) {
    console.warn('[Compat] rebindCharWorldbooks: no active character');
    return;
  }

  const char = characters[chid];

  // 更新 primary: 角色的 extensions.world
  if (!char.data) char.data = {};
  if (!char.data.extensions) char.data.extensions = {};
  char.data.extensions.world = binding.primary;

  // 持久化 primary: 通过 ST 的 character edit API
  const headers = getRequestHeaders();
  try {
    await fetch('/api/characters/merge-attributes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        avatar: char.avatar,
        data: { extensions: { world: binding.primary } },
      }),
    });
  } catch (e) {
    console.warn('[Compat] rebindCharWorldbooks primary persistence failed:', e);
  }

  // 更新 additional: 通过 world_info.charLore + 持久化
  try {
    const charFileName = char.avatar ?? '';
    const worldInfo = (ctx as any).worldInfo ?? (window as any).world_info;
    if (worldInfo && charFileName) {
      if (!worldInfo.charLore) worldInfo.charLore = [];
      const idx = worldInfo.charLore.findIndex((e: any) => e.name === charFileName);
      const nextBooks = binding.additional ?? [];

      if (nextBooks.length === 0) {
        // 没有 additional books → 移除 charLore 条目 (与 ST updateAuxBooks 一致)
        if (idx !== -1) worldInfo.charLore.splice(idx, 1);
      } else if (idx !== -1) {
        worldInfo.charLore[idx] = { ...worldInfo.charLore[idx], extraBooks: nextBooks };
      } else {
        worldInfo.charLore.push({ name: charFileName, extraBooks: nextBooks });
      }

      // 持久化: 等价于 ST 的 saveSettingsDebounced()
      if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
      } else {
        console.error('[Compat] saveSettingsDebounced unavailable — charLore changes will NOT persist!');
      }
    } else {
      console.error('[Compat] world_info or charFileName unavailable — charLore changes will NOT persist!');
    }
  } catch (e) {
    console.error('[Compat] rebindCharWorldbooks additional persistence failed:', e);
  }
}

/**
 * 获取 lorebook 条目 (含 comment 字段)。
 * 替代旧 `getLorebookEntries(name)`。
 */
export async function getLorebookEntries(
  name: string,
): Promise<Array<{ uid: number; comment: string; content: string }>> {
  // 复用 getWorldbook,WbEntry 已包含 comment
  const entries = await getWorldbook(name);
  return entries.map(e => ({
    uid: e.uid,
    comment: e.comment ?? e.name ?? '',
    content: e.content,
  }));
}
