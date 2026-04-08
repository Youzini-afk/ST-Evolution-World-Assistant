/**
 * Compat: 工具函数
 *
 * 替代旧的 substitudeMacros / getTavernHelperVersion / checkMinimumVersion。
 */
import { getSTContext } from '../../st-adapter';

/**
 * 宏替换。
 * 替代旧 `substitudeMacros(text)` (注意原项目拼写错误)。
 * 使用 ST 的 `substituteParams`。
 */
export function substituteParams(text: string): string {
  const ctx = getSTContext() as any;
  if (typeof ctx.substituteParams === 'function') {
    return ctx.substituteParams(text);
  }
  // 降级:基本替换
  return text
    .replace(/\{\{user\}\}/gi, ctx.name1 ?? '')
    .replace(/\{\{char\}\}/gi, ctx.name2 ?? '');
}

/**
 * checkMinimumVersion — 已废弃。
 * TavernHelper 不存在于 ST 扩展中,此函数为空操作。
 */
export function checkMinimumVersion(_expected: string, _title: string): void {
  // No-op: TavernHelper 版本检查不适用于 ST 扩展。
}
