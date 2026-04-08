<template>
  <div class="ew-rules">
    <header class="ew-rules__header">
      <h4 class="ew-rules__title">{{ title }}</h4>
      <button type="button" class="ew-rules__add" @click="addRule">新增</button>
    </header>

    <div v-if="rules.length === 0" class="ew-rules__empty">暂无规则</div>

    <div v-for="(rule, index) in rules" :key="`${title}-${index}`" class="ew-rules__row">
      <input
        :value="rule.start"
        type="text"
        class="ew-rules__input"
        placeholder="start"
        @input="setRuleValue(index, 'start', ($event.target as HTMLInputElement).value)"
      />
      <input
        :value="rule.end"
        type="text"
        class="ew-rules__input"
        placeholder="end"
        @input="setRuleValue(index, 'end', ($event.target as HTMLInputElement).value)"
      />
      <button type="button" class="ew-rules__delete" @click="removeRule(index)">删</button>
    </div>
  </div>
</template>

<script setup lang="ts">
type SliceRule = { start: string; end: string };

const props = withDefaults(
  defineProps<{
    title: string;
    modelValue?: SliceRule[];
  }>(),
  {
    modelValue: () => [],
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: SliceRule[]): void;
}>();

const rules = ref<SliceRule[]>(props.modelValue.map(rule => ({ ...rule })));
let emitTimer: number | null = null;

function cloneRules(source: SliceRule[]): SliceRule[] {
  return source.map(rule => ({ ...rule }));
}

function scheduleEmit() {
  if (emitTimer !== null) {
    window.clearTimeout(emitTimer);
  }
  emitTimer = window.setTimeout(() => {
    emitTimer = null;
    emit('update:modelValue', cloneRules(rules.value));
  }, 120);
}

watch(
  () => props.modelValue,
  next => {
    rules.value = cloneRules(next);
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (emitTimer !== null) {
    window.clearTimeout(emitTimer);
  }
});

function addRule() {
  rules.value = [...rules.value, { start: '', end: '' }];
  emit('update:modelValue', cloneRules(rules.value));
}

function removeRule(index: number) {
  rules.value = rules.value.filter((_, current) => current !== index);
  emit('update:modelValue', cloneRules(rules.value));
}

function setRuleValue(index: number, key: 'start' | 'end', value: string) {
  rules.value = rules.value.map((rule, current) => {
    if (current !== index) {
      return rule;
    }
    return { ...rule, [key]: value };
  });
  scheduleEmit();
}
</script>

<style scoped>
.ew-rules {
  border-radius: 0.82rem;
  border: 1px dashed color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 48%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 10%, rgba(0, 0, 0, 0.1));
  padding: 0.62rem;
}

.ew-rules__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.ew-rules__title {
  margin: 0;
  font-size: 0.82rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 90%, transparent);
}

.ew-rules__add {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 54%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 28%, transparent);
  color: var(--SmartThemeBodyColor, #edf2f9);
  font-size: 0.72rem;
  padding: 0.2rem 0.58rem;
  cursor: pointer;
}

.ew-rules__add:hover,
.ew-rules__add:focus-visible {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 42%, transparent);
  outline: none;
}

.ew-rules__empty {
  font-size: 0.76rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 66%, transparent);
  padding: 0.45rem 0.2rem;
}

.ew-rules__row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
}

.ew-rules__row:last-child {
  margin-bottom: 0;
}

.ew-rules__input {
  width: 100%;
  border-radius: 0.68rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 48%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 12%, rgba(8, 12, 18, 0.55));
  color: var(--SmartThemeBodyColor, #eef2f8);
  padding: 0.45rem 0.56rem;
  font-size: 0.8rem;
}

.ew-rules__input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 74%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 28%, transparent);
}

.ew-rules__delete {
  border-radius: 0.68rem;
  border: 1px solid color-mix(in srgb, #d76872 60%, transparent);
  background: color-mix(in srgb, #d76872 26%, transparent);
  color: #ffe5e8;
  font-size: 0.74rem;
  padding: 0.2rem 0.48rem;
  cursor: pointer;
}

.ew-rules__delete:hover,
.ew-rules__delete:focus-visible {
  background: color-mix(in srgb, #d76872 40%, transparent);
  outline: none;
}

@media (max-width: 900px) {
  .ew-rules__row {
    grid-template-columns: 1fr;
  }
}
</style>
