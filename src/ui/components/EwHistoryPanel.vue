<template>
  <EwSectionCard title="楼层快照时间线" subtitle="每个楼层的 EW 条目变更记录。">
    <div class="hist-toolbar">
      <button type="button" class="ew-btn" :disabled="store.busy" @click="store.loadFloorSnapshots">🔄 刷新</button>
      <button type="button" class="ew-btn" :disabled="store.busy || !selectedTimelineItem" @click="onRebuildSelectedFloor">
        重推导所选楼
      </button>
      <span class="hist-stats"> {{ hasSnapshotCount }} / {{ store.floorSnapshots.length }} 楼层有快照 </span>
      <span class="hist-stats hist-stats--assistant">AI锚点 {{ assistantAnchorCount }}</span>
      <span class="hist-stats hist-stats--source">拦截源楼 {{ sourceFloorCount }}</span>
    </div>

    <div v-if="store.busy" class="hist-info">正在扫描当前聊天的楼层快照…</div>

    <div v-else-if="store.floorSnapshots.length > 0 && hasSnapshotCount === 0" class="hist-info hist-info--warning">
      已扫描到聊天楼层，但没有发现任何可展示快照。除“楼层绑定”与“同步快照”外，也请注意：部分楼层可能被
      <code>run_every_n_floors</code>
      跳过，或当前可见版本与旧快照不匹配。
    </div>

    <div v-if="timelineBuildWarnings.length > 0" class="hist-info hist-info--warning">
      历史时间线中有 {{ timelineBuildWarnings.length }} 个楼层快照格式异常，已自动跳过损坏字段并继续显示其余楼层。
    </div>

    <div v-if="store.floorSnapshots.length > 0" class="hist-grid-wrap">
      <div class="hist-grid">
        <div
          v-for="item in timelineItems"
          :key="item.floor.messageId"
          class="hist-block"
          :data-has-snapshot="item.floor.snapshot ? '1' : '0'"
          :data-has-execution="item.has_execution ? '1' : '0'"
          :data-semantic="item.semantic.anchor_kind"
          :data-selected="selectedFloorId === item.floor.messageId ? '1' : '0'"
          role="button"
          tabindex="0"
          :title="`查看楼层 #${item.floor.messageId} 的快照详情`"
          @click="openFloor(item.floor.messageId)"
          @keydown.enter.prevent="openFloor(item.floor.messageId)"
          @keydown.space.prevent="openFloor(item.floor.messageId)"
        >
          <div class="hist-block-head">
            <div class="hist-block-head-main">
              <div class="hist-block-topline">
                <span class="hist-block-floor">#{{ item.floor.messageId }}</span>
                <span class="hist-role-chip" :class="`hist-role-chip--${item.semantic.role}`">
                  {{ roleLabel(item.semantic.role) }}
                </span>
              </div>
              <div class="hist-block-badges">
                <span
                  v-if="item.semantic.anchor_kind === 'assistant_anchor'"
                  class="hist-anchor-chip hist-anchor-chip--assistant"
                >
                  AI锚点
                </span>
                <span v-else-if="item.semantic.anchor_kind === 'source_user'" class="hist-anchor-chip hist-anchor-chip--source">
                  拦截源楼
                </span>
                <span v-if="item.semantic.rederive" class="hist-anchor-chip hist-anchor-chip--rederive">
                  {{ item.semantic.rederive.legacy_approx ? '重推导(approx)' : '重推导(exact)' }}
                </span>
              </div>
            </div>
            <div class="hist-block-head-side">
              <span class="hist-block-status" :class="statusClass(item)" :title="resolutionTitle(item)">
                {{ resolutionLabel(item) }}
              </span>
              <button type="button" class="hist-block-preview-btn" @click.stop="openFloor(item.floor.messageId)">
                预览
              </button>
            </div>
          </div>
          <div v-if="item.floor.snapshot" class="hist-block-changes">
            <span v-if="item.diff.created.length" class="hist-tag hist-tag--created">
              +{{ item.diff.created.length }}
            </span>
            <span v-if="item.diff.modified.length" class="hist-tag hist-tag--modified">
              ~{{ item.diff.modified.length }}
            </span>
            <span v-if="item.diff.deleted.length" class="hist-tag hist-tag--deleted">
              −{{ item.diff.deleted.length }}
            </span>
            <span v-if="item.diff.toggled.length" class="hist-tag hist-tag--toggled">
              ⇄{{ item.diff.toggled.length }}
            </span>
            <span v-if="Object.keys(item.diff.controllersChanged).length" class="hist-tag hist-tag--modified">
              ≈C{{ Object.keys(item.diff.controllersChanged).length }}
            </span>
          </div>
          <div v-else-if="item.semantic.anchor_kind === 'source_user'" class="hist-block-empty" :title="resolutionTitle(item)">
            对应 AI 楼 #{{ item.semantic.paired_message_id ?? '?' }}
          </div>
          <div v-else class="hist-block-empty" :title="resolutionTitle(item)">
            {{ resolutionLabel(item) }}
          </div>
        </div>
      </div>
    </div>
    <div v-else class="hist-empty">暂无楼层数据。点击「刷新」加载。</div>
  </EwSectionCard>

  <EwFloorDetailModal
    :visible="modalVisible"
    :floor-id="selectedFloorId"
    :snapshot="selectedSnapshot"
    :prev-snapshot="selectedPrevSnapshot"
    :resolution="selectedFloor?.resolution ?? 'missing'"
    :available-version-count="selectedFloor?.available_version_count ?? 0"
    :snapshot-source="selectedFloor?.source ?? 'none'"
    :matched-version-key="selectedFloor?.matched_version_key"
    :file-name="selectedFloor?.file_name"
    :execution="selectedFloor?.execution"
    :anchor-kind="selectedSemantic?.anchor_kind ?? 'normal'"
    :paired-message-id="selectedSemantic?.paired_message_id"
    :message-role="selectedSemantic?.role ?? 'other'"
    @close="closeFloorModal"
  />
