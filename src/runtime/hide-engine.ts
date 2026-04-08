/**
 * hide-engine.ts — Message hiding & floor limiter logic.
 *
 * Two orthogonal features, unified under global settings:
 *
 * 1. **Hide floors** (AI hiding):
 *    Keep the most recent N messages; mark older ones `is_system = true`
 *    so SillyTavern excludes them from the AI context.
 *
 * 2. **Floor limiter** (visual):
 *    Only render the most recent M messages in the chat DOM.
 *    Does NOT affect AI context — purely for UI performance.
 */

import { tryGetSTContext } from '../st-adapter';

// ── Types ─────────────────────────────────────────────────────────────

export interface HideSettings {
  enabled: boolean;
  hide_last_n: number; // 0 = don't hide
  limiter_enabled: boolean;
  limiter_count: number;
}

interface HideState {
  lastProcessedLength: number;
}

// Module-level state
let hideState: HideState = { lastProcessedLength: 0 };
let scheduledHideApplyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tracks message indices that EW itself has hidden.
 * This prevents unhideAll/runFullHideCheck from corrupting
 * messages that were originally is_system=true (e.g. character card intro).
 */
const ewHiddenIndices = new Set<number>();

export function isEwHiddenMessageIndex(index: number): boolean {
  return ewHiddenIndices.has(index);
}

// ── 辅助函数 ───────────────────────────────────────────────────────────

function getChat(): any[] | null {
  try {
    const ctx = tryGetSTContext();
    return ctx?.chat ?? null;
  } catch {
    return null;
  }
}

function syncSystemAttribute(indices: number[], value: 'true' | 'false'): void {
  if (indices.length === 0 || typeof $ === 'undefined') {
    return;
  }
  const sel = indices.map(id => `.mes[mesid="${id}"]`).join(',');
  $(sel).attr('is_system', value);
}

function syncLimiterVisibility(startIdx: number | null): void {
  if (typeof $ === 'undefined') {
    return;
  }

  const $chat = $('#chat');
  if ($chat.length === 0 || $('#chat .edit_textarea').length > 0) {
    return;
  }

  const $messages = $chat.children('.mes');
  $messages.each((_, element) => {
    const $message = $(element);
    const mesId = Number($message.attr('mesid'));
    const shouldShow = startIdx == null || !Number.isFinite(mesId) || mesId >= startIdx;

    if (shouldShow) {
      if ($message.attr('data-ew-limiter-hidden') === 'true') {
        $message.css('display', '');
        $message.removeAttr('data-ew-limiter-hidden');
      }
      return;
    }

    if ($message.attr('data-ew-limiter-hidden') !== 'true') {
      $message.css('display', 'none');
      $message.attr('data-ew-limiter-hidden', 'true');
    }
  });
}

// ── 1. Full hide check ───────────────────────────────────────────────

/**
 * Performs a full sweep across all messages, toggling `is_system` based on
 * the hide_last_n threshold. Also updates the DOM attribute on each message.
 */
export function runFullHideCheck(settings: HideSettings): void {
  if (!settings.enabled) return;

  const chat = getChat();
  if (!chat || chat.length === 0) return;

  const hideLastN = settings.hide_last_n;
  if (hideLastN <= 0) return; // 0 = hide nothing

  const chatLen = chat.length;
  const visibleStart = hideLastN >= chatLen ? 0 : Math.max(0, chatLen - hideLastN);

  const toHide: number[] = [];
  const toShow: number[] = [];
  const desiredHiddenIndices: number[] = [];

  for (let i = 0; i < chatLen; i++) {
    const msg = chat[i];
    if (!msg) continue;

    const isHidden = msg.is_system === true;
    const shouldBeHidden = i < visibleStart;

    if (shouldBeHidden) {
      desiredHiddenIndices.push(i);
    }

    if (shouldBeHidden && !isHidden) {
      msg.is_system = true;
      ewHiddenIndices.add(i);
      toHide.push(i);
    } else if (!shouldBeHidden && isHidden && ewHiddenIndices.has(i)) {
      // Only unhide messages that EW itself hid — skip original system messages
      msg.is_system = false;
      ewHiddenIndices.delete(i);
      toShow.push(i);
    }
  }

  syncSystemAttribute(desiredHiddenIndices, 'true');
  syncSystemAttribute(toShow, 'false');

  hideState.lastProcessedLength = chatLen;

  if (toHide.length > 0 || toShow.length > 0) {
    console.log(`[EW Hide] Full check: hid ${toHide.length}, showed ${toShow.length} messages`);
  }
}

// ── 2. Incremental hide check ────────────────────────────────────────

/**
 * Optimised path: only hides the messages that newly fell out of the
 * visible window since the last check. Called after each AI generation.
 */
