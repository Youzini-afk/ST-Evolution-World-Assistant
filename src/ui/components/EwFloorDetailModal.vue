<template>
  <transition name="hist-modal">
    <div v-if="visible" class="hist-modal-overlay" @click.self="$emit('close')">
      <div class="hist-modal-container">
        <!-- Header -->
        <header class="hist-modal-header">
          <h3 class="hist-modal-title">
            {{ isComparing ? '楼层对比' : `楼层 #${floorId}` }}
          </h3>
          <button type="button" class="hist-modal-close" @click="$emit('close')">✕</button>
        </header>

        <!-- Normal Detail View -->
        <div v-if="!isComparing" class="hist-modal-body">
          <div v-if="safeDiff" class="hist-changes">
            <div
              v-for="[controllerKey, change] in Object.entries(safeDiff.controllersChanged)"
              :key="`ctrl-${controllerKey}`"
              class="hist-change-item hist-change--modified"
            >
              <span class="hist-change-icon">≈</span>
              <span>Controller {{ controllerKey }} · {{ change }}</span>
            </div>
            <div v-for="name in safeDiff.created" :key="'c-' + name" class="hist-change-item hist-change--created">
              <span class="hist-change-icon">+</span>
              <span class="hist-change-name">{{ name }}</span>
            </div>
            <div v-for="name in safeDiff.modified" :key="'m-' + name" class="hist-change-item hist-change--modified">
              <span class="hist-change-icon">~</span>
              <span class="hist-change-name">{{ name }}</span>
            </div>
            <div v-for="name in safeDiff.deleted" :key="'d-' + name" class="hist-change-item hist-change--deleted">
              <span class="hist-change-icon">−</span>
              <span class="hist-change-name">{{ name }}</span>
            </div>
            <div v-for="name in safeDiff.toggled" :key="'t-' + name" class="hist-change-item hist-change--toggled">
              <span class="hist-change-icon">⇄</span>
              <span class="hist-change-name">{{ name }}</span>
            </div>
            <div
              v-if="
                !safeDiff.created.length &&
                !safeDiff.modified.length &&
                !safeDiff.deleted.length &&
                !safeDiff.toggled.length &&
                !Object.keys(safeDiff.controllersChanged).length
              "
              class="hist-empty"
            >
              此楼层无变更。
            </div>
          </div>
          <div v-else class="hist-empty">此楼层无快照数据。</div>

          <div class="hist-meta-panel">
            <div class="hist-meta-row">
              <strong>解析结果：</strong><span>{{ resolutionSummary }}</span>
            </div>
            <div class="hist-meta-row">
              <strong>快照来源：</strong><span>{{ sourceSummary }}</span>
            </div>
            <div class="hist-meta-row">
              <strong>楼层角色：</strong><span>{{ roleSummary }}</span>
            </div>
            <div class="hist-meta-row">
              <strong>楼层语义：</strong><span>{{ anchorSummary }}</span>
            </div>
            <div v-if="pairedMessageId !== undefined && pairedMessageId !== null" class="hist-meta-row">
              <strong>关联楼层：</strong><span>#{{ pairedMessageId }}</span>
            </div>
            <div class="hist-meta-row">
              <strong>可用版本数：</strong><span>{{ availableVersionCount }}</span>
            </div>
            <div v-if="safeExecution" class="hist-meta-row">
              <strong>执行状态：</strong>
              <span>{{ safeExecution.execution_status === 'skipped' ? '已跳过' : '已执行' }}</span>
            </div>
            <div v-if="safeExecution?.skip_reason" class="hist-meta-row">
              <strong>跳过原因：</strong><span>{{ safeExecution.skip_reason }}</span>
            </div>
            <div v-if="safeExecution" class="hist-meta-row">
              <strong>尝试工作流：</strong><span>{{ safeExecution.attempted_flow_ids.length }}</span>
            </div>
            <div v-if="safeExecution" class="hist-meta-row">
              <strong>失败工作流：</strong><span>{{ safeExecution.failed_flow_ids.length }}</span>
            </div>
            <div v-if="matchedVersionKey" class="hist-meta-row">
              <strong>展示版本键：</strong><code>{{ matchedVersionKey }}</code>
            </div>
            <div v-if="fileName" class="hist-meta-row">
              <strong>文件名：</strong><code>{{ fileName }}</code>
            </div>
          </div>

          <!-- Snapshot content -->
          <div v-if="safeSnapshot" class="hist-snapshot-detail">
            <h4 class="hist-sub-title">快照内容</h4>
            <div
              v-for="controller in safeSnapshot.controllers"
              :key="controller.entry_name || controller.flow_id || controller.flow_name"
              class="hist-detail-block"
            >
              <strong>Controller · {{ controller.flow_name || controller.flow_id || 'Legacy' }}</strong>
              <pre>{{ truncate(controller.content, 500) }}</pre>
            </div>
            <div v-for="entry in safeSnapshot.dyn_entries" :key="entry.name" class="hist-detail-block">
              <strong>
                <span class="hist-enabled-dot" :data-enabled="entry.enabled ? '1' : '0'" />
                {{ entry.name }}
              </strong>
              <pre>{{ truncate(entry.content, 300) }}</pre>
            </div>
          </div>

          <!-- Actions -->
          <div class="hist-modal-actions">
            <button type="button" class="ew-btn" :disabled="store.busy" @click="doRollback">↩ 回滚到此楼层</button>
            <button type="button" class="ew-btn" @click="startCompare">⇋ 对比其他楼层</button>
          </div>
        </div>

        <!-- Compare View -->
        <div v-else class="hist-modal-body">
          <div class="hist-compare-select">
            <label>对比目标楼层：</label>
            <select v-model="compareTargetId" class="hist-select">
              <option v-for="floor in otherFloors" :key="floor.messageId" :value="floor.messageId">
                #{{ floor.messageId }}
              </option>
            </select>
            <button type="button" class="ew-btn ew-btn--sm" @click="isComparing = false">取消对比</button>
          </div>

          <div v-if="compareTargetId !== null" class="hist-diff-view">
            <!-- Left: current floor -->
            <div class="hist-diff-col">
              <h4 class="hist-diff-title">楼层 #{{ floorId }}</h4>
              <div v-if="safeSnapshot" class="hist-diff-entries">
                <div
                  v-for="controller in safeSnapshot.controllers"
                  :key="`left-${controller.entry_name || controller.flow_id || controller.flow_name}`"
                  class="hist-diff-entry"
                >
                  <strong>Controller · {{ controller.flow_name || controller.flow_id || 'Legacy' }}</strong>
                  <pre>{{ truncate(controller.content, 300) }}</pre>
                </div>
                <div
                  v-for="e in safeSnapshot.dyn_entries"
                  :key="e.name"
                  class="hist-diff-entry"
                  :class="diffEntryClass(e.name, 'left')"
                >
                  <strong>{{ e.name }}</strong>
                  <pre>{{ truncate(e.content, 200) }}</pre>
                </div>
              </div>
              <div v-else class="hist-empty">无快照</div>
            </div>
            <!-- Right: compare target -->
            <div class="hist-diff-col">
              <h4 class="hist-diff-title">楼层 #{{ compareTargetId }}</h4>
              <div v-if="safeCompareSnapshot" class="hist-diff-entries">
                <div
                  v-for="controller in safeCompareSnapshot.controllers"
                  :key="`right-${controller.entry_name || controller.flow_id || controller.flow_name}`"
                  class="hist-diff-entry"
                >
                  <strong>Controller · {{ controller.flow_name || controller.flow_id || 'Legacy' }}</strong>
                  <pre>{{ truncate(controller.content, 300) }}</pre>
                </div>
                <div
                  v-for="e in safeCompareSnapshot.dyn_entries"
                  :key="e.name"
                  class="hist-diff-entry"
                  :class="diffEntryClass(e.name, 'right')"
                >
                  <strong>{{ e.name }}</strong>
                  <pre>{{ truncate(e.content, 200) }}</pre>
                </div>
              </div>
              <div v-else class="hist-empty">无快照</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { diffSnapshots, type FloorSnapshotReadResolution, type SnapshotDiff } from '../../runtime/floor-binding';