</template>

<script setup lang="ts">
import { getChatMessages } from '../../runtime/compat/character';
import { diffSnapshots, type FloorSnapshotReadResolution, type SnapshotDiff } from '../../runtime/floor-binding';
import { upgradeSnapshotData, type SnapshotData } from '../../runtime/snapshot-storage';
import { useEwStore } from '../store';
import EwFloorDetailModal from './EwFloorDetailModal.vue';
import EwSectionCard from './EwSectionCard.vue';

const store = useEwStore();
const modalVisible = ref(false);
const selectedFloorId = ref(0);
const EW_BEFORE_REPLY_BINDING_META_KEY = 'ew_before_reply_binding';
const EW_REDERIVE_META_KEY = 'ew_rederive_meta';
let openFloorFrame: number | null = null;

type FloorSnapshotItem = (typeof store.floorSnapshots)[number];
type FloorRole = 'assistant' | 'user' | 'other';
type FloorAnchorKind = 'assistant_anchor' | 'source_user' | 'legacy_user_anchor' | 'normal';
type TimelineSemantic = {
  role: FloorRole;
  anchor_kind: FloorAnchorKind;
  paired_message_id?: number;
  rederive?: {
    legacy_approx: boolean;
    conflicts: number;
  };
};
type TimelineItem = {
  floor: FloorSnapshotItem;
  diff: SnapshotDiff;
  semantic: TimelineSemantic;
  has_execution: boolean;
};
type FloorExecutionRecord = NonNullable<FloorSnapshotItem['execution']>;
type TimelineBuildResult = {
  items: TimelineItem[];
  warnings: string[];
};

function normalizeRole(raw: unknown): FloorRole {
  if (raw === 'assistant') {
    return 'assistant';
  }
  if (raw === 'user') {
    return 'user';
  }
  return 'other';
}

