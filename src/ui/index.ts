import { createScriptIdDiv, teleportStyle } from '../util/script';
import { getSettings, patchSettings } from '../runtime/settings';
import App from './App.vue';
import { showEwNotice } from './notice';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

// 提前判断悬浮球是否可见 —— 如果设置尚未加载，默认为 true
function shouldShowFab(): boolean {
  try {
    const s = getSettings();
    return s.show_fab !== false;
  } catch {
    // 设置未就绪（运行时全局变量尚未加载），默认显示
    return true;
  }
}

let app: ReturnType<typeof createApp> | null = null;
let destroyStyle: (() => void) | null = null;
let $root: JQuery<HTMLDivElement> | null = null;
let menuRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
let fabViewportSyncScrollHandler: (() => void) | null = null;
let fabViewportSyncResizeHandler: (() => void) | null = null;
let fabViewportSyncRaf: number | null = null;

function resolveParentDocument(): Document {
  return getHostWindow().document;
}

function getHostWindow(): Window {
  try {
    return window.parent && window.parent !== window ? window.parent : window;
  } catch {
    return window;
  }
}

function detachFabViewportSync(): void {
  const hostWin = getHostWindow();
  if (fabViewportSyncScrollHandler) {
    hostWin.removeEventListener('scroll', fabViewportSyncScrollHandler);
    fabViewportSyncScrollHandler = null;
  }
  if (fabViewportSyncResizeHandler) {
    hostWin.removeEventListener('resize', fabViewportSyncResizeHandler);
    fabViewportSyncResizeHandler = null;
  }
  if (fabViewportSyncRaf !== null) {
    cancelAnimationFrame(fabViewportSyncRaf);
    fabViewportSyncRaf = null;
  }
}

function clearMenuRetryTimer() {
  if (!menuRetryTimer) {
    return;
  }
  clearTimeout(menuRetryTimer);
  menuRetryTimer = null;
}

function scheduleMenuRetry() {
  if (menuRetryTimer) {
    return;
  }

  menuRetryTimer = setTimeout(() => {
    menuRetryTimer = null;
    installMagicWandMenuItem();
  }, MENU_RETRY_MS);
}

async function onMenuItemClick(parentDoc: Document, $extensionsMenu: JQuery<HTMLElement>) {
  const $menuButton = $('#extensionsMenuButton', parentDoc);
  if ($menuButton.length && $extensionsMenu.is(':visible')) {
    $menuButton.trigger('click');
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  patchSettings({ ui_open: true });
}

function installMagicWandMenuItem() {
  const parentDoc = resolveParentDocument();
  const $extensionsMenu = $('#extensionsMenu', parentDoc);
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
    void onMenuItemClick(parentDoc, $extensionsMenu);
  });
}

function uninstallMagicWandMenuItem() {
  clearMenuRetryTimer();
  const parentDoc = resolveParentDocument();
  const $menuContainer = $(`#${MENU_CONTAINER_ID}`, parentDoc);
  $menuContainer.find(`#${MENU_ITEM_ID}`).off(`click${MENU_EVENT_NS}`);
  $menuContainer.remove();
}

// ═══════════════════════════════════════════════════════════════
// ── 悬浮球（Floating Access Button）—— 原生 DOM，非 Vue ──
// ═══════════════════════════════════════════════════════════════