import { upgradeSnapshotData, type SnapshotData } from '../../runtime/snapshot-storage';
import { useEwStore } from '../store';

const props = defineProps<{
  visible: boolean;
  floorId: number;
  snapshot: SnapshotData | null;
  prevSnapshot: SnapshotData | null;
  resolution: FloorSnapshotReadResolution;
  availableVersionCount: number;
  snapshotSource: 'file' | 'inline' | 'none';
  matchedVersionKey?: string;
  fileName?: string;
  execution?: {
    execution_status: 'executed' | 'skipped';
    skip_reason?: string;
    attempted_flow_ids: string[];
    failed_flow_ids: string[];
    workflow_failed: boolean;
  };
  anchorKind?: 'assistant_anchor' | 'source_user' | 'legacy_user_anchor' | 'normal';
  pairedMessageId?: number;
  messageRole?: 'assistant' | 'user' | 'other';
}>();

defineEmits<{
  (e: 'close'): void;
}>();

const store = useEwStore();
const isComparing = ref(false);
const compareTargetId = ref<number | null>(null);

const safeExecution = computed(() => {
  if (!props.execution) {
    return null;
  }
  return {
    execution_status: props.execution.execution_status === 'skipped' ? 'skipped' : 'executed',
    skip_reason: typeof props.execution.skip_reason === 'string' ? props.execution.skip_reason : undefined,
    attempted_flow_ids: Array.isArray(props.execution.attempted_flow_ids) ? props.execution.attempted_flow_ids : [],
    failed_flow_ids: Array.isArray(props.execution.failed_flow_ids) ? props.execution.failed_flow_ids : [],
    workflow_failed: Boolean(props.execution.workflow_failed),
  };
});

