<template>
  <div class="ew-prompt-order">
    <div class="ew-prompt-order__list">
      <div
        v-for="(entry, idx) in displayOrder"
        :key="entry.identifier"
        class="ew-prompt-order__item"
        :class="{
          'ew-prompt-order__item--disabled': !entry.enabled,
          'ew-prompt-order__item--marker': entry.type === 'marker',
          'ew-prompt-order__item--editing': editingId === entry.identifier,
        }"
        :draggable="dragArmedId === entry.identifier"
        :data-allow-native-drag="dragArmedId === entry.identifier ? 'true' : null"
        @dragstart="onDragStart(idx, $event)"
        @dragover.prevent="onDragOver(idx)"
        @dragend="onDragEnd"
      >
        <div class="ew-prompt-order__row">
          <span
            class="ew-prompt-order__handle"
            title="拖拽排序"
            @pointerdown.stop="armDrag(entry.identifier)"
            @pointerup.stop="releaseDragArm"
            @pointercancel.stop="releaseDragArm"
            >☰</span
          >
          <span class="ew-prompt-order__icon" :title="entry.type === 'marker' ? '系统标记' : '可编辑提示词'">
            {{ entry.type === 'marker' ? '📌' : '📄' }}
          </span>

          <div class="ew-prompt-order__label">
            <span class="ew-prompt-order__name">{{ entry.name || entry.identifier }}</span>
            <div class="ew-prompt-order__chips">
              <template v-if="entry.type === 'prompt'">
                <span :class="['ew-prompt-order__chip', `ew-prompt-order__chip--${entry.role}`]">{{ entry.role }}</span>
                <span
                  :class="[
                    'ew-prompt-order__chip',
                    entry.injection_position === 'in_chat'
                      ? 'ew-prompt-order__chip--inchat'
                      : 'ew-prompt-order__chip--relative',
                  ]"
                >
                  {{ entry.injection_position === 'in_chat' ? '聊天中' : '相对' }}
                </span>
                <span
                  v-if="entry.injection_position === 'in_chat'"
                  class="ew-prompt-order__chip ew-prompt-order__chip--depth"
                  >深度 {{ entry.injection_depth }}</span
                >
              </template>
              <span
                v-else-if="entry.role !== 'system'"
                :class="['ew-prompt-order__chip', `ew-prompt-order__chip--${entry.role}`]"
                >{{ entry.role }}</span
              >
            </div>
          </div>

          <div class="ew-prompt-order__actions">
            <button
              type="button"
              class="ew-mini-btn"
              :title="entry.type === 'marker' ? '查看' : '编辑'"
              @click="toggleEdit(entry.identifier)"
            >
              ✎
            </button>
            <button
              v-if="canDelete(entry)"
              type="button"
              class="ew-mini-btn ew-mini-btn--danger"
              title="删除"
              @click="removeEntry(entry.identifier)"
            >
              ✕
            </button>
            <label class="ew-switch ew-prompt-order__toggle">
              <input type="checkbox" :checked="entry.enabled" @change="toggleEnabled(entry.identifier)" />
              <span class="ew-switch__slider"></span>
            </label>
          </div>
        </div>

        <!-- Inline editor for 'prompt' type entries -->
        <transition name="ew-editor-fade">
          <div
            v-if="entry.type === 'prompt' && hasOpenedEditor(entry.identifier)"
            v-show="editingId === entry.identifier"
            class="ew-prompt-order__editor"
          >
            <div class="ew-prompt-order__editor-grid">
              <label class="ew-prompt-order__editor-label">
                名称
                <input
                  type="text"
                  :value="getDraftEntryValue(entry, 'name')"
                  @input="setDraftEntryValue(entry.identifier, 'name', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="ew-prompt-order__editor-label">
                角色
                <select
                  :value="entry.role"
                  @change="patchEntry(entry.identifier, 'role', ($event.target as HTMLSelectElement).value)"
                >
                  <option value="system">system</option>
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                </select>
              </label>
              <label class="ew-prompt-order__editor-label">
                插入位置
                <select
                  :value="entry.injection_position"
                  @change="
                    patchEntry(entry.identifier, 'injection_position', ($event.target as HTMLSelectElement).value)
                  "
                >
                  <option value="relative">相对</option>
                  <option value="in_chat">聊天中</option>
                </select>
              </label>
              <label v-if="entry.injection_position === 'in_chat'" class="ew-prompt-order__editor-label">
                注入深度
                <input
                  type="number"
                  min="0"
                  :value="entry.injection_depth"
                  @input="
                    patchEntry(
                      entry.identifier,
                      'injection_depth',
                      Number(($event.target as HTMLInputElement).value) || 0,
                    )
                  "
                />
              </label>
            </div>
            <label class="ew-prompt-order__editor-label">
              内容
              <textarea
                :value="getDraftEntryValue(entry, 'content')"
                rows="12"
                placeholder="在此输入提示词内容..."
                @input="setDraftEntryValue(entry.identifier, 'content', ($event.target as HTMLTextAreaElement).value)"
              ></textarea>
            </label>
          </div>
        </transition>

        <!-- Read-only info panel for 'marker' type entries -->
        <transition name="ew-editor-fade">
          <div
            v-if="entry.type === 'marker' && hasOpenedEditor(entry.identifier)"
            v-show="editingId === entry.identifier"
            class="ew-prompt-order__editor ew-prompt-order__marker-info"
          >
            <div class="ew-prompt-order__editor-grid">
              <label class="ew-prompt-order__editor-label">
                名称
                <input type="text" :value="entry.name" disabled />
              </label>
              <label class="ew-prompt-order__editor-label">
                角色
                <input
                  type="text"
                  :value="entry.role === 'system' ? '系统' : entry.role === 'user' ? '用户' : '助手'"
                  disabled
                />
              </label>
              <label class="ew-prompt-order__editor-label">
                位置
                <input type="text" :value="entry.injection_position === 'in_chat' ? '聊天中' : '相对'" disabled />
              </label>
            </div>
            <div class="ew-prompt-order__marker-source">
              <p class="ew-prompt-order__marker-source-text">此提示词的内容是从其他地方提取的，无法在此处进行编辑。</p>
              <p class="ew-prompt-order__marker-source-label">来源：&nbsp; {{ getMarkerSource(entry.identifier) }}</p>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <button type="button" class="ew-prompt-order__add" @click="addCustomEntry">+ 新增自定义提示词</button>
  </div>