function normalizeBindingMeta(raw: unknown):
  | {
      role: 'source' | 'assistant_anchor' | 'legacy_user_anchor';
      paired_message_id?: number;
    }
  | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const meta = raw as Record<string, unknown>;
  const role =
    meta.role === 'source' || meta.role === 'assistant_anchor' || meta.role === 'legacy_user_anchor' ? meta.role : null;
  if (!role) {
    return null;
  }
  const paired = Number(meta.paired_message_id);
  return {
    role,
    paired_message_id: Number.isFinite(paired) ? paired : undefined,
  };
}

function normalizeRederiveMeta(raw: unknown): { legacy_approx: boolean; conflicts: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const meta = raw as Record<string, unknown>;
  return {
    legacy_approx: Boolean(meta.legacy_approx),
    conflicts: Math.max(0, Math.trunc(Number(meta.conflicts ?? 0) || 0)),
  };
}

function pushTimelineWarning(warnings: string[], messageId: number, detail: string) {
  warnings.push(`楼层 #${messageId}: ${detail}`);
}

function normalizeFloorResolution(
  raw: unknown,
  messageId: number,
  warnings: string[],
): FloorSnapshotReadResolution {
  if (
    raw === 'exact' ||
    raw === 'single_fallback' ||
    raw === 'same_swipe_fallback' ||
    raw === 'latest_fallback' ||
    raw === 'missing'
  ) {
    return raw;
  }
  pushTimelineWarning(warnings, messageId, '快照解析状态异常，已按“缺失”处理。');
  return 'missing';
}

function normalizeExecutionRecord(raw: unknown): FloorExecutionRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  if (record.execution_status !== 'executed' && record.execution_status !== 'skipped') {
    return undefined;
  }

  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map(item => String(item ?? '').trim())
          .filter(Boolean)
      : [];

  return {
    execution_status: record.execution_status,
    skip_reason: typeof record.skip_reason === 'string' ? record.skip_reason : undefined,
    attempted_flow_ids: toStringArray(record.attempted_flow_ids),
    failed_flow_ids: toStringArray(record.failed_flow_ids),
    workflow_failed: Boolean(record.workflow_failed),
  };
}

function sanitizeSnapshotData(raw: unknown, messageId: number, warnings: string[]): SnapshotData | null {
  if (raw == null) {
    return null;
  }

  const upgraded = upgradeSnapshotData(raw);
  if (upgraded) {
    return upgraded;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    pushTimelineWarning(warnings, messageId, '快照结构异常，已忽略该楼层快照。');
    return null;
  }

  const snapshot = raw as Record<string, unknown>;
  const dynEntries = Array.isArray(snapshot.dyn_entries)
    ? (snapshot.dyn_entries.filter(entry => entry && typeof entry === 'object') as SnapshotData['dyn_entries'])
    : [];
  const controllers = Array.isArray(snapshot.controllers)
    ? snapshot.controllers
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => {
          const record = entry as Record<string, unknown>;
          return {
            entry_name: String(record.entry_name ?? '').trim(),
            content: String(record.content ?? ''),
            flow_id: typeof record.flow_id === 'string' ? record.flow_id : undefined,
            flow_name: typeof record.flow_name === 'string' ? record.flow_name : undefined,
            legacy: Boolean(record.legacy),
          };
        })
    : [];

  pushTimelineWarning(warnings, messageId, '快照字段不完整，已按兼容模式修复展示。');
  return {
    controllers,
    dyn_entries: dynEntries,
    swipe_id: typeof snapshot.swipe_id === 'number' ? snapshot.swipe_id : undefined,
    content_hash: typeof snapshot.content_hash === 'string' ? snapshot.content_hash : undefined,
  };
}

