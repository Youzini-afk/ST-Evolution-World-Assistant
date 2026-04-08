<template>
  <section class="ew-section-card" :data-open="resolvedOpen ? '1' : '0'">
    <header class="ew-section-card__header">
      <div class="ew-section-card__title-group">
        <h3 class="ew-section-card__title">{{ title }}</h3>
        <p v-if="subtitle" class="ew-section-card__subtitle">{{ subtitle }}</p>
      </div>
      <div class="ew-section-card__actions">
        <slot name="actions" />
        <button
          v-if="collapsible"
          type="button"
          class="ew-section-card__toggle"
          :aria-expanded="resolvedOpen ? 'true' : 'false'"
          @click="toggleOpen"
        >
          {{ resolvedOpen ? '收起' : '展开' }}
        </button>
      </div>
    </header>

    <transition name="ew-fold">
      <div v-if="resolvedOpen" class="ew-section-card__body">
        <slot />
      </div>
    </transition>
  </section>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    collapsible?: boolean;
    modelValue?: boolean;
  }>(),
  {
    subtitle: '',
    collapsible: false,
    modelValue: true,
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
}>();

const resolvedOpen = computed(() => {
  return props.collapsible ? props.modelValue : true;
});

function toggleOpen() {
  if (!props.collapsible) {
    return;
  }
  emit('update:modelValue', !resolvedOpen.value);
}
</script>

<style scoped>
.ew-section-card {
  position: relative;
  z-index: 1;
  margin-bottom: 24px;
}

.ew-section-card__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 0.5rem 0.75rem 0.5rem;
  position: relative;
}

/* Subtle glow at the bottom of the header */
.ew-section-card__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 10%;
  right: 10%;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--SmartThemeQuoteColor) 30%, transparent), transparent);
}

.ew-section-card__title-group {
  min-width: 0;
}

.ew-section-card__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.25;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 90%, transparent);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.ew-section-card__subtitle {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
  font-weight: 400;
  line-height: 1.4;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 50%, transparent);
}

.ew-section-card__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.ew-section-card__toggle {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 90%, transparent);
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.3rem 0.8rem;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.ew-section-card__toggle:hover,
.ew-section-card__toggle:focus-visible {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--ew-accent-glow);
  outline: none;
}

.ew-section-card__body {
  padding: 1.1rem;
}

.ew-fold-enter-active,
.ew-fold-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  transform-origin: top center;
}

.ew-fold-enter-from,
.ew-fold-leave-to {
  opacity: 0;
  transform: translateY(-8px) scaleY(0.98);
}

@supports not ((backdrop-filter: blur(1px))) {
  .ew-section-card {
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #334457) 18%, rgba(10, 14, 20, 0.94));
  }
}

@media (prefers-reduced-motion: reduce) {
  .ew-fold-enter-active,
  .ew-fold-leave-active,
  .ew-section-card__toggle,
  .ew-section-card {
    transition: none;
  }
}
</style>