const safeSnapshot = computed<SnapshotData | null>(() => {
  if (!props.snapshot) {
    return null;
  }
  return upgradeSnapshotData(props.snapshot) ?? null;
});

const safePrevSnapshot = computed<SnapshotData | null>(() => {
  if (!props.prevSnapshot) {
    return null;
  }
  return upgradeSnapshotData(props.prevSnapshot) ?? null;
});

const safeDiff = computed<SnapshotDiff | null>(() => {
  if (!safeSnapshot.value) return null;
  try {
    return diffSnapshots(safePrevSnapshot.value, safeSnapshot.value);
  } catch (error) {
    console.error('[Evolution World] floor detail diff failed:', error);
    return null;
  }
});

const resolutionSummary = computed(() => {
  if (!safeSnapshot.value && safeExecution.value?.execution_status === 'skipped') {
    return '该楼存在 after-reply 执行记录，但本轮被跳过，因此没有生成新的楼层快照。';
  }
  if (
    !safeSnapshot.value &&
    safeExecution.value?.execution_status === 'executed' &&
    !safeExecution.value.workflow_failed &&
    safeExecution.value.attempted_flow_ids.length > 0
  ) {
    return '该楼工作流已执行，但这一轮没有产出可展示的快照差异。通常这是空快照或受管条目未变化，不是历史面板损坏。';
  }

  switch (props.resolution) {
    case 'exact':
      return '当前可见版本已精确命中该楼快照。';
    case 'single_fallback':
      return '当前版本未精确命中，但该楼仅有一个快照版本，因此直接展示该版本。允许用于受控写回。';
    case 'same_swipe_fallback':
      return '当前版本未精确命中，已回退展示同一 swipe 下的快照版本。允许用于受控写回。';
    case 'latest_fallback':
      return '当前版本未精确命中，已回退展示该楼最近可用的快照版本。该来源只用于显示，默认不会参与危险写回。';
    case 'missing':
    default:
      return '当前楼没有可展示快照；可能是未执行、被跳过，或快照确实缺失。';
  }
});

const sourceSummary = computed(() => {
  switch (props.snapshotSource) {
    case 'file':
      return '文件快照';
    case 'inline':
      return '消息内联快照';
    default:
      return '无';
  }
});