function sanitizeFloorSnapshot(
  floor: FloorSnapshotItem,
  index: number,
  warnings: string[],
): FloorSnapshotItem {
  const rawMessageId = Number(floor?.messageId);
  const messageId = Number.isFinite(rawMessageId) && rawMessageId >= 0 ? rawMessageId : index;
  if (messageId !== rawMessageId) {
    pushTimelineWarning(warnings, messageId, '楼层编号异常，已按顺序位置兼容显示。');
  }

  return {
    ...floor,
    messageId,
    snapshot: sanitizeSnapshotData(floor?.snapshot ?? null, messageId, warnings),
    resolution: normalizeFloorResolution(floor?.resolution, messageId, warnings),
    available_version_count: Math.max(0, Math.trunc(Number(floor?.available_version_count ?? 0) || 0)),
    source: floor?.source === 'file' || floor?.source === 'inline' ? floor.source : 'none',
    matched_version_key: typeof floor?.matched_version_key === 'string' ? floor.matched_version_key : undefined,
    file_name: typeof floor?.file_name === 'string' ? floor.file_name : undefined,
    execution: normalizeExecutionRecord((floor as { execution?: unknown }).execution),
  };
}

function readFloorRuntimeMeta(messageId: number, warnings: string[]) {
  try {
    const message = getChatMessages(messageId)[0];
    return {
      role: normalizeRole(message?.role),
      binding_meta: normalizeBindingMeta(message?.data?.[EW_BEFORE_REPLY_BINDING_META_KEY]),
      rederive_meta: normalizeRederiveMeta(message?.data?.[EW_REDERIVE_META_KEY]),
    };
  } catch (error) {
    console.warn(`[Evolution World] history runtime metadata read failed for floor #${messageId}:`, error);
    pushTimelineWarning(warnings, messageId, '消息元数据读取失败，已按普通楼层显示。');
    return {
      role: 'other' as FloorRole,
      binding_meta: null,
      rederive_meta: null,
    };
  }
}

onMounted(() => {
  void store.loadFloorSnapshots();
});

const selectedTimelineItem = computed(() => timelineItems.value.find(item => item.floor.messageId === selectedFloorId.value));
const selectedFloor = computed(() => selectedTimelineItem.value?.floor);
const selectedSemantic = computed(() => selectedTimelineItem.value?.semantic);

const selectedSnapshot = computed<SnapshotData | null>(() => {
  return selectedFloor.value?.snapshot ?? null;
});

const selectedPrevSnapshot = computed<SnapshotData | null>(() => {
  const idx = timelineItems.value.findIndex(item => item.floor.messageId === selectedFloorId.value);
  if (idx <= 0) return null;

  for (let i = idx - 1; i >= 0; i--) {
    if (timelineItems.value[i].floor.snapshot) {
      return timelineItems.value[i].floor.snapshot;
    }
  }
  return null;
});

const emptyDiff: SnapshotDiff = { created: [], modified: [], deleted: [], toggled: [], controllersChanged: {} };
const timelineBuildResult = computed<TimelineBuildResult>(() => {
  const items: TimelineItem[] = [];
  const warnings: string[] = [];
  let previousSnapshot: SnapshotData | null = null;

  for (let index = 0; index < store.floorSnapshots.length; index += 1) {
    const floor = sanitizeFloorSnapshot(store.floorSnapshots[index], index, warnings);
    const currentSnapshot = floor.snapshot;
    let diff = emptyDiff;
    try {
      diff = diffSnapshots(previousSnapshot, currentSnapshot) ?? emptyDiff;
    } catch (error) {
      console.warn(`[Evolution World] history timeline diff failed for floor #${floor.messageId}:`, error);
      pushTimelineWarning(warnings, floor.messageId, '快照差异计算失败，已降级显示该楼层。');
    }

    const runtimeMeta = readFloorRuntimeMeta(floor.messageId, warnings);
    const role = runtimeMeta.role;
    const bindingMeta = runtimeMeta.binding_meta;
    const rederiveMeta = runtimeMeta.rederive_meta;
    const hasExecution = Boolean(floorExecutionMap.value.get(floor.messageId));
    const hasSnapshot = Boolean(currentSnapshot);

    let semantic: TimelineSemantic = {
      role,
      anchor_kind: 'normal',
      rederive: rederiveMeta ?? undefined,
    };

    if (bindingMeta?.role === 'assistant_anchor' && role === 'assistant') {
      semantic = {
        role,
        anchor_kind: 'assistant_anchor',
        paired_message_id: bindingMeta.paired_message_id,
      };
    } else if (bindingMeta?.role === 'legacy_user_anchor' && role === 'user') {
      semantic = {
        role,
        anchor_kind: 'legacy_user_anchor',
      };
    } else if (bindingMeta?.role === 'source' && role === 'user') {
      semantic = {
        role,
        anchor_kind: 'source_user',
        paired_message_id: bindingMeta.paired_message_id,
      };
    } else if (role === 'assistant' && hasSnapshot) {
      semantic = {
        role,
        anchor_kind: 'assistant_anchor',
      };
    } else if (role === 'user' && hasSnapshot) {
      semantic = {
        role,
        anchor_kind: 'legacy_user_anchor',
      };
    } else if (role === 'user') {
      const nextFloor = store.floorSnapshots[index + 1];
      const nextRuntimeMeta = nextFloor ? floorRuntimeMap.value.get(nextFloor.messageId) : null;
      const nextRole = nextRuntimeMeta?.role ?? 'other';
      const nextHasSnapshot = Boolean(nextFloor?.snapshot);
      if (nextFloor && nextRole === 'assistant' && nextHasSnapshot) {
        semantic = {
          role,
          anchor_kind: 'source_user',
          paired_message_id: nextFloor.messageId,
        };
      }
    }

    items.push({ floor, diff, semantic, has_execution: hasExecution });
    if (currentSnapshot) {
      previousSnapshot = currentSnapshot;
    }
  }

  return {
    items,
    warnings: [...new Set(warnings)],
  };
});