</template>

<script setup lang="ts">
import { simpleHash } from '../../runtime/helpers';
import type { EwPromptOrderEntry } from '../../runtime/types';
import { BUILTIN_MARKERS, BUILTIN_PROMPTS } from '../../runtime/types';

const props = defineProps<{
  promptOrder: EwPromptOrderEntry[];
}>();

const emit = defineEmits<{
  (event: 'update:promptOrder', value: EwPromptOrderEntry[]): void;
}>();

const editingId = ref<string | null>(null);
const dragArmedId = ref<string | null>(null);
const openedEditorIds = ref(new Set<string>());
let dragFromIdx = -1;
const dragPreview = ref<EwPromptOrderEntry[] | null>(null);
const entryDrafts = ref<Record<string, Partial<Pick<EwPromptOrderEntry, 'name' | 'content'>>>>({});
const draftCommitTimers = new Map<string, number>();

/** The displayed list: use drag preview during drag, else props */
const displayOrder = computed(() => dragPreview.value ?? props.promptOrder);

function clone(source?: EwPromptOrderEntry[]): EwPromptOrderEntry[] {
  return (source ?? props.promptOrder).map(entry => ({ ...entry }));
}

function getDraftEntryValue(entry: EwPromptOrderEntry, field: 'name' | 'content'): string {
  return entryDrafts.value[entry.identifier]?.[field] ?? entry[field] ?? '';
}

function clearDraftCommitTimer(key: string) {
  const timer = draftCommitTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    draftCommitTimers.delete(key);
  }
}