export function runIncrementalHideCheck(settings: HideSettings): void {
  if (!settings.enabled) return;

  const chat = getChat();
  if (!chat || chat.length === 0) return;

  const hideLastN = settings.hide_last_n;
  if (hideLastN <= 0) return;

  const chatLen = chat.length;
  const prevLen = hideState.lastProcessedLength;

  // If chat shrunk (deletion), fall back to full check
  if (chatLen <= prevLen) {
    hideState.lastProcessedLength = chatLen;
    if (chatLen < prevLen) runFullHideCheck(settings);
    return;
  }

  const targetVisibleStart = Math.max(0, chatLen - hideLastN);
  const prevVisibleStart = prevLen > 0 ? Math.max(0, prevLen - hideLastN) : 0;

  if (targetVisibleStart > prevVisibleStart) {
    const indices: number[] = [];
    for (let i = prevVisibleStart; i < targetVisibleStart; i++) {
      if (chat[i] && chat[i].is_system !== true) {
        chat[i].is_system = true;
        ewHiddenIndices.add(i);
        indices.push(i);
      }
    }
    if (indices.length > 0 && typeof $ !== 'undefined') {
      const sel = indices.map(id => `.mes[mesid="${id}"]`).join(',');
      $(sel).attr('is_system', 'true');
      console.log(`[EW Hide] Incremental: hid ${indices.length} messages`);
    }
  }

  hideState.lastProcessedLength = chatLen;
}

export function applyHideSettings(settings: HideSettings): void {
  const normalized: HideSettings = {
    enabled: Boolean(settings.enabled),
    hide_last_n: Math.max(0, Math.trunc(Number(settings.hide_last_n ?? 0) || 0)),
    limiter_enabled: Boolean(settings.limiter_enabled),
    limiter_count: Math.max(1, Math.trunc(Number(settings.limiter_count ?? 1) || 1)),
  };

  if (!normalized.enabled || normalized.hide_last_n <= 0) {
    unhideAll();
  } else {
    runFullHideCheck(normalized);
  }

  applyFloorLimit(normalized);
}

export function scheduleHideSettingsApply(settings: HideSettings, delayMs = 120): void {
  const snapshot: HideSettings = {
    enabled: Boolean(settings.enabled),
    hide_last_n: Math.max(0, Math.trunc(Number(settings.hide_last_n ?? 0) || 0)),
    limiter_enabled: Boolean(settings.limiter_enabled),
    limiter_count: Math.max(1, Math.trunc(Number(settings.limiter_count ?? 1) || 1)),
  };

  if (scheduledHideApplyTimer) {
    clearTimeout(scheduledHideApplyTimer);
  }

  scheduledHideApplyTimer = setTimeout(
    () => {
      scheduledHideApplyTimer = null;
      applyHideSettings(snapshot);
    },
    Math.max(0, delayMs),
  );
}

/**
 * Removes hidden status only from messages that EW itself has hidden.
 * Original system messages (is_system=true before EW ran) are left untouched.
 */
export function unhideAll(): void {
  const chat = getChat();
  if (!chat) return;

  const toShow: number[] = [];
  for (const idx of ewHiddenIndices) {
    if (chat[idx] && chat[idx].is_system === true) {
      chat[idx].is_system = false;
      toShow.push(idx);
    }
  }
  ewHiddenIndices.clear();

  if (toShow.length > 0 && typeof $ !== 'undefined') {
    const sel = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
    $(sel).attr('is_system', 'false');
  }

  hideState.lastProcessedLength = chat.length;
  console.log(`[EW Hide] Unhid ${toShow.length} messages (EW-managed only)`);
}

// ── 4. Floor limiter ─────────────────────────────────────────────────

/**
 * Visually limits the chat window to show only the last `limit` messages.
 * Does NOT affect `is_system` — messages are still sent to AI.
 */
export function applyFloorLimit(settings: HideSettings): void {
  if (!settings.limiter_enabled) {
    // If was active, restore
    if (typeof $ !== 'undefined' && $('#chat').attr('data-limiter-active')) {
      syncLimiterVisibility(null);
      $('#chat').removeAttr('data-limiter-active');
    }
    return;
  }

  const limit = settings.limiter_count;
  if (limit <= 0) return;

  const chat = getChat();
  if (!chat) return;

  const startIdx = Math.max(0, chat.length - limit);
  syncLimiterVisibility(startIdx);
  $('#chat').attr('data-limiter-active', 'true');
  console.log(`[EW Hide] Limiter: displaying ${chat.length - startIdx}/${chat.length} messages`);
}

// ── 5. Reset state ───────────────────────────────────────────────────

export function resetHideState(): void {
  if (scheduledHideApplyTimer) {
    clearTimeout(scheduledHideApplyTimer);
    scheduledHideApplyTimer = null;
  }
  hideState = { lastProcessedLength: 0 };
  ewHiddenIndices.clear();
}
