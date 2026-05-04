/**
 * Vue UI 挂载逻辑 + FAB 悬浮球 + 魔法棒菜单
 *
 * ST 扩展版本：直接运行在 ST 主页面，无需 iframe。
 * - FAB（悬浮球）注入到 document.documentElement
 * - 魔法棒菜单项注入到 #extensionsMenu
 * - Vue App 挂载到 body（浮动面板）
 */

import { createApp, type App as VueApp } from 'vue';
import { createPinia } from 'pinia';
import { getCurrentChatIdSafe } from '../st-adapter';
import { getLastRun, getSettings, patchSettings, subscribeLastRun } from '../runtime/settings';
import type { RunSummary } from '../runtime/types';
import { getFabVisibilityEventName } from './fab-bridge';
import { showEwNotice } from './notice';
import AppComponent from './App.vue';

// ── 常量 ──────────────────────────────────────────────
const MENU_ITEM_NAME = 'Evolution 世界助手';
const MENU_CONTAINER_ID = 'evolution-world-assistant-menu-container';
const MENU_ITEM_ID = 'evolution-world-assistant-menu-item';
const MENU_EVENT_NS = '.evolution_world_assistant';
const MENU_RETRY_MS = 1500;

const FAB_ID = 'ew-assistant-fab';
const FAB_STYLE_ID = 'ew-assistant-fab-style';
const FAB_POS_KEY = '__EW_FAB_POS__';
const FAB_SIZE = 48;
const FAB_CLICK_DELAY_MS = 220;

// ── 模块状态 ──────────────────────────────────────────
let app: VueApp | null = null;
let $root: JQuery<HTMLDivElement> | null = null;
let menuRetryTimer: ReturnType<typeof setTimeout> | null = null;
let fabViewportSyncScrollHandler: (() => void) | null = null;
let fabViewportSyncResizeHandler: (() => void) | null = null;
let fabViewportSyncRaf: number | null = null;
let fabVisibilityBridgeHandler: ((event: Event) => void) | null = null;
let stopRunListener: (() => void) | null = null;
// 用 baselineRequestId 跳过启动时已存在的 lastRun，避免每次刷新都弹一次旧通知
let runNotifyBaselineRequestId = '';

// ── 工具函数 ──────────────────────────────────────────

function shouldShowFab(): boolean {
  try {
    const s = getSettings();
    return s.show_fab !== false;
  } catch {
    return true;
  }
}

// ═══════════════════════════════════════════════════════
// ── 魔法棒菜单 ──
// ═══════════════════════════════════════════════════════

function clearMenuRetryTimer() {
  if (!menuRetryTimer) return;
  clearTimeout(menuRetryTimer);
  menuRetryTimer = null;
}

function scheduleMenuRetry() {
  if (menuRetryTimer) return;
  menuRetryTimer = setTimeout(() => {
    menuRetryTimer = null;
    installMagicWandMenuItem();
  }, MENU_RETRY_MS);
}