function setDraftEntryValue(identifier: string, field: 'name' | 'content', value: string) {
  entryDrafts.value = {
    ...entryDrafts.value,
    [identifier]: {
      ...(entryDrafts.value[identifier] ?? {}),
      [field]: value,
    },
  };

  const timerKey = `${identifier}:${field}`;
  clearDraftCommitTimer(timerKey);
  const timer = window.setTimeout(() => {
    draftCommitTimers.delete(timerKey);
    patchEntry(identifier, field, value);
  }, 140);
  draftCommitTimers.set(timerKey, timer);
}

watch(
  () => props.promptOrder,
  next => {
    const byId = new Map(next.map(entry => [entry.identifier, entry]));
    const normalizedDrafts: Record<string, Partial<Pick<EwPromptOrderEntry, 'name' | 'content'>>> = {};

    for (const [identifier, draft] of Object.entries(entryDrafts.value)) {
      const entry = byId.get(identifier);
      if (!entry) {
        clearDraftCommitTimer(`${identifier}:name`);
        clearDraftCommitTimer(`${identifier}:content`);
        continue;
      }

      const nextDraft: Partial<Pick<EwPromptOrderEntry, 'name' | 'content'>> = {};
      if (draft.name !== undefined && draft.name !== entry.name) {
        nextDraft.name = draft.name;
      }
      if (draft.content !== undefined && draft.content !== entry.content) {
        nextDraft.content = draft.content;
      }
      if (Object.keys(nextDraft).length > 0) {
        normalizedDrafts[identifier] = nextDraft;
      }
    }

    entryDrafts.value = normalizedDrafts;
  },
  { deep: true },
);

onBeforeUnmount(() => {
  for (const timer of draftCommitTimers.values()) {
    window.clearTimeout(timer);
  }
  draftCommitTimers.clear();
});

function toggleEdit(identifier: string) {
  openedEditorIds.value.add(identifier);
  editingId.value = editingId.value === identifier ? null : identifier;
  dragArmedId.value = null;
}

function hasOpenedEditor(identifier: string) {
  return openedEditorIds.value.has(identifier);
}

function armDrag(identifier: string) {
  dragArmedId.value = identifier;
}

function releaseDragArm() {
  dragArmedId.value = null;
}

function canDelete(entry: EwPromptOrderEntry): boolean {
  return !BUILTIN_MARKERS.has(entry.identifier) && !BUILTIN_PROMPTS.has(entry.identifier);
}

const MARKER_SOURCES: Record<string, string> = {
  worldInfoBefore: 'World Info (↑ 角色描述前)',
  worldInfoAfter: 'World Info (↓ 角色描述后)',
  charDescription: '角色卡 — 描述',
  charPersonality: '角色卡 — 性格',
  scenario: '角色卡 — 情景',
  personaDescription: '用户 — 角色描述',
  dialogueExamples: '角色卡 — 对话示例',
  chatHistory: '当前聊天记录',
};

function getMarkerSource(identifier: string): string {
  return MARKER_SOURCES[identifier] ?? identifier;
}

function toggleEnabled(identifier: string) {
  const next = clone();
  const target = next.find(e => e.identifier === identifier);
  if (target) {
    target.enabled = !target.enabled;
    emit('update:promptOrder', next);
  }
}

function patchEntry(identifier: string, field: keyof EwPromptOrderEntry, value: any) {
  const next = clone();
  const target = next.find(e => e.identifier === identifier);
  if (target) {
    (target as any)[field] = value;
    emit('update:promptOrder', next);
  }
}

function removeEntry(identifier: string) {
  const next = clone().filter(e => e.identifier !== identifier);
  if (editingId.value === identifier) {
    editingId.value = null;
  }
  emit('update:promptOrder', next);
}

function addCustomEntry() {
  const next = clone();
  const id = `custom_${simpleHash(String(Date.now()))}`;
  next.push({
    identifier: id,
    name: `自定义提示词 ${next.filter(e => !BUILTIN_MARKERS.has(e.identifier) && !BUILTIN_PROMPTS.has(e.identifier)).length + 1}`,
    enabled: true,
    type: 'prompt',
    role: 'system',
    content: '',
    injection_position: 'relative',
    injection_depth: 0,
  });
  emit('update:promptOrder', next);
  editingId.value = id;
  openedEditorIds.value.add(id);
}