const timelineItems = computed(() => timelineBuildResult.value.items);
const timelineBuildWarnings = computed(() => timelineBuildResult.value.warnings);
const hasSnapshotCount = computed(() => timelineItems.value.filter(item => item.floor.snapshot !== null).length);

const assistantAnchorCount = computed(
  () => timelineItems.value.filter(item => item.semantic.anchor_kind === 'assistant_anchor' && item.floor.snapshot).length,
);
const sourceFloorCount = computed(
  () => timelineItems.value.filter(item => item.semantic.anchor_kind === 'source_user').length,
);

const floorExecutionMap = computed(() => {
  const result = new Map<number, FloorExecutionRecord>();

  for (const floor of store.floorSnapshots) {
    const execution = normalizeExecutionRecord((floor as { execution?: unknown }).execution);
    if (!execution) {
      continue;
    }
    result.set(floor.messageId, execution);
  }

  return result;
});

const resolutionMeta = {
  exact: {
    label: '精确',
    title: '当前可见版本与该楼快照精确匹配。',
    tone: 'exact',
  },
  single_fallback: {
    label: '单版回退',
    title: '当前版本未命中，但该楼只有一个快照版本，因此直接展示该版本；允许用于受控写回。',
    tone: 'fallback',
  },
  same_swipe_fallback: {
    label: '同划回退',
    title: '当前版本未精确命中，但命中了同一 swipe 的其他版本快照；允许用于受控写回。',
    tone: 'fallback',
  },
  latest_fallback: {
    label: '最新回退',
    title: '当前版本未命中，历史面板已回退展示该楼最近可用的快照版本；该来源只用于显示，默认不会参与危险写回。',
    tone: 'fallback',
  },
  missing: {
    label: '缺失',
    title: '当前楼没有可展示快照；可能是本楼未触发、被跳过，或快照确实缺失。',
    tone: 'missing',
  },
  skipped: {
    label: '已跳过',
    title: '该楼存在 after-reply 执行记录，但本轮因自动触发间隔或无匹配工作流而跳过。',
    tone: 'skipped',
  },
  executed_empty: {
    label: '空快照',
    title: '该楼工作流已执行成功，但当时受管条目为空，所以没有可见条目差异。',
    tone: 'fallback',
  },
} as const;

