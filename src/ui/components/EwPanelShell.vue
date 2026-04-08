<template>
  <div class="ew-overlay">
    <section class="ew-panel" :data-busy="busy ? '1' : '0'" @dragstart="onPanelDragStart">
      <header class="ew-panel__header">
        <div class="ew-panel__title-wrap">
          <h2 class="ew-panel__title">{{ title }}</h2>
          <p v-if="subtitle" class="ew-panel__subtitle">{{ subtitle }}</p>
          <span class="ew-panel__status" :data-enabled="enabled ? '1' : '0'">
            {{ enabled ? '已启用' : '未启用' }}
          </span>
        </div>
        <div class="ew-panel__actions">
          <slot name="actions" />
        </div>
      </header>

      <nav class="ew-panel__tabs" aria-label="配置分区">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="ew-panel__tab"
          :data-active="tab.key === activeTab ? '1' : '0'"
          @click="$emit('change-tab', tab.key)"
        >
          {{ tab.label }}
        </button>
      </nav>

      <main class="ew-panel__body">
        <slot />
      </main>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { TabKey, TabMeta } from '../help-meta';

defineProps<{
  busy: boolean;
  enabled: boolean;
  title: string;
  subtitle?: string;
  tabs: TabMeta[];
  activeTab: TabKey;
}>();

defineEmits<{
  (event: 'change-tab', tab: TabKey): void;
  (event: 'close'): void;
}>();

function onPanelDragStart(event: DragEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    event.preventDefault();
    return;
  }

  // 仅允许显式授权的拖拽源继续工作，例如提示词排序的拖拽手柄。
  if (target.closest('[data-allow-native-drag="true"]')) {
    return;
  }

  event.preventDefault();
}
</script>

<style scoped>
.ew-overlay {
  position: fixed;
  inset: 0;
  z-index: 5000;
  padding: 12px;
  display: grid;
  place-items: center;
  /* Deeper, richer overlay mask with an emerald/violet hint */
  background:
    radial-gradient(circle at 10% 0%, rgba(138, 115, 255, 0.08), transparent 42%),
    radial-gradient(circle at 95% 0%, rgba(38, 194, 129, 0.08), transparent 40%), rgba(2, 5, 8, 0.65);
}

.ew-panel {
  /* Plugin-local default palette: elegant dark with vibrant accents */
  --SmartThemeQuoteColor: #7e8c9f;
  --SmartThemeBodyColor: #e8edf5;
  --ew-accent: #8b5cf6; /* Violet accent */
  --ew-accent-hover: #a78bfa;
  --ew-accent-glow: rgba(139, 92, 246, 0.35);
  --ew-success: #10b981; /* Emerald success */
  --ew-danger: #f43f5e; /* Rose danger */

  width: min(1120px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  border-radius: 1.25rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 35%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #3b4e68) 12%, rgba(12, 16, 24, 0.72));
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    inset 0 1px 1px rgba(255, 255, 255, 0.08); /* Inner top highlight */
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: opacity 0.3s ease;
}

.ew-panel[data-busy='1'] {
  opacity: 0.85;
  pointer-events: none;
}

.ew-panel__header {
  position: sticky;
  top: 0;
  z-index: 5;
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.1rem 1.25rem 1rem;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);
  background: linear-gradient(
    165deg,
    color-mix(in srgb, var(--SmartThemeQuoteColor, #3b4e68) 22%, rgba(10, 14, 20, 0.82)),
    color-mix(in srgb, var(--SmartThemeQuoteColor, #3b4e68) 12%, rgba(10, 14, 20, 0.78))
  );
  backdrop-filter: blur(12px);
}

.ew-panel__title-wrap {
  min-width: 0;
}

.ew-panel__title {
  margin: 0;
  font-size: clamp(1.4rem, 2.4vw, 1.85rem);
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.02em;
  background: linear-gradient(
    135deg,
    #ffffff 0%,
    color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 70%, transparent) 100%
  );
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.ew-panel__subtitle {
  margin: 0.45rem 0 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 68%, transparent);
  font-weight: 500;
}

.ew-panel__status {
  display: inline-flex;
  align-items: center;
  margin-top: 0.6rem;
  padding: 0.2rem 0.65rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 85%, transparent);
  font-size: 0.74rem;
  font-weight: 600;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.ew-panel__status[data-enabled='1'] {
  border-color: color-mix(in srgb, var(--ew-success) 55%, transparent);
  background: color-mix(in srgb, var(--ew-success) 18%, transparent);
  color: #fff;
  box-shadow: 0 0 12px color-mix(in srgb, var(--ew-success) 20%, transparent);
}

.ew-panel__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
  max-width: 50%;
}

.ew-panel__tabs {
  position: sticky;
  top: 0;
  z-index: 4;
  flex-shrink: 0;
  display: flex;
  gap: 0.55rem;
  padding: 0.65rem 1.25rem;
  overflow-x: auto;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 18%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #3b4e68) 8%, rgba(8, 12, 18, 0.55));
  scrollbar-width: none; /* Firefox */
}
.ew-panel__tabs::-webkit-scrollbar {
  display: none; /* Chrome/Safari */
}

.ew-panel__tab {
  position: relative;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 38%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 14%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 84%, transparent);
  padding: 0.35rem 1rem;
  font-size: 0.82rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition:
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.25s ease,
    color 0.25s ease,
    border-color 0.25s ease;
}

.ew-panel__tab[data-active='1'] {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 22%, transparent);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--ew-accent-glow);
}

.ew-panel__tab:hover:not([data-active='1']),
.ew-panel__tab:focus-visible:not([data-active='1']) {
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 65%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 25%, transparent);
  color: #fff;
  outline: none;
}

.ew-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 1.1rem 1.25rem 1.25rem;
}

.ew-panel__body::-webkit-scrollbar {
  width: 6px;
}
.ew-panel__body::-webkit-scrollbar-track {
  background: transparent;
}
.ew-panel__body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 35%, transparent);
  border-radius: 999px;
}
.ew-panel__body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 55%, transparent);
}

@supports not ((backdrop-filter: blur(1px))) {
  .ew-panel {
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #3b4e68) 18%, rgba(10, 14, 20, 0.96));
  }
}

@media (max-width: 900px) {
  .ew-overlay {
    padding: 0;
    place-items: stretch;
  }

  .ew-panel {
    width: 100vw;
    height: 100dvh;
    max-height: none;
    border-radius: 0;
    border-left: none;
    border-right: none;
  }

  .ew-panel__header {
    padding: 1rem 0.9rem;
  }

  .ew-panel__actions {
    max-width: none;
  }

  .ew-panel__tabs {
    padding-inline: 0.9rem;
  }

  .ew-panel__body {
    padding: 1rem 0.9rem 1.2rem;
  }
}
</style>
