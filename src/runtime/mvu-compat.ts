// MagVarUpdate source-aligned MVU filtering helpers.
// Keep these rules narrow so we avoid MVU artifacts without harming normal lore/prompt content.

export const MVU_ENTRY_COMMENT_REGEX = /\[(mvu_update|mvu_plot|initvar)\]/i;

const MVU_UPDATE_BLOCK_REGEX = /\n?<(update(?:variable)?|variableupdate)>(?:(?!<\1>).)*<\/\1?>/gis;
const MVU_STATUS_PLACEHOLDER_REGEX = /\n?<StatusPlaceHolderImpl\/>/gi;
const MVU_STATUS_CURRENT_VARIABLE_REPLACE_REGEX =
  /\n?<status_current_variables?>[\s\S]*?<\/status_current_variables?>/gi;
const MVU_STATUS_CURRENT_VARIABLE_DETECT_REGEX = /<status_current_variables?>[\s\S]*?<\/status_current_variables?>/i;
const MVU_VARIABLE_OUTPUT_ENTRY_REGEX = /变量输出格式:\s*[\s\S]*?<UpdateVariable>/i;
const MVU_VARIABLE_RULES_ENTRY_REGEX = /变量更新规则:\s*[\s\S]*?(?:type:\s*|check:\s*|当前时间:|近期事务:)/i;
const MVU_FORMAT_EMPHASIS_ENTRY_REGEX =
  /(?:变量输出格式强调|格式强调[：:]?-?变量更新规则|格式强调[：:]?-?剧情演绎|The following must be inserted to the end of (?:each )?reply,? and cannot be omitted)[\s\S]*?format:\s*\|-?/i;

export function isMvuTaggedWorldInfoComment(comment: string): boolean {
  return MVU_ENTRY_COMMENT_REGEX.test(comment);
}

export function isMvuTaggedWorldInfoNameOrComment(name: string, comment: string): boolean {
  return MVU_ENTRY_COMMENT_REGEX.test(name) || MVU_ENTRY_COMMENT_REGEX.test(comment);
}

export function isLikelyMvuWorldInfoContent(content: string): boolean {
  if (!content) {
    return false;
  }

  const normalized = content.trim();
  if (!normalized) {
    return false;
  }

  return (
    MVU_STATUS_CURRENT_VARIABLE_DETECT_REGEX.test(normalized) ||
    MVU_VARIABLE_OUTPUT_ENTRY_REGEX.test(normalized) ||
    MVU_VARIABLE_RULES_ENTRY_REGEX.test(normalized) ||
    MVU_FORMAT_EMPHASIS_ENTRY_REGEX.test(normalized)
  );
}

export function stripMvuPromptArtifacts(content: string): string {
  if (!content) {
    return '';
  }

  return content
    .replace(MVU_UPDATE_BLOCK_REGEX, '')
    .replace(MVU_STATUS_PLACEHOLDER_REGEX, '')
    .replace(MVU_STATUS_CURRENT_VARIABLE_REPLACE_REGEX, '')
    .trim();
}

export function stripBlockedPromptContents(content: string, blockedContents: string[]): string {
  if (!content || blockedContents.length === 0) {
    return content;
  }

  const normalizedBlocked = _.uniq(
    blockedContents
      .map(item => item.trim())
      .filter(Boolean)
      .sort((lhs, rhs) => rhs.length - lhs.length),
  );

  let sanitized = content;
  for (const blocked of normalizedBlocked) {
    if (!sanitized.includes(blocked)) {
      continue;
    }
    sanitized = sanitized.split(blocked).join('');
  }

  return sanitized.replace(/\n{3,}/g, '\n\n').trim();
}