function resolutionLabel(item: TimelineItem): string {
  if (item.semantic.anchor_kind === 'source_user') {
    return '源楼';
  }
  if (item.semantic.anchor_kind === 'legacy_user_anchor') {
    return '旧锚点';
  }

  const execution = floorExecutionMap.value.get(item.floor.messageId);
  if (!item.floor.snapshot && execution?.execution_status === 'skipped') {
    return resolutionMeta.skipped.label;
  }
  if (
    !item.floor.snapshot &&
    execution?.execution_status === 'executed' &&
    !execution.workflow_failed &&
    (execution.attempted_flow_ids?.length ?? 0) > 0
  ) {
    return resolutionMeta.executed_empty.label;
  }
  return resolutionMeta[item.floor.resolution].label;
}

function resolutionTitle(item: TimelineItem): string {
  if (item.semantic.anchor_kind === 'source_user') {
    const targetText = item.semantic.paired_message_id ? `主快照锚点在 AI 楼 #${item.semantic.paired_message_id}。` : '';
    return `该楼是 before_reply 的拦截源楼，本身不作为主快照锚点展示。${targetText}`;
  }
  if (item.semantic.anchor_kind === 'legacy_user_anchor') {
    return '该楼是历史遗留的 user 快照锚点。当前语义以 assistant 楼为主锚点，建议刷新后以 AI 楼记录为准。';
  }

  const execution = floorExecutionMap.value.get(item.floor.messageId);
  if (!item.floor.snapshot && execution?.execution_status === 'skipped') {
    const reasonText = execution.skip_reason ? `跳过原因：${execution.skip_reason}。` : '';
    return `${resolutionMeta.skipped.title}${reasonText}`;
  }
  if (
    !item.floor.snapshot &&
    execution?.execution_status === 'executed' &&
    !execution.workflow_failed &&
    (execution.attempted_flow_ids?.length ?? 0) > 0
  ) {
    return `${resolutionMeta.executed_empty.title}这通常说明这是一个“空基线”楼层，而不是工作流没跑。`;
  }

  const sourceText =
    item.floor.source === 'file' ? '来源：文件快照。' : item.floor.source === 'inline' ? '来源：消息内联快照。' : '';
  const versionText =
    item.floor.available_version_count > 0 ? `可用版本数：${item.floor.available_version_count}。` : '';
  const rederiveText = item.semantic.rederive
    ? `最近一次重推导：${item.semantic.rederive.legacy_approx ? 'approx' : 'exact'}；冲突=${item.semantic.rederive.conflicts}。`
    : '';
  return `${resolutionMeta[item.floor.resolution].title}${sourceText}${versionText}${rederiveText}`;
}

function statusClass(item: TimelineItem): string {
  if (item.semantic.anchor_kind === 'source_user') {
    return 'hist-block-status--source';
  }
  if (item.semantic.anchor_kind === 'legacy_user_anchor') {
    return 'hist-block-status--legacy';
  }

  const execution = floorExecutionMap.value.get(item.floor.messageId);
  if (!item.floor.snapshot && execution?.execution_status === 'skipped') {
    return `hist-block-status--${resolutionMeta.skipped.tone}`;
  }
  if (
    !item.floor.snapshot &&
    execution?.execution_status === 'executed' &&
    !execution.workflow_failed &&
    (execution.attempted_flow_ids?.length ?? 0) > 0
  ) {
    return `hist-block-status--${resolutionMeta.executed_empty.tone}`;
  }
  return `hist-block-status--${resolutionMeta[item.floor.resolution].tone}`;
}

function roleLabel(role: FloorRole): string {
  if (role === 'assistant') {
    return 'AI';
  }
  if (role === 'user') {
    return 'User';
  }
  return 'Other';
}

function openFloor(messageId: number) {
  selectedFloorId.value = messageId;
  modalVisible.value = false;
  if (openFloorFrame !== null) {
    cancelAnimationFrame(openFloorFrame);
  }
  openFloorFrame = requestAnimationFrame(() => {
    modalVisible.value = true;
    openFloorFrame = null;
  });
}

function closeFloorModal() {
  modalVisible.value = false;
}

onBeforeUnmount(() => {
  if (openFloorFrame !== null) {
    cancelAnimationFrame(openFloorFrame);
    openFloorFrame = null;
  }
});

