export type DebugHighlightSegment = {
  text: string;
  highlighted: boolean;
};

const DEBUG_HIGHLIGHT_PATTERN = /\[[^\]]*(?:EW|Controller|Dyn)[^\]]*\]/g;

export function buildDebugHighlightSegments(text: string): DebugHighlightSegment[] {
  const source = String(text ?? '');
  if (!source) {
    return [];
  }

  const segments: DebugHighlightSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  DEBUG_HIGHLIGHT_PATTERN.lastIndex = 0;

  while ((match = DEBUG_HIGHLIGHT_PATTERN.exec(source))) {
    if (match.index > cursor) {
      segments.push({
        text: source.slice(cursor, match.index),
        highlighted: false,
      });
    }

    segments.push({
      text: match[0],
      highlighted: true,
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < source.length) {
    segments.push({
      text: source.slice(cursor),
      highlighted: false,
    });
  }

  return segments.length > 0
    ? segments
    : [
        {
          text: source,
          highlighted: false,
        },
      ];
}
