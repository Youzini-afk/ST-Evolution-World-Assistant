<template>
  <div class="ew-field-row">
    <div class="ew-field-row__header">
      <label class="ew-field-row__label" :for="fieldId">{{ label }}</label>
      <EwHelpTip v-if="help" :meta="help" />
    </div>
    <div class="ew-field-row__control">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { FieldHelpMeta } from '../help-meta';
import EwHelpTip from './EwHelpTip.vue';

defineProps<{
  label: string;
  fieldId?: string;
  help?: FieldHelpMeta;
}>();
</script>

<style scoped>
.ew-field-row {
  display: flex;
  flex-direction: column;
  gap: 0.42rem;
  min-width: 0;
}

.ew-field-row__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.48rem;
}

.ew-field-row__label {
  min-width: 0;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ecf2f9) 85%, transparent);
  font-size: 0.82rem;
  line-height: 1.2;
  font-weight: 500;
}

.ew-field-row__control {
  min-width: 0;
}

.ew-field-row__control :deep(input),
.ew-field-row__control :deep(select),
.ew-field-row__control :deep(textarea) {
  width: 100%;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  background: rgba(0, 0, 0, 0.2);
  color: var(--SmartThemeBodyColor, #eef2f8);
  padding: 0.55rem 0.65rem;
  font-size: 0.85rem;
  line-height: 1.4;
  transition: all 0.2s ease;
}

.ew-field-row__control :deep(textarea) {
  resize: vertical;
  min-height: 4rem;
}

.ew-field-row__control :deep(input[type='checkbox']) {
  width: 1rem;
  height: 1rem;
  accent-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #5c9dd8) 75%, #ffffff);
}

.ew-field-row__control :deep(input:focus),
.ew-field-row__control :deep(select:focus),
.ew-field-row__control :deep(textarea:focus) {
  outline: none;
  border-color: var(--ew-accent, #5c9dd8);
  box-shadow: 0 0 0 1px var(--ew-accent, #5c9dd8);
  background: rgba(0, 0, 0, 0.3);
}

.ew-field-row__control :deep(input[disabled]),
.ew-field-row__control :deep(textarea[disabled]),
.ew-field-row__control :deep(select[disabled]) {
  opacity: 0.8;
  cursor: not-allowed;
}
</style>