async function onMenuItemClick($extensionsMenu: JQuery<HTMLElement>) {
  const $menuButton = $('#extensionsMenuButton');
  if ($menuButton.length && $extensionsMenu.is(':visible')) {
    $menuButton.trigger('click');
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  patchSettings({ ui_open: true });
}

function installMagicWandMenuItem() {
  const $extensionsMenu = $('#extensionsMenu');
  if (!$extensionsMenu.length) {
    scheduleMenuRetry();
    return;
  }

  clearMenuRetryTimer();

  let $menuContainer = $(`#${MENU_CONTAINER_ID}`, $extensionsMenu);
  if (!$menuContainer.length) {
    $menuContainer = $(`<div class="extension_container interactable" id="${MENU_CONTAINER_ID}" tabindex="0"></div>`);
    $extensionsMenu.append($menuContainer);
  }

  let $menuItem = $(`#${MENU_ITEM_ID}`, $menuContainer);
  if (!$menuItem.length) {
    $menuItem = $(
      `<div class="list-group-item flex-container flexGap5 interactable" id="${MENU_ITEM_ID}" title="打开 Evolution World Assistant"><div class="fa-fw fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>${MENU_ITEM_NAME}</span></div>`,
    );
    $menuContainer.append($menuItem);
  }

  $menuItem.off(`click${MENU_EVENT_NS}`).on(`click${MENU_EVENT_NS}`, event => {
    event.stopPropagation();
    void onMenuItemClick($extensionsMenu);
  });
}

function uninstallMagicWandMenuItem() {
  clearMenuRetryTimer();
  const $menuContainer = $(`#${MENU_CONTAINER_ID}`);
  $menuContainer.find(`#${MENU_ITEM_ID}`).off(`click${MENU_EVENT_NS}`);
  $menuContainer.remove();
}

// ═══════════════════════════════════════════════════════
// ── 悬浮球（FAB） ──
// ═══════════════════════════════════════════════════════

function detachFabViewportSync(): void {
  if (fabViewportSyncScrollHandler) {
    window.removeEventListener('scroll', fabViewportSyncScrollHandler);
    fabViewportSyncScrollHandler = null;
  }
  if (fabViewportSyncResizeHandler) {
    window.removeEventListener('resize', fabViewportSyncResizeHandler);
    fabViewportSyncResizeHandler = null;
  }
  if (fabViewportSyncRaf !== null) {
    cancelAnimationFrame(fabViewportSyncRaf);
    fabViewportSyncRaf = null;
  }
}

function ensureFabStyle(): void {
  if (document.getElementById(FAB_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FAB_STYLE_ID;
  style.textContent = `
#${FAB_ID} {
  position: fixed;
  z-index: 4999;
  width: ${FAB_SIZE}px;
  height: ${FAB_SIZE}px;
  border-radius: 50%;
  border: 1px solid rgba(139, 92, 246, 0.45);
  background: linear-gradient(135deg, rgba(20, 24, 38, 0.85), rgba(30, 18, 50, 0.82));
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  box-shadow:
    0 4px 24px rgba(139, 92, 246, 0.3),
    0 0 0 1px rgba(255, 255, 255, 0.06) inset,
    inset 0 1px 1px rgba(255, 255, 255, 0.1);
  cursor: grab;
  display: grid;
  place-items: center;
  font-size: 1.4rem;
  line-height: 1;
  touch-action: none;
  user-select: none;
  outline: none;
  transition: box-shadow 0.3s ease, border-color 0.3s ease, opacity 0.4s ease, transform 0.4s ease;
  -webkit-tap-highlight-color: transparent;
}
#${FAB_ID}::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid rgba(139, 92, 246, 0.35);
  animation: ew-fab-ring-pulse 2.5s ease-in-out infinite;
  pointer-events: none;
}
#${FAB_ID}:hover {
  border-color: rgba(167, 139, 250, 0.7);
  box-shadow:
    0 6px 32px rgba(139, 92, 246, 0.45),
    0 0 0 1px rgba(255, 255, 255, 0.1) inset,
    inset 0 1px 1px rgba(255, 255, 255, 0.15);
}
#${FAB_ID}.dragging {
  cursor: grabbing;
  transition: none;
  animation: none;
}
#${FAB_ID}.leaving {
  animation: ew-fab-pop-out 0.25s ease forwards;
  pointer-events: none;
}
@keyframes ew-fab-pop-in {
  0% { opacity: 0; transform: scale(0.3); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes ew-fab-pop-out {
  0% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.3); }
}
@keyframes ew-fab-ring-pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 0.8; transform: scale(1.08); }
}
#${FAB_ID}[data-run-state="success"] {
  border-color: rgba(101, 211, 156, 0.65);
  box-shadow:
    0 4px 24px rgba(101, 211, 156, 0.32),
    0 0 0 1px rgba(255, 255, 255, 0.06) inset,
    inset 0 1px 1px rgba(255, 255, 255, 0.1);
}
#${FAB_ID}[data-run-state="success"]::after {
  border-color: rgba(101, 211, 156, 0.4);
}
#${FAB_ID}[data-run-state="warning"] {
  border-color: rgba(234, 185, 111, 0.65);
  box-shadow:
    0 4px 24px rgba(234, 185, 111, 0.32),
    0 0 0 1px rgba(255, 255, 255, 0.06) inset,
    inset 0 1px 1px rgba(255, 255, 255, 0.1);
}
#${FAB_ID}[data-run-state="warning"]::after {
  border-color: rgba(234, 185, 111, 0.4);
}
#${FAB_ID}[data-run-state="error"] {
  border-color: rgba(245, 123, 143, 0.65);
  box-shadow:
    0 4px 24px rgba(245, 123, 143, 0.32),
    0 0 0 1px rgba(255, 255, 255, 0.06) inset,
    inset 0 1px 1px rgba(255, 255, 255, 0.1);
}
#${FAB_ID}[data-run-state="error"]::after {
  border-color: rgba(245, 123, 143, 0.4);
}
`;
  (document.head ?? document.documentElement).appendChild(style);
}

function createFab(): void {
  if (document.getElementById(FAB_ID)) return;
  if (!shouldShowFab()) return;

  ensureFabStyle();

  const isMobile = window.matchMedia?.('(max-width: 1000px)').matches ?? window.innerWidth <= 1000;
  detachFabViewportSync();

  const fab = document.createElement('div');
  fab.id = FAB_ID;
  fab.textContent = '🌕';
  fab.title = 'Evolution World';
  fab.setAttribute('tabindex', '-1');
  fab.setAttribute('inputmode', 'none');

  if (isMobile) {
    fab.style.position = 'absolute';
  }

  // 恢复已保存的位置，否则右下角
  let vpX: number | null = null;
  let vpY: number | null = null;

  try {
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      vpX = Math.min(saved.x, window.innerWidth - FAB_SIZE);
      vpY = Math.min(saved.y, window.innerHeight - FAB_SIZE);
    }
  } catch { /* ignore */ }

  if (vpX !== null && vpY !== null) {
    if (isMobile) {
      fab.style.left = vpX + window.scrollX + 'px';
      fab.style.top = vpY + window.scrollY + 'px';
    } else {
      fab.style.left = vpX + 'px';
      fab.style.top = vpY + 'px';
    }
  } else {
    vpX = window.innerWidth - 16 - FAB_SIZE;
    vpY = window.innerHeight - 80 - FAB_SIZE;
    if (isMobile) {
      fab.style.left = vpX + window.scrollX + 'px';
      fab.style.top = vpY + window.scrollY + 'px';
    } else {
      fab.style.right = '16px';
      fab.style.bottom = '80px';
    }
  }

  if (isMobile) {
    const syncPosition = () => {
      fabViewportSyncRaf = null;
      if (!document.getElementById(FAB_ID)) return;
      const currentVpX = vpX ?? window.innerWidth - 16 - FAB_SIZE;
      const currentVpY = vpY ?? window.innerHeight - 80 - FAB_SIZE;
      fab.style.left = currentVpX + window.scrollX + 'px';
      fab.style.top = currentVpY + window.scrollY + 'px';
    };
    fabViewportSyncScrollHandler = () => {
      if (fabViewportSyncRaf === null) {
        fabViewportSyncRaf = requestAnimationFrame(syncPosition);
      }
    };
    fabViewportSyncResizeHandler = () => {
      if (fabViewportSyncRaf === null) {
        fabViewportSyncRaf = requestAnimationFrame(syncPosition);
      }
    };
    window.addEventListener('scroll', fabViewportSyncScrollHandler, { passive: true });
    window.addEventListener('resize', fabViewportSyncResizeHandler, { passive: true });
  }

  // ── 拖拽支持 ──
  let dragging = false;
  let dragMoved = false;
  let startX = 0;
  let startY = 0;
  let fabStartX = 0;
  let fabStartY = 0;
  let clickTimer: number | null = null;

  async function triggerFabReroll(): Promise<void> {
    const settings = getSettings();
    if (settings.workflow_timing !== 'after_reply') {
      patchSettings({ ui_open: true });
      return;
    }

    const api = (window as any).EvolutionWorldAPI;
    if (!api?.rerollCurrentAfterReply) {
      showEwNotice({
        title: 'Evolution World',
        message: '运行时尚未就绪，暂时无法重跑当前楼。',
        level: 'warning',
      });
      return;
    }

    const result = await api.rerollCurrentAfterReply();
    if (!result.ok) {
      showEwNotice({
        title: 'Evolution World',
        message: `重跑当前楼失败: ${result.reason ?? 'unknown error'}`,
        level: 'warning',
      });
    }
  }

  function clearFabClickTimer() {
    if (clickTimer !== null) {
      window.clearTimeout(clickTimer);
      clickTimer = null;
    }
  }

  fab.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    fabStartX = rect.left;
    fabStartY = rect.top;
    fab.classList.add('dragging');
    fab.setPointerCapture(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });

  fab.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    const maxX = window.innerWidth - FAB_SIZE;
    const maxY = window.innerHeight - FAB_SIZE;
    const nx = Math.max(0, Math.min(maxX, fabStartX + dx));
    const ny = Math.max(0, Math.min(maxY, fabStartY + dy));
    vpX = nx;
    vpY = ny;
    if (isMobile) {
      fab.style.left = nx + window.scrollX + 'px';
      fab.style.top = ny + window.scrollY + 'px';
    } else {
      fab.style.left = nx + 'px';
      fab.style.top = ny + 'px';
    }
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  });

  fab.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove('dragging');
    try {
      if (vpX !== null && vpY !== null) {
        localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: vpX, y: vpY }));
      }
    } catch { /* ignore */ }
  });

  fab.addEventListener('click', (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (dragMoved) {
      dragMoved = false;
      return;
    }

    if (isMobile && clickTimer !== null) {
      clearFabClickTimer();
      void triggerFabReroll();
      return;
    }

    clearFabClickTimer();
    clickTimer = window.setTimeout(() => {
      clickTimer = null;
      patchSettings({ ui_open: true });
    }, FAB_CLICK_DELAY_MS);
  });

  fab.addEventListener('dblclick', async (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (dragMoved) {
      dragMoved = false;
      return;
    }

    clearFabClickTimer();
    await triggerFabReroll();
  });

  // 追加到 <html> 以覆盖所有带 transform 的容器
  document.documentElement.appendChild(fab);

  requestAnimationFrame(() => {
    fab.style.animation = 'ew-fab-pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both';
  });
}