// ── 拖拽排序（PERF-1: 仅在 dragend 时发射 emit） ──────────────
function onDragStart(idx: number, e: DragEvent) {
  if (dragArmedId.value !== displayOrder.value[idx]?.identifier) {
    e.preventDefault();
    return;
  }

  dragFromIdx = idx;
  dragPreview.value = clone();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
  }
}

function onDragOver(toIdx: number) {
  if (dragFromIdx < 0 || dragFromIdx === toIdx || !dragPreview.value) return;
  const [moved] = dragPreview.value.splice(dragFromIdx, 1);
  dragPreview.value.splice(toIdx, 0, moved);
  dragFromIdx = toIdx;
}

function onDragEnd() {
  if (dragPreview.value) {
    const finalOrder = dragPreview.value;
    // CR-6: 先发射新顺序，然后在 nextTick 中清除预览
    // 避免回退到旧的 props.promptOrder 产生一帧闪烁
    emit('update:promptOrder', finalOrder);
    nextTick(() => {
      dragPreview.value = null;
    });
  }
  dragFromIdx = -1;
  dragArmedId.value = null;
}
</script>

<style scoped>
.ew-prompt-order__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ew-prompt-order__item {
  background: var(--ew-bg-elevated, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--ew-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  transition:
    opacity 0.2s,
    background 0.2s,
    border-color 0.2s;
  cursor: grab;
}

.ew-prompt-order__item:hover {
  background: var(--ew-bg-hover, rgba(255, 255, 255, 0.05));
}

.ew-prompt-order__item:active {
  cursor: grabbing;
}

.ew-prompt-order__item--disabled {
  opacity: 0.5;
}

.ew-prompt-order__item--disabled:hover {
  opacity: 0.6;
}

.ew-prompt-order__item--editing {
  border-color: var(--ew-accent, #80a0ff);
  background: var(--ew-bg-elevated, rgba(255, 255, 255, 0.04));
}

.ew-prompt-order__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  min-height: 48px;
}

.ew-prompt-order__handle {
  cursor: grab;
  opacity: 0.25;
  font-size: 14px;
  user-select: none;
  flex-shrink: 0;
  width: 16px;
  transition: opacity 0.2s;
}

.ew-prompt-order__item:hover .ew-prompt-order__handle {
  opacity: 0.7;
}

.ew-prompt-order__icon {
  flex-shrink: 0;
  font-size: 14px;
  width: 20px;
  text-align: center;
}

.ew-prompt-order__label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ew-prompt-order__name {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ew-text, #eee);
  font-weight: 500;
}

.ew-prompt-order__chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.ew-prompt-order__item--marker .ew-prompt-order__name {
  color: var(--ew-text-muted, #aaa);
  font-weight: 400;
}

.ew-prompt-order__chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 9999px; /* Pill shape */
  background: var(--ew-chip-bg, rgba(255, 255, 255, 0.08));
  color: var(--ew-text-muted, #bbb);
  flex-shrink: 0;
  letter-spacing: 0.5px;
  font-weight: 500;
  line-height: 1.2;
}

/* Chip Semantic Colors */
.ew-prompt-order__chip--system {
  background: rgba(167, 139, 250, 0.15); /* Purple tint */
  color: #c4b5fd;
}
.ew-prompt-order__chip--user {
  background: rgba(96, 165, 250, 0.15); /* Blue tint */
  color: #93c5fd;
}
.ew-prompt-order__chip--assistant {
  background: rgba(244, 114, 182, 0.15); /* Pink/Red tint */
  color: #f9a8d4;
}
.ew-prompt-order__chip--relative {
  background: rgba(255, 255, 255, 0.1);
  color: #ddd;
}
.ew-prompt-order__chip--inchat {
  background: rgba(52, 211, 153, 0.15); /* Emerald green tint */
  color: #6ee7b7;
}
.ew-prompt-order__chip--depth {
  background: rgba(251, 191, 36, 0.15); /* Amber/Yellow tint */
  color: #fcd34d;
}

.ew-prompt-order__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}

.ew-mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--ew-text-muted, #888);
  font-size: 14px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
  line-height: 1;
}