const roleSummary = computed(() => {
  if (props.messageRole === 'assistant') {
    return 'AI 回复楼';
  }
  if (props.messageRole === 'user') {
    return '用户输入楼';
  }
  return '其他';
});

const anchorSummary = computed(() => {
  switch (props.anchorKind) {
    case 'assistant_anchor':
      return '主快照锚点（AI楼）';
    case 'source_user':
      return '拦截源楼（非主锚点）';
    case 'legacy_user_anchor':
      return '旧版 user 锚点（兼容展示）';
    default:
      return '普通楼层';
  }
});

const otherFloors = computed(() =>
  store.floorSnapshots.filter(f => f.messageId !== props.floorId && f.snapshot !== null),
);

const safeCompareSnapshot = computed<SnapshotData | null>(() => {
  if (compareTargetId.value === null) return null;
  const floor = store.floorSnapshots.find(f => f.messageId === compareTargetId.value);
  return floor?.snapshot ? upgradeSnapshotData(floor.snapshot) ?? null : null;
});

// 计算跨楼层 diff，用于对比视图中的条目着色
const crossDiff = computed<SnapshotDiff | null>(() => {
  if (!safeSnapshot.value || !safeCompareSnapshot.value) return null;
  try {
    return diffSnapshots(safeSnapshot.value, safeCompareSnapshot.value);
  } catch (error) {
    console.error('[Evolution World] floor compare diff failed:', error);
    return null;
  }
});

function diffEntryClass(name: string, side: 'left' | 'right'): string {
  if (!crossDiff.value) return '';
  if (side === 'left') {
    if (crossDiff.value.deleted.includes(name)) return 'hist-diff--deleted';
    if (crossDiff.value.modified.includes(name)) return 'hist-diff--modified';
    return '';
  }
  if (crossDiff.value.created.includes(name)) return 'hist-diff--created';
  if (crossDiff.value.modified.includes(name)) return 'hist-diff--modified';
  return '';
}

function doRollback() {
  store.doRollbackToFloor(props.floorId);
}

function startCompare() {
  isComparing.value = true;
  const first = otherFloors.value[0];
  compareTargetId.value = first ? first.messageId : null;
}

function truncate(str: string, maxLen: number): string {
  const text = String(str ?? '');
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
</script>

<style scoped>
.hist-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.hist-modal-container {
  width: 100%;
  max-width: 760px;
  max-height: 85vh;
  border-radius: 1rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 30%, transparent);
  background: color-mix(in srgb, var(--SmartThemeChatMesColorBg, #1a1f2e) 95%, transparent);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.hist-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
}

.hist-modal-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--SmartThemeBodyColor, #edf2f9);
}

.hist-modal-close {
  background: none;
  border: none;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 60%, transparent);
  font-size: 1.2rem;
  cursor: pointer;
  padding: 0.25rem;
  transition: color 0.2s;
}
.hist-modal-close:hover {
  color: var(--SmartThemeBodyColor);
}

.hist-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
}

/* ── Changes List ── */
.hist-changes {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.hist-change-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 0.5rem;
  font-size: 0.8rem;
}

.hist-empty {
  padding: 1rem;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 10%, rgba(0, 0, 0, 0.12));
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 65%, transparent);
  font-size: 0.82rem;
}

.hist-meta-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin: 0.85rem 0 0;
  padding: 0.8rem 0.9rem;
  border-radius: 0.8rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 18%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 7%, rgba(0, 0, 0, 0.1));
}

.hist-meta-row {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
  word-break: break-all;
}

.hist-meta-row code {
  font-size: 0.72rem;
  padding: 0.08rem 0.25rem;
  border-radius: 0.35rem;
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 18%, transparent);
}

.hist-change-icon {
  width: 1.2rem;
  text-align: center;
  font-weight: 700;
  flex-shrink: 0;
}

.hist-change-name {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 0.78rem;
}