function ensureFabStyle(): void {
  const doc = resolveParentDocument();
  if (doc.getElementById(FAB_STYLE_ID)) return;
  const style = doc.createElement('style');
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
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function createFab(): void {
  const doc = resolveParentDocument();
  if (doc.getElementById(FAB_ID)) return;

  if (!shouldShowFab()) return;

  ensureFabStyle();

  const hostWin = getHostWindow();
  const isMobile = hostWin.matchMedia?.('(max-width: 1000px)').matches ?? hostWin.innerWidth <= 1000;
  detachFabViewportSync();

  const fab = doc.createElement('div');
  fab.id = FAB_ID;
  fab.textContent = '🌕';
  fab.title = 'Evolution World';
  fab.setAttribute('tabindex', '-1');
  fab.setAttribute('inputmode', 'none');

  if (isMobile) {
    fab.style.position = 'absolute';
  }

  // 恢复已保存的位置，否则默认右下角
  let vpX: number | null = null;
  let vpY: number | null = null;

  try {
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      vpX = Math.min(saved.x, hostWin.innerWidth - FAB_SIZE);
      vpY = Math.min(saved.y, hostWin.innerHeight - FAB_SIZE);
    }
  } catch {
    /* ignore */
  }

  if (vpX !== null && vpY !== null) {
    if (isMobile) {
      fab.style.left = vpX + hostWin.scrollX + 'px';
      fab.style.top = vpY + hostWin.scrollY + 'px';
    } else {
      fab.style.left = vpX + 'px';
      fab.style.top = vpY + 'px';
    }
  } else {
    vpX = hostWin.innerWidth - 16 - FAB_SIZE;
    vpY = hostWin.innerHeight - 80 - FAB_SIZE;
    if (isMobile) {
      fab.style.left = vpX + hostWin.scrollX + 'px';
      fab.style.top = vpY + hostWin.scrollY + 'px';
    } else {
      fab.style.right = '16px';
      fab.style.bottom = '80px';
    }
  }

  if (isMobile) {
    const syncPosition = () => {
      fabViewportSyncRaf = null;
      if (!doc.getElementById(FAB_ID)) {
        return;
      }
      const currentVpX = vpX ?? hostWin.innerWidth - 16 - FAB_SIZE;
      const currentVpY = vpY ?? hostWin.innerHeight - 80 - FAB_SIZE;
      fab.style.left = currentVpX + hostWin.scrollX + 'px';
      fab.style.top = currentVpY + hostWin.scrollY + 'px';
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
    hostWin.addEventListener('scroll', fabViewportSyncScrollHandler, { passive: true });
    hostWin.addEventListener('resize', fabViewportSyncResizeHandler, { passive: true });
  }

  // ── 拖拽支持（匹配 ST-Manager-STscript 的模式） ──
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

    const api = window.EvolutionWorldAPI;
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
        message: `重roll执行失败: ${result.reason ?? 'unknown error'}`,
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
    const maxX = hostWin.innerWidth - FAB_SIZE;
    const maxY = hostWin.innerHeight - FAB_SIZE;
    const nx = Math.max(0, Math.min(maxX, fabStartX + dx));
    const ny = Math.max(0, Math.min(maxY, fabStartY + dy));
    vpX = nx;
    vpY = ny;
    if (isMobile) {
      fab.style.left = nx + hostWin.scrollX + 'px';
      fab.style.top = ny + hostWin.scrollY + 'px';
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
    } catch {
      /* ignore */
    }
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
  doc.documentElement.appendChild(fab);

  // 通过 JS 触发弹入动画，避免 fill-mode: both 在首次加载时
  // CSS 动画未触发导致元素不可见
  requestAnimationFrame(() => {
    fab.style.animation = 'ew-fab-pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both';
  });
}

function removeFab(): void {
  const doc = resolveParentDocument();
  detachFabViewportSync();
  const fab = doc.getElementById(FAB_ID);
  if (fab) fab.remove();
  doc.getElementById(FAB_STYLE_ID)?.remove();
}

/**
 * 直接设置悬浮球可见性 —— 匹配 ST-Manager 的做法。
 * 不派发事件，不读取运行时缓存，直接操作 DOM。
 */
export function setFabVisibility(visible: boolean): void {
  const doc = resolveParentDocument();
  const fab = doc.getElementById(FAB_ID);
  if (visible) {
    if (!fab) createFab();
  } else if (fab) {
    fab.remove();
  }
}

/**
 * 提前创建悬浮球 —— 在 $() 中同步调用，先于异步 bootstrap。
 * 不依赖运行时全局变量（getScriptId / getVariables 等）。
 */
export function mountFabEarly(): void {
  try {
    createFab();
  } catch (error) {
    console.error('[Evolution World] early FAB setup failed:', error);
  }
}

export function mountUi() {
  if (app) {
    return;
  }

  app = createApp(App).use(createPinia());
  $root = createScriptIdDiv().appendTo('body');
  if (!$root?.[0]) {
    throw new Error('failed to create Evolution World root container');
  }
  app.mount($root[0]);

  const style = teleportStyle();
  destroyStyle = style.destroy;

  try {
    installMagicWandMenuItem();
  } catch (error) {
    console.error('[Evolution World] magic-wand menu setup failed:', error);
    toastr.error(`魔法棒菜单挂载失败: ${error instanceof Error ? error.message : String(error)}`, 'Evolution World');
  }

  // 移动端上 early mount 可能因为宿主文档尚未就绪而失败，这里做一次兜底补建。
  const settings = getSettings();
  if (settings.show_fab === false) {
    removeFab();
  } else {
    setFabVisibility(true);
  }
}

export function unmountUi() {
  uninstallMagicWandMenuItem();
  removeFab();

  app?.unmount();
  app = null;
  $root?.remove();
  $root = null;
  destroyStyle?.();
  destroyStyle = null;
}
