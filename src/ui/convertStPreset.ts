/**
 * SillyTavern 预设 → EwFlowConfig 转换器
 *
 * 自动检测两种 ST 预设变体：
 *  1. 标准格式 — 顶层 temperature + prompts[]
 *  2. 扩展包装 — extensions.SPreset 内嵌正则等
 *
 * 转换为 EwFlowConfig 原始对象（由调用方通过 EwFlowConfigSchema.parse 做最终校验）。
 */

import type { EwFlowConfig, EwPromptOrderEntry } from '../runtime/types';
import { DEFAULT_PROMPT_ORDER } from '../runtime/types';

// ── ST 预设检测 ──────────────────────────────────────────────

const ST_TOP_LEVEL_KEYS = new Set([
  'temperature', 'top_p', 'frequency_penalty', 'presence_penalty',
  'openai_max_context', 'openai_max_tokens', 'prompts',
]);

/**
 * 判断一个已解析的 JSON 对象是否像 SillyTavern 预设。
 * 判定条件：存在 `prompts` 数组 且 至少命中 2 个其它已知 ST 顶层字段。
 */
export function isSillyTavernPreset(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const rec = obj as Record<string, unknown>;

  // 标准格式
  if (Array.isArray(rec.prompts)) {
    let hits = 0;
    for (const key of ST_TOP_LEVEL_KEYS) {
      if (key in rec) hits++;
    }
    return hits >= 3; // prompts + 至少 2 个生成参数
  }

  // 扩展包装格式 (Izumi 样式) — 暂不支持，因为没有 prompts 顶层
  return false;
}

// ── 内部辅助 ─────────────────────────────────────────────────

/** ST injection_position (number) → EwPromptOrderEntry injection_position */
function mapInjPos(v: unknown): 'relative' | 'in_chat' {
  return v === 1 ? 'in_chat' : 'relative';
}