watch(
  timelineItems,
  items => {
    if (items.length === 0) {
      selectedFloorId.value = 0;
      return;
    }

    if (!items.some(item => item.floor.messageId === selectedFloorId.value)) {
      selectedFloorId.value = items[0].floor.messageId;
    }
  },
  { immediate: true },
);

async function onRebuildSelectedFloor() {
  const item = selectedTimelineItem.value;
  if (!item) {
    return;
  }

  const timing: 'before_reply' | 'after_reply' | 'manual' =
    item.semantic.role === 'assistant' ? 'after_reply' : item.semantic.role === 'user' ? 'before_reply' : 'manual';
  const result = await store.rederiveFloorWorkflow(item.floor.messageId, timing);
  if (!result.ok && result.reason && result.reason !== 'cancelled_by_user') {
    console.warn('[Evolution World] rederive failed:', result.reason);
  }
}
</script>

<style scoped>
.hist-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.hist-stats {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
}
.hist-stats--assistant {
  color: #86efac;
}
.hist-stats--source {
  color: #93c5fd;
}

.hist-info {
  margin-bottom: 0.75rem;
  padding: 0.65rem 0.8rem;
  border-radius: 0.65rem;
  font-size: 0.78rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 22%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 10%, rgba(0, 0, 0, 0.08));
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 75%, transparent);
}

.hist-info--warning {
  border-color: color-mix(in srgb, #f59e0b 35%, transparent);
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: color-mix(in srgb, #fcd34d 88%, white 12%);
}

/* ── Grid ── */
.hist-grid-wrap {
  max-height: calc(4 * 5.5rem + 3 * 0.4rem);
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}

.hist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 0.4rem;
}

.hist-block-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.45rem;
}

.hist-block-head-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.22rem;
  min-width: 0;
  flex: 1 1 auto;
}

.hist-block-topline,
.hist-block-badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  min-width: 0;
}

.hist-block-head-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.22rem;
  flex-shrink: 0;
}