function removeFab(): void {
  detachFabViewportSync();
  const fab = document.getElementById(FAB_ID);
  if (fab) fab.remove();
  document.getElementById(FAB_STYLE_ID)?.remove();
}

export function setFabVisibility(visible: boolean): void {
  if (visible) {
    createFab();
  } else {
    removeFab();
  }
}

function installFabVisibilityBridge(): void {
  if (fabVisibilityBridgeHandler) {
    return;
  }

  fabVisibilityBridgeHandler = (event: Event) => {
    const customEvent = event as CustomEvent<{ visible?: boolean }>;
    setFabVisibility(Boolean(customEvent.detail?.visible));
  };

  window.addEventListener(
    getFabVisibilityEventName(),
    fabVisibilityBridgeHandler as EventListener,
  );
}

function uninstallFabVisibilityBridge(): void {
  if (!fabVisibilityBridgeHandler) {
    return;
  }

  window.removeEventListener(
    getFabVisibilityEventName(),
    fabVisibilityBridgeHandler as EventListener,
  );
  fabVisibilityBridgeHandler = null;
}

// ═══════════════════════════════════════════════════════
// ── 运行结果反馈：浮动球状态色 + 完成时 toast ──
// ═══════════════════════════════════════════════════════

type RunOutcome = 'success' | 'warning' | 'error';