/** 生成随机 ID */
function uid(): string {
  return crypto.randomUUID?.() ?? `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 核心转换 ─────────────────────────────────────────────────

/**
 * 将 SillyTavern 预设 JSON 转换为 EwFlowConfig（未校验）。
 * @param preset  已解析的 ST 预设对象
 * @param name    用作 flow 名称（通常是文件名去掉 .json）
 */
export function convertStPresetToFlow(
  preset: Record<string, unknown>,
  name: string,
): EwFlowConfig {
  // ── 1. 生成参数 ──
  const genOpts: Record<string, unknown> = {};

  if (typeof preset.temperature === 'number') genOpts.temperature = preset.temperature;
  if (typeof preset.top_p === 'number') genOpts.top_p = preset.top_p;
  if (typeof preset.frequency_penalty === 'number') genOpts.frequency_penalty = preset.frequency_penalty;
  if (typeof preset.presence_penalty === 'number') genOpts.presence_penalty = preset.presence_penalty;
  if (typeof preset.openai_max_context === 'number') genOpts.max_context_tokens = preset.openai_max_context;
  if (typeof preset.openai_max_tokens === 'number') genOpts.max_reply_tokens = preset.openai_max_tokens;
  if (typeof preset.stream_openai === 'boolean') genOpts.stream = preset.stream_openai;
  if (typeof preset.max_context_unlocked === 'boolean') genOpts.unlock_context_length = preset.max_context_unlocked;

  // ── 2. prompt_order 构建 ──
  //
  // ST 预设结构：
  //   prompts[]      — 提示词定义 BAG（顺序不重要，仅定义 content/role/marker 等）
  //   prompt_order[] — 真正的显示顺序 + enabled 覆盖
  //
  // prompt_order 格式: [{character_id, order: [{identifier, enabled}, ...]}]
  // 我们取 order[0].order 作为排序依据。
  //
  // ST 还会复用内置标识符：
  //   "nsfw"     → 实际用作 Auxiliary Prompt 的内容槽
  //   "jailbreak" → 实际用作 Post-History Instructions 的内容槽
  //   "enhanceDefinitions" → Enhance Definitions 的内容槽

  const stPrompts = preset.prompts as Array<Record<string, unknown>> | undefined;
  let promptOrder: EwPromptOrderEntry[];

  if (Array.isArray(stPrompts) && stPrompts.length > 0) {
    // (a) 构建查找表：identifier → prompt 定义
    const promptMap = new Map<string, Record<string, unknown>>();
    for (const p of stPrompts) {
      const id = typeof p.identifier === 'string' ? p.identifier : '';
      if (id) promptMap.set(id, p);
    }

    // (b) 从 prompt_order 中提取排序（如果存在）
    const stOrder = preset.prompt_order as Array<Record<string, unknown>> | undefined;
    let orderList: Array<{ identifier: string; enabled: boolean }> | null = null;

    if (Array.isArray(stOrder) && stOrder.length > 0) {
      const first = stOrder[0];
      const inner = first?.order;
      if (Array.isArray(inner)) {
        orderList = inner
          .filter((e: any) => typeof e?.identifier === 'string')
          .map((e: any) => ({
            identifier: e.identifier as string,
            enabled: e.enabled !== false,
          }));
      }
    }

    // (c) 按照顺序转换 prompt 定义
    const seen = new Set<string>();
    const result: EwPromptOrderEntry[] = [];

    const convertPrompt = (identifier: string, enabledOverride?: boolean): EwPromptOrderEntry | null => {
      if (seen.has(identifier)) return null; // 去重
      seen.add(identifier);

      const p = promptMap.get(identifier);
      if (!p) return null; // 定义不存在则跳过

      const isMarker = p.marker === true;
      const enabled = enabledOverride ?? (p.enabled !== false);

      return {
        identifier,
        name: typeof p.name === 'string' ? p.name : identifier,
        enabled,
        type: isMarker ? 'marker' : 'prompt',
        role: (['system', 'user', 'assistant'].includes(p.role as string)
          ? p.role : 'system') as 'system' | 'user' | 'assistant',
        content: typeof p.content === 'string' ? p.content : '',
        injection_position: mapInjPos(p.injection_position),
        injection_depth: typeof p.injection_depth === 'number' ? p.injection_depth : 0,
      } satisfies EwPromptOrderEntry;
    };

    if (orderList) {
      // 按 prompt_order 排列（不追加 prompt_order 中未出现的条目）
      for (const entry of orderList) {
        const item = convertPrompt(entry.identifier, entry.enabled);
        if (item) result.push(item);
      }
    } else {
      // 无 prompt_order 时按 prompts[] 原始顺序
      for (const p of stPrompts) {
        const id = typeof p.identifier === 'string' ? p.identifier : '';
        if (id) {
          const item = convertPrompt(id);
          if (item) result.push(item);
        }
      }
    }

    promptOrder = result.length > 0 ? result : [...DEFAULT_PROMPT_ORDER];
  } else {
    promptOrder = [...DEFAULT_PROMPT_ORDER];
  }

  // ── 3. 正则规则（扩展包装格式） ──
  const customRegex: Array<{ id: string; name: string; enabled: boolean; find_regex: string; replace_string: string }> = [];
  const extensions = preset.extensions;
  if (extensions && typeof extensions === 'object' && !Array.isArray(extensions)) {
    const sp = (extensions as Record<string, unknown>).SPreset;
    if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
      const rb = (sp as Record<string, unknown>).RegexBinding;
      if (rb && typeof rb === 'object' && !Array.isArray(rb) && Array.isArray((rb as Record<string, unknown>).regexes)) {
        for (const r of (rb as Record<string, unknown>).regexes as Array<Record<string, unknown>>) {
          customRegex.push({
            id: (typeof r.id === 'string' && r.id) || uid(),
            name: typeof r.scriptName === 'string' ? r.scriptName : '',
            enabled: r.disabled !== true,
            find_regex: typeof r.findRegex === 'string' ? r.findRegex : '',
            replace_string: typeof r.replaceString === 'string' ? r.replaceString : '',
          });
        }
      }
    }
  }

  // ── 4. 组装 ──
  return {
    id: uid(),
    name: name || 'ST Preset',
    enabled: true,
    priority: 100,
    timeout_ms: 300000,
    api_preset_id: '',
    generation_options: genOpts,
    behavior_options: {},
    prompt_order: promptOrder,
    prompt_items: [],
    api_url: '',
    api_key: '',
    context_turns: 8,
    extract_rules: [],
    exclude_rules: [],
    use_tavern_regex: false,
    custom_regex_rules: customRegex,
    request_template: '',
    headers_json: '',
  } as unknown as EwFlowConfig;
}