.hist-change--created {
  background: color-mix(in srgb, #22c55e 12%, transparent);
  color: #86efac;
}
.hist-change--created .hist-change-icon {
  color: #22c55e;
}

.hist-change--modified {
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: #fcd34d;
}
.hist-change--modified .hist-change-icon {
  color: #f59e0b;
}

.hist-change--deleted {
  background: color-mix(in srgb, #ef4444 12%, transparent);
  color: #fca5a5;
}
.hist-change--deleted .hist-change-icon {
  color: #ef4444;
}

.hist-change--toggled {
  background: color-mix(in srgb, #6366f1 12%, transparent);
  color: #a5b4fc;
}
.hist-change--toggled .hist-change-icon {
  color: #6366f1;
}

/* ── Snapshot Detail ── */
.hist-snapshot-detail {
  margin-top: 0.75rem;
}

.hist-sub-title {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
}

.hist-detail-block {
  border-radius: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 6%, rgba(0, 0, 0, 0.1));
  padding: 0.5rem 0.65rem;
  margin-bottom: 0.4rem;
}

.hist-detail-block strong {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 75%, transparent);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.hist-detail-block pre {
  margin: 0.3rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.7rem;
  line-height: 1.5;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 65%, transparent);
  font-family: 'Fira Code', 'Consolas', monospace;
  max-height: 8rem;
  overflow: auto;
}

.hist-enabled-dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ew-danger, #ef4444) 60%, transparent);
}
.hist-enabled-dot[data-enabled='1'] {
  background: var(--ew-success, #22c55e);
}

/* ── Actions ── */
.hist-modal-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent);
}

/* ── Compare ── */
.hist-compare-select {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.82rem;
  color: var(--SmartThemeBodyColor);
}

.hist-select {
  flex: 1;
  min-width: 0;
  border-radius: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, transparent);
  color: var(--SmartThemeBodyColor);
  font-size: 0.8rem;
  padding: 0.35rem 0.5rem;
}

.hist-diff-view {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.hist-diff-col {
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 5%, rgba(0, 0, 0, 0.08));
  padding: 0.65rem;
  overflow: hidden;
}

.hist-diff-title {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
}

.hist-diff-entries {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.hist-diff-entry {
  border-radius: 0.4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid transparent;
}

.hist-diff-entry strong {
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 70%, transparent);
}

.hist-diff-entry pre {
  margin: 0.2rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.68rem;
  line-height: 1.4;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
  font-family: 'Fira Code', 'Consolas', monospace;
  max-height: 6rem;
  overflow: auto;
}

.hist-diff--created {
  background: color-mix(in srgb, #22c55e 10%, transparent);
  border-color: color-mix(in srgb, #22c55e 25%, transparent);
}
.hist-diff--modified {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
  border-color: color-mix(in srgb, #f59e0b 25%, transparent);
}
.hist-diff--deleted {
  background: color-mix(in srgb, #ef4444 10%, transparent);
  border-color: color-mix(in srgb, #ef4444 25%, transparent);
}

/* ── Shared ── */
.hist-empty {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 45%, transparent);
  font-style: italic;
  padding: 0.5rem 0;
}

/* ── Buttons (from App scoped) ── */
.ew-btn {
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);
  color: var(--SmartThemeBodyColor, #edf2f9);
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.4rem 0.85rem;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 0.2s ease;
}
.ew-btn:hover {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px var(--ew-accent-glow);
}
.ew-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
.ew-btn--sm {
  font-size: 0.72rem;
  padding: 0.3rem 0.6rem;
}

/* ── Transition ── */
.hist-modal-enter-active,
.hist-modal-leave-active {
  transition: opacity 0.25s ease;
}
.hist-modal-enter-active .hist-modal-container,
.hist-modal-leave-active .hist-modal-container {
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.hist-modal-enter-from,
.hist-modal-leave-to {
  opacity: 0;
}
.hist-modal-enter-from .hist-modal-container {
  transform: scale(0.95) translateY(10px);
}
.hist-modal-leave-to .hist-modal-container {
  transform: scale(0.95) translateY(10px);
}

/* ── Mobile ── */
@media (max-width: 768px) {
  .hist-modal-overlay {
    padding: 0;
    align-items: stretch;
  }
  .hist-modal-container {
    max-width: 100%;
    max-height: 100vh;
    border-radius: 0;
  }
  .hist-diff-view {
    grid-template-columns: 1fr;
  }
}
</style>