.ew-mini-btn:hover {
  color: var(--ew-text, #ddd);
  background: rgba(255, 255, 255, 0.08);
}

.ew-mini-btn--danger:hover {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
}

.ew-prompt-order__toggle {
  margin-left: 2px;
}

/* ── Inline editor ── */
.ew-prompt-order__editor {
  padding: 16px;
  background: rgba(0, 0, 0, 0.15); /* Drawer inset dark background */
  border-top: 1px solid var(--ew-border, rgba(255, 255, 255, 0.05));
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ew-prompt-order__editor-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.ew-prompt-order__editor-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--ew-text, #ddd);
  font-weight: 500;
}

.ew-prompt-order__editor-label input,
.ew-prompt-order__editor-label select,
.ew-prompt-order__editor-label textarea {
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--ew-border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: var(--ew-input-bg, rgba(0, 0, 0, 0.2));
  color: var(--ew-text, #fff);
  transition: border-color 0.2s;
}

.ew-prompt-order__editor-label input:focus,
.ew-prompt-order__editor-label select:focus,
.ew-prompt-order__editor-label textarea:focus {
  outline: none;
  border-color: var(--ew-accent, #80a0ff);
  background: rgba(0, 0, 0, 0.3);
}

.ew-prompt-order__editor-label textarea {
  resize: vertical;
  min-height: 240px;
  font-family: Consolas, Monaco, monospace;
}

/* ── Marker info panel ── */
.ew-prompt-order__marker-info input:disabled {
  opacity: 0.7;
  cursor: default;
}

.ew-prompt-order__marker-source {
  text-align: center;
  padding: 20px 16px;
}

.ew-prompt-order__marker-source-text {
  color: #fbbf24;
  font-size: 13px;
  margin: 0 0 8px;
}

.ew-prompt-order__marker-source-label {
  color: var(--ew-text, #ddd);
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

/* ── Add button ── */
.ew-prompt-order__add {
  margin-top: 8px;
  width: 100%;
  padding: 8px;
  border: 1px dashed var(--ew-border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: transparent;
  color: var(--ew-text-muted, #aaa);
  cursor: pointer;
  font-size: 13px;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.ew-prompt-order__add:hover {
  border-color: var(--ew-accent, #80a0ff);
  color: var(--ew-accent, #80a0ff);
}

/* ew-switch (scoped duplicate to ensure availability) */
.ew-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
.ew-switch input {
  display: none;
}
.ew-switch__slider {
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.12);
  position: relative;
  transition: background 0.2s;
}
.ew-switch__slider::after {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #888;
  top: 2px;
  left: 2px;
  transition:
    transform 0.2s,
    background 0.2s;
}
.ew-switch input:checked + .ew-switch__slider {
  background: var(--ew-accent, #80a0ff);
}
.ew-switch input:checked + .ew-switch__slider::after {
  transform: translateX(14px);
  background: #fff;
}

.ew-prompt-order__editor {
  content-visibility: auto;
  contain-intrinsic-size: 420px;
}

/* 轻量过渡，避免大 textarea 配合 max-height 动画触发布局抖动 */
.ew-editor-fade-enter-active,
.ew-editor-fade-leave-active {
  transition: opacity 0.12s ease;
}

.ew-editor-fade-enter-from,
.ew-editor-fade-leave-to {
  opacity: 0;
}

/* ── 移动端提示词列表：两行布局 ── */
@media (max-width: 900px) {
  .ew-prompt-order__row {
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 10px 10px;
  }
  .ew-prompt-order__label {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    flex-basis: 0;
  }
  .ew-prompt-order__name {
    white-space: normal;
    word-break: break-word;
  }
  .ew-prompt-order__chips {
    flex-wrap: wrap;
  }
  .ew-prompt-order__editor-grid {
    grid-template-columns: 1fr;
  }
}
</style>