function classifyRunOutcome(summary: RunSummary): RunOutcome {
  if (!summary.ok) {
    return 'error';
  }
  // 命中目标但没有实际写回（空操作 / 仅 Controller 变化无 Dyn 更新等）→ warning
  if (summary.warning) {
    return 'warning';
  }
  const commit = summary.commit;
  if (commit && commit.effective_change_count === 0 && !summary.reason?.trim()) {
    return 'warning';
  }
  return 'success';
}

function updateFabRunState(outcome: RunOutcome): void {
  const fab = document.getElementById(FAB_ID);
  if (!fab) {
    return;
  }
  fab.dataset.runState = outcome;
}

function buildOutcomeNotice(summary: RunSummary, outcome: RunOutcome) {
  const elapsedSec = Math.max(0, Math.round(((summary.elapsed_ms ?? 0) / 1000) * 10) / 10);
  const flowCount = Math.max(0, Math.trunc(Number(summary.flow_count ?? 0) || 0));
  const commit = summary.commit;
  const dynChange = commit
    ? commit.dyn_entries_created + commit.dyn_entries_updated + commit.dyn_entries_removed
    : 0;
  const ctrlChange = commit?.controller_entries_updated ?? 0;

  if (outcome === 'success') {
    const detailBits: string[] = [];
    if (dynChange > 0) {
      detailBits.push(`动态条目变化 ${dynChange}`);
    }
    if (ctrlChange > 0) {
      detailBits.push(`控制器更新 ${ctrlChange}`);
    }
    detailBits.push(`耗时 ${elapsedSec}s`);
    return {
      title: 'Evolution World',
      message: `工作流已更新（${flowCount} 条）。${detailBits.join('，')}`,
      level: 'success' as const,
      duration_ms: 3500,
    };
  }

  if (outcome === 'warning') {
    const reason = summary.warning?.summary?.trim()
      || (commit && commit.effective_change_count === 0 ? '本轮命中工作流但没有实际写回，可重 roll 试试' : '本轮工作流以空操作完成');
    return {
      title: 'Evolution World',
      message: `${reason}。耗时 ${elapsedSec}s`,
      level: 'warning' as const,
      duration_ms: 5000,
    };
  }

  const failReason = summary.failure?.summary?.trim() || summary.reason?.trim() || '工作流执行失败';
  return {
    title: 'Evolution World',
    message: `${failReason}。耗时 ${elapsedSec}s`,
    level: 'error' as const,
    duration_ms: 6000,
  };
}