.hist-block {
  border-radius: 0.65rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 25%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, rgba(0, 0, 0, 0.12));
  padding: 0.5rem;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    transform 0.15s ease,
    box-shadow 0.2s ease;
  min-height: 4.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.hist-block:hover {
  border-color: color-mix(in srgb, var(--ew-accent, #818cf8) 50%, transparent);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ew-accent, #818cf8) 15%, transparent);
}

.hist-block:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ew-accent, #818cf8) 70%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ew-accent, #818cf8) 80%, transparent),
    0 6px 16px color-mix(in srgb, var(--ew-accent, #818cf8) 18%, transparent);
}

.hist-block[data-selected='1'] {
  border-color: color-mix(in srgb, #f59e0b 65%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, #f59e0b 60%, transparent);
}

.hist-block[data-has-snapshot='0'][data-has-execution='0'][data-semantic='normal'] {
  opacity: 0.4;
}

.hist-block-floor {
  font-size: 0.75rem;
  font-weight: 700;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
}

.hist-role-chip,
.hist-anchor-chip {
  flex-shrink: 0;
  font-size: 0.55rem;
  font-weight: 700;
  line-height: 1.2;
  padding: 0.12rem 0.3rem;
  border-radius: 999px;
  border: 1px solid transparent;
}

.hist-role-chip--assistant {
  color: #bbf7d0;
  border-color: color-mix(in srgb, #16a34a 35%, transparent);
  background: color-mix(in srgb, #16a34a 14%, transparent);
}

.hist-role-chip--user {
  color: #bfdbfe;
  border-color: color-mix(in srgb, #2563eb 35%, transparent);
  background: color-mix(in srgb, #2563eb 14%, transparent);
}

.hist-role-chip--other {
  color: #d1d5db;
  border-color: color-mix(in srgb, #6b7280 35%, transparent);
  background: color-mix(in srgb, #6b7280 16%, transparent);
}

.hist-anchor-chip--assistant {
  color: #86efac;
  border-color: color-mix(in srgb, #22c55e 35%, transparent);
  background: color-mix(in srgb, #22c55e 14%, transparent);
}

.hist-anchor-chip--source {
  color: #93c5fd;
  border-color: color-mix(in srgb, #3b82f6 35%, transparent);
  background: color-mix(in srgb, #3b82f6 14%, transparent);
}

.hist-anchor-chip--rederive {
  color: #fcd34d;
  border-color: color-mix(in srgb, #f59e0b 35%, transparent);
  background: color-mix(in srgb, #f59e0b 16%, transparent);
}

.hist-block-status {
  flex-shrink: 0;
  font-size: 0.56rem;
  font-weight: 700;
  line-height: 1.2;
  padding: 0.12rem 0.3rem;
  border-radius: 999px;
  border: 1px solid transparent;
}

.hist-block-preview-btn {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 30%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 12%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 68%, transparent);
  font-size: 0.58rem;
  line-height: 1.2;
  padding: 0.12rem 0.38rem;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    color 0.2s ease;
}

.hist-block-preview-btn:hover,
.hist-block-preview-btn:focus-visible {
  outline: none;
  color: #fff;
  border-color: color-mix(in srgb, var(--ew-accent, #818cf8) 55%, transparent);
  background: color-mix(in srgb, var(--ew-accent, #818cf8) 28%, transparent);
}

.hist-block-status--exact {
  color: #86efac;
  border-color: color-mix(in srgb, #22c55e 35%, transparent);
  background: color-mix(in srgb, #22c55e 16%, transparent);
}

.hist-block-status--fallback {
  color: #c4b5fd;
  border-color: color-mix(in srgb, #8b5cf6 35%, transparent);
  background: color-mix(in srgb, #8b5cf6 15%, transparent);
}

.hist-block-status--missing {
  color: #fca5a5;
  border-color: color-mix(in srgb, #ef4444 35%, transparent);
  background: color-mix(in srgb, #ef4444 15%, transparent);
}

.hist-block-status--skipped {
  color: #fde68a;
  border-color: color-mix(in srgb, #f59e0b 35%, transparent);
  background: color-mix(in srgb, #f59e0b 16%, transparent);
}

.hist-block-status--source {
  color: #93c5fd;
  border-color: color-mix(in srgb, #3b82f6 35%, transparent);
  background: color-mix(in srgb, #3b82f6 14%, transparent);
}

.hist-block-status--legacy {
  color: #fcd34d;
  border-color: color-mix(in srgb, #f59e0b 35%, transparent);
  background: color-mix(in srgb, #f59e0b 14%, transparent);
}

.hist-block-changes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
}

.hist-tag {
  font-size: 0.62rem;
  font-weight: 700;
  padding: 0.1rem 0.35rem;
  border-radius: 0.3rem;
  line-height: 1.3;
}

.hist-tag--created {
  background: color-mix(in srgb, #22c55e 20%, transparent);
  color: #86efac;
}
.hist-tag--modified {
  background: color-mix(in srgb, #f59e0b 20%, transparent);
  color: #fcd34d;
}
.hist-tag--deleted {
  background: color-mix(in srgb, #ef4444 20%, transparent);
  color: #fca5a5;
}
.hist-tag--toggled {
  background: color-mix(in srgb, #6366f1 20%, transparent);
  color: #a5b4fc;
}

.hist-block-empty {
  font-size: 0.7rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 30%, transparent);
}

.hist-empty {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 45%, transparent);
  font-style: italic;
  padding: 0.5rem 0;
}

/* ── Buttons ── */
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

/* ── Mobile ── */
@media (max-width: 768px) {
  .hist-toolbar {
    gap: 0.45rem;
  }
  .hist-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .hist-block {
    min-height: 4rem;
    padding: 0.35rem;
  }
  .hist-block-floor {
    font-size: 0.68rem;
  }
  .hist-block-head {
    gap: 0.3rem;
  }
  .hist-block-head-side {
    gap: 0.16rem;
  }
  .hist-tag {
    font-size: 0.58rem;
  }
}
</style>
