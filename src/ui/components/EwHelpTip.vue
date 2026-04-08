<template>
  <div
    ref="rootRef"
    class="ew-help-tip"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
    @focusin="handleFocusIn"
    @focusout="handleFocusOut"
  >
    <button
      type="button"
      class="ew-help-tip__trigger"
      :aria-label="`${props.meta.label}说明`"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="tipId"
      @click.stop="handleTriggerClick"
      @keydown.esc.prevent.stop="close"
    >
      <span aria-hidden="true">?</span>
    </button>

    <div
      v-if="open"
      :id="tipId"
      class="ew-help-tip__bubble"
      role="tooltip"
      @click.stop
      @mouseenter="clearCloseTimer"
      @mouseleave="handleBubbleMouseLeave"
    >
      <p class="ew-help-tip__short">{{ props.meta.shortHelp }}</p>

      <button
        v-if="props.meta.detailHelp && !showDetail"
        type="button"
        class="ew-help-tip__more-link"
        :aria-expanded="showDetail ? 'true' : 'false'"
        :aria-controls="detailId"
        @click.stop="showMoreDetail"
      >
        点击查看更多
      </button>

      <p v-if="showDetail" :id="detailId" class="ew-help-tip__detail">{{ props.meta.detailHelp }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { FieldHelpMeta } from '../help-meta';

let activeTipCloser: (() => void) | null = null;
let tipSequence = 0;

const props = defineProps<{
  meta: FieldHelpMeta;
}>();

const rootRef = ref<HTMLElement | null>(null);
const open = ref(false);
const showDetail = ref(false);
const locked = ref(false);
const tipId = `ew-help-tip-${++tipSequence}`;
const detailId = `${tipId}-detail`;
const touchLike = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function refreshTouchMode() {
  try {
    touchLike.value = !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    touchLike.value = false;
  }
}

function clearCloseTimer() {
  if (!closeTimer) {
    return;
  }
  clearTimeout(closeTimer);
  closeTimer = null;
}

function scheduleCloseIfHover() {
  clearCloseTimer();
  closeTimer = setTimeout(() => {
    closeIfAllowed();
  }, 140);
}

function close() {
  if (!open.value) {
    return;
  }
  clearCloseTimer();
  open.value = false;
  showDetail.value = false;
  locked.value = false;
  if (activeTipCloser === close) {
    activeTipCloser = null;
  }
}

function closeIfAllowed() {
  if (isPersistentOpen()) {
    return;
  }
  close();
}

function isPersistentOpen() {
  return touchLike.value && locked.value;
}

function openTip(mode: 'hover' | 'detail') {
  clearCloseTimer();
  if (activeTipCloser && activeTipCloser !== close) {
    activeTipCloser();
  }
  open.value = true;
  if (mode === 'detail') {
    locked.value = touchLike.value;
    showDetail.value = true;
  } else {
    if (!isPersistentOpen()) {
      showDetail.value = false;
    }
    if (!touchLike.value) {
      locked.value = false;
    }
  }
  activeTipCloser = close;
}

function toggleDetail() {
  if (touchLike.value && open.value && locked.value) {
    close();
    return;
  }
  if (!touchLike.value && open.value && showDetail.value) {
    close();
    return;
  }
  openTip('detail');
}

function showMoreDetail() {
  openTip('detail');
}

function handleMouseEnter() {
  if (touchLike.value) {
    return;
  }
  clearCloseTimer();
  if (!open.value) {
    openTip('hover');
  }
}

function handleMouseLeave() {
  if (touchLike.value) {
    return;
  }
  scheduleCloseIfHover();
}

function handleBubbleMouseLeave() {
  if (touchLike.value) {
    return;
  }
  scheduleCloseIfHover();
}

function handleFocusIn() {
  clearCloseTimer();
  if (!open.value) {
    openTip('hover');
  }
}

function handleFocusOut(event: FocusEvent) {
  const nextTarget = event.relatedTarget as Node | null;
  if (nextTarget && rootRef.value?.contains(nextTarget)) {
    return;
  }
  closeIfAllowed();
}

function handleTriggerClick() {
  toggleDetail();
}

function onPointerDown(event: Event) {
  if (!open.value) {
    return;
  }
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) {
    return;
  }
  close();
}

function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') {
    return;
  }
  close();
}

watch(
  open,
  next => {
    if (next) {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onEscape, true);
      return;
    }
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onEscape, true);
  },
  { immediate: true },
);

onMounted(() => {
  refreshTouchMode();
});

onUnmounted(() => {
  clearCloseTimer();
  close();
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onEscape, true);
});
</script>

<style scoped>
.ew-help-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}

.ew-help-tip__trigger {
  width: 1.3rem;
  height: 1.3rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 56%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 32%, rgba(0, 0, 0, 0.16));
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #f3f6fb) 90%, #ffe0a3);
  font-size: 0.78rem;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow:
    0 4px 10px rgba(0, 0, 0, 0.22),
    0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  transition:
    transform 0.15s ease,
    background 0.2s ease,
    border-color 0.2s ease;
}

.ew-help-tip__trigger:hover,
.ew-help-tip__trigger:focus-visible {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 78%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 52%, rgba(0, 0, 0, 0.2));
  outline: none;
}

.ew-help-tip__bubble {
  position: absolute;
  top: calc(100% + 0.42rem);
  right: 0;
  z-index: 99999;
  width: min(22rem, calc(100vw - 2rem));
  border-radius: 0.9rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 56%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #394a61) 18%, rgba(10, 14, 20, 0.93));
  color: var(--SmartThemeBodyColor, #ecf2f9);
  box-shadow:
    0 16px 38px rgba(0, 0, 0, 0.44),
    0 0 0 1px rgba(255, 255, 255, 0.06) inset;
  backdrop-filter: blur(16px) saturate(125%);
  -webkit-backdrop-filter: blur(16px) saturate(125%);
  padding: 0.65rem 0.72rem;
}

.ew-help-tip__short,
.ew-help-tip__detail {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.45;
  white-space: normal;
}

.ew-help-tip__detail {
  margin-top: 0.45rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ecf2f9) 86%, transparent);
}

.ew-help-tip__more-link {
  margin-top: 0.42rem;
  border: none;
  border-radius: 0;
  background: none;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ecf2f9) 92%, #7db4ff);
  padding: 0;
  font-size: 0.74rem;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  text-align: left;
}

.ew-help-tip__more-link:hover,
.ew-help-tip__more-link:focus-visible {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ecf2f9) 100%, #9dccff);
  outline: none;
}

@supports not ((backdrop-filter: blur(1px))) {
  .ew-help-tip__bubble {
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #394a61) 22%, rgba(10, 14, 20, 0.97));
  }
}

@media (max-width: 900px) {
  .ew-help-tip__bubble {
    right: auto;
    left: 50%;
    transform: translateX(-50%);
    width: min(22rem, calc(100vw - 1.4rem));
  }
}
</style>