function notifyRunOutcome(summary: RunSummary | null) {
  if (!summary) {
    return;
  }

  // 跳过 baseline（启动时已存在的旧 run，刷新页面也不应再弹一次）
  const requestId = String(summary.request_id ?? '').trim();
  if (!requestId || requestId === runNotifyBaselineRequestId) {
    return;
  }
  runNotifyBaselineRequestId = requestId;

  // 只对当前聊天的 run 反馈
  const currentChat = getCurrentChatIdSafe();
  if (currentChat && currentChat !== 'unknown' && summary.chat_id?.trim() && summary.chat_id.trim() !== currentChat) {
    return;
  }

  const outcome = classifyRunOutcome(summary);
  updateFabRunState(outcome);
  showEwNotice(buildOutcomeNotice(summary, outcome));
}

// ═══════════════════════════════════════════════════════
// ── 主 UI 挂载 ──
// ═══════════════════════════════════════════════════════

/**
 * 挂载完整的 Vue 应用 + FAB + 魔法棒菜单。
 *
 * ST 扩展版本：
 * - Vue App 挂载到 body 上的一个 div（浮动面板，由 App.vue 的 v-if 控制显隐）
 * - FAB 注入到 document.documentElement
 * - 魔法棒菜单项注入到 #extensionsMenu
 */
export function mountUI(): void {
  if (app) return;

  // 1. 挂载 Vue 应用到 body
  const pinia = createPinia();
  app = createApp(AppComponent);
  app.use(pinia);

  $root = $('<div id="ew-extension-root"></div>').appendTo('body') as JQuery<HTMLDivElement>;
  app.mount($root[0]);

  // 2. 安装魔法棒菜单
  try {
    installMagicWandMenuItem();
  } catch (error) {
    console.error('[Evolution World] magic-wand menu setup failed:', error);
    toastr.error(`魔法棒菜单挂载失败: ${error instanceof Error ? error.message : String(error)}`, 'Evolution World');
  }

  // 3. 创建/管理 FAB
  installFabVisibilityBridge();
  const settings = getSettings();
  if (settings.show_fab === false) {
    removeFab();
  } else {
    setFabVisibility(true);
  }

  // 4. 订阅运行结果，让浮动球状态色 + 完成时 toast 跟着最新 lastRun 走
  const initialRun = getLastRun();
  runNotifyBaselineRequestId = String(initialRun?.request_id ?? '').trim();
  if (initialRun) {
    updateFabRunState(classifyRunOutcome(initialRun));
  }
  stopRunListener?.();
  stopRunListener = subscribeLastRun(next => {
    notifyRunOutcome(next);
  }).stop;

  console.info('[Evolution World] Vue UI + FAB + Wand 已挂载');
}

/**
 * 卸载 Vue 应用 + FAB + 魔法棒。
 */
export function unmountUI(): void {
  uninstallMagicWandMenuItem();
  uninstallFabVisibilityBridge();
  removeFab();
  stopRunListener?.();
  stopRunListener = null;
  runNotifyBaselineRequestId = '';

  app?.unmount();
  app = null;
  $root?.remove();
  $root = null;

  console.info('[Evolution World] Vue UI + FAB + Wand 已卸载');
}
