<template>
  <!-- ── A. 操作区 ── -->
  <EwSectionCard title="调试操作" subtitle="手动执行、语法校验与快速回滚。">
    <div class="ew-actions-wrap">
      <button type="button" class="ew-btn" :disabled="store.busy" @click="store.runManual(manualMessage)">
        ▶ 手动运行
      </button>
      <button type="button" class="ew-btn" :disabled="store.busy" @click="store.validateControllerSyntax">
        🔍 控制器语法校验
      </button>
      <button type="button" class="ew-btn ew-btn--danger" :disabled="store.busy" @click="store.rollbackController">
        ↩ 回滚控制器
      </button>
    </div>

    <EwFieldRow label="手动运行输入" :help="help('manual_message')">
      <textarea v-model="manualMessage" rows="3" placeholder="留空将使用最新楼层文本" />
    </EwFieldRow>
  </EwSectionCard>

  <!-- ── B. Prompt 预览区 ── -->
  <EwSectionCard
    v-model="promptSectionOpen"
    title="Prompt 预览"
    subtitle="预览工作流 AI 实际接收的完整 messages 数组。"
    collapsible
  >
    <template v-if="promptSectionOpen">
      <div class="dbg-toolbar">
        <select v-model="store.previewFlowId" class="dbg-flow-select">
          <option value="">自动选择</option>
          <option v-for="flow in allFlows" :key="flow.id" :value="flow.id">
            {{ flow.name || flow.id }}
          </option>
        </select>
        <button type="button" class="ew-btn" :disabled="store.busy" @click="store.loadPromptPreview">
          📝 生成预览
        </button>
      </div>

      <div v-if="store.promptPreview && store.promptPreview.length > 0" class="dbg-messages">
        <div class="dbg-msg-count">
          共 {{ store.promptPreview.length }} 条消息，当前渲染 {{ visiblePromptMessages.length }} 条
        </div>
        <div
          v-for="entry in visiblePromptMessages"
          :key="entry.originalIndex"
          class="dbg-msg-card"
          :data-role="entry.role"
          :data-debug-only="entry.debugOnly ? '1' : '0'"
        >
          <div class="dbg-msg-header" @click="toggleMsgExpand(entry.originalIndex)">
            <span class="dbg-role-badge" :data-role="entry.role">{{ entry.role }}</span>
            <span v-if="entry.previewTitle" class="dbg-marker-title">{{ entry.previewTitle }}</span>
            <span v-if="entry.name" class="dbg-msg-name">{{ entry.name }}</span>
            <span class="dbg-msg-idx">#{{ entry.originalIndex }}</span>
            <span class="dbg-msg-len">{{ entry.content.length }} chars</span>
            <span class="dbg-expand-icon">{{ expandedMsgs.has(entry.originalIndex) ? '▼' : '▶' }}</span>
          </div>
          <div v-if="expandedMsgs.has(entry.originalIndex)" class="dbg-msg-body">
            <pre v-html="highlightEwTags(entry.content)"></pre>
          </div>
          <div v-else class="dbg-msg-preview">
            <span v-html="entry.previewHtml"></span>
          </div>
        </div>
        <div v-if="hasMorePromptMessages" class="dbg-actions">
          <button type="button" class="ew-btn" @click="showAllPromptMessages">
            显示剩余 {{ store.promptPreview.length - visiblePromptMessages.length }} 条
          </button>
        </div>
      </div>
      <div v-else-if="store.promptPreview" class="dbg-empty">没有生成任何消息。请检查工作流配置。</div>
    </template>
  </EwSectionCard>

  <!-- ── C. 快照检视区 ── -->
  <EwSectionCard
    v-model="snapshotSectionOpen"
    title="快照状态"
    subtitle="当前聊天的最新 EW 快照（Controller + Dyn 条目）。"
    collapsible
  >
    <template v-if="snapshotSectionOpen">
      <div class="dbg-toolbar">
        <button type="button" class="ew-btn" :disabled="store.busy" @click="store.loadSnapshotPreview">
          📸 读取快照
        </button>
      </div>

      <div v-if="store.snapshotPreview" class="dbg-snapshot">
        <!-- Controller -->
        <div class="dbg-snap-section">
          <h4 class="dbg-snap-label">
            Controller ({{ controllerEntries.length }})
            <span class="dbg-snap-status" :data-ok="controllerEntries.length ? '1' : '0'">
              {{ controllerEntries.length ? '✅ 有内容' : '❌ 空' }}
            </span>
          </h4>
          <div v-if="controllerEntries.length > 0" class="dbg-snap-table-wrap">
            <table class="dbg-snap-table">
              <thead>
                <tr>
                  <th>工作流</th>
                  <th>条目名</th>
                  <th>内容摘要</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="controller in controllerEntries"
                  :key="controller.entry_name || controller.flow_id || controller.flow_name"
                >
                  <td class="dbg-snap-name">{{ controller.flow_name || controller.flow_id || 'Legacy' }}</td>
                  <td class="dbg-snap-name">{{ controller.entry_name || '待迁移条目' }}</td>
                  <td class="dbg-snap-excerpt">{{ truncate(controller.content, 80) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Dyn Entries -->
        <div class="dbg-snap-section">
          <h4 class="dbg-snap-label">Dyn 条目 ({{ dynEntries.length }})</h4>
          <div v-if="dynEntries.length > 0" class="dbg-snap-table-wrap">
            <table class="dbg-snap-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>名称</th>
                  <th>内容摘要</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="snap in dynEntries" :key="snap.name">
                  <td><span class="dbg-enabled-dot" :data-enabled="snap.enabled ? '1' : '0'" /></td>
                  <td class="dbg-snap-name">{{ snap.name }}</td>
                  <td class="dbg-snap-excerpt">{{ truncate(snap.content, 80) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="dbg-empty">没有 Dyn 条目。</div>
        </div>
      </div>
    </template>
  </EwSectionCard>

  <!-- ── D. 运行日志区 ── -->
  <EwSectionCard v-model="logSectionOpen" title="运行记录" subtitle="最近一次执行的结构化摘要。" collapsible>
    <template v-if="logSectionOpen">
      <div class="dbg-toolbar">
        <button type="button" class="ew-btn" :disabled="store.busy" @click="store.refreshDebugRecords">
          刷新记录
        </button>
        <span v-if="lastRunChatMismatch || lastIoChatMismatch" class="dbg-stale-hint">
          当前显示的记录不属于这个聊天，已为你保留但建议先刷新确认。
        </span>
      </div>

      <!-- Run Summary -->
      <div v-if="store.lastRun" class="dbg-run-summary">
        <div class="dbg-run-header">
          <span class="dbg-status-badge" :data-ok="store.lastRun.ok ? '1' : '0'">
            {{ store.lastRun.ok ? '✅ 成功' : '❌ 失败' }}
          </span>
          <span class="dbg-run-meta">
            {{ store.lastRun.mode === 'manual' ? '手动' : '自动' }}
            · {{ store.lastRun.flow_count }} 工作流 · {{ store.lastRun.elapsed_ms }}ms
          </span>
          <span class="dbg-run-time">{{ formatTime(store.lastRun.at) }}</span>
        </div>
        <div v-if="store.lastRun.chat_id" class="dbg-run-chatline">
          聊天：{{ store.lastRun.chat_id }}
          <template v-if="lastRunChatMismatch"> · 当前不是这条记录所属聊天</template>
        </div>
        <div v-if="currentCommitSummary" class="dbg-commit-card">
          <div class="dbg-commit-card__header">
            <strong>写回结果</strong>
            <span class="dbg-commit-pill" :data-scope="currentCommitSummary.write_scope">
              {{ formatWriteScope(currentCommitSummary.write_scope) }}
            </span>
          </div>
          <div class="dbg-commit-grid">
            <span>目标世界书：{{ currentCommitSummary.target_worldbook_name || '(none)' }}</span>
            <span>Dyn 请求：{{ currentCommitSummary.dyn_entries_requested }}</span>
            <span>Dyn 变化：{{ dynCommitChangeCount }}</span>
            <span>Controller 请求：{{ currentCommitSummary.controller_entries_requested }}</span>
            <span>Controller 变化：{{ currentCommitSummary.controller_entries_updated }}</span>
            <span>写后核验：{{ currentCommitSummary.worldbook_verified ? '已通过' : '未执行' }}</span>
          </div>
          <div v-if="commitHintText" class="dbg-commit-hint">{{ commitHintText }}</div>
        </div>
        <div v-if="store.lastRun.failure" class="dbg-failure-card" :data-stage="store.lastRun.failure.stage">
          <div class="dbg-failure-card__header">
            <strong>{{ store.lastRun.failure.summary }}</strong>
            <span class="dbg-failure-pill">{{ formatFailureStage(store.lastRun.failure.stage) }}</span>
          </div>
          <div class="dbg-failure-grid">
            <span v-if="store.lastRun.failure.flow_name || store.lastRun.failure.flow_id">
              工作流：{{ store.lastRun.failure.flow_name || store.lastRun.failure.flow_id }}
            </span>
            <span v-if="store.lastRun.failure.api_preset_name">接口：{{ store.lastRun.failure.api_preset_name }}</span>
            <span>请求ID：{{ store.lastRun.failure.request_id || '未知' }}</span>
            <span>
              结果：{{ store.lastRun.failure.successful_flow_count }}/{{ store.lastRun.failure.attempted_flow_count }}
              成功
              <template v-if="store.lastRun.failure.whole_workflow_failed"> · 整轮失败</template>
              <template v-else-if="store.lastRun.failure.partial_success"> · 局部失败</template>
            </span>
            <span v-if="store.lastRun.failure.http_status">HTTP：{{ store.lastRun.failure.http_status }}</span>
          </div>
          <div v-if="store.lastRun.failure.suggestion" class="dbg-failure-suggestion">
            建议：{{ store.lastRun.failure.suggestion }}
          </div>
          <details class="dbg-failure-detail">
            <summary>查看原始错误详情</summary>
            <pre>{{ store.lastRun.failure.detail }}</pre>
          </details>
        </div>
        <div v-if="!store.lastRun.ok && store.lastRun.reason" class="dbg-run-error">
          {{ store.lastRun.reason }}
        </div>
      </div>
      <div v-else class="dbg-empty">暂无运行记录。</div>

      <!-- Flow IO Summary -->
      <template v-if="store.lastIo && store.lastIo.flows.length > 0">
        <h4 class="dbg-io-title">请求 / 响应详情</h4>
        <div v-if="store.lastIo.chat_id" class="dbg-run-chatline">
          聊天：{{ store.lastIo.chat_id }}
          <template v-if="lastIoChatMismatch"> · 当前不是这条记录所属聊天</template>
        </div>
        <div
          v-for="(flowIo, idx) in store.lastIo.flows"
          :key="idx"
          class="dbg-io-card"
          :data-ok="flowIo.ok ? '1' : '0'"
        >
          <div class="dbg-io-header" @click="toggleIoExpand(idx)">
            <span class="dbg-status-dot" :data-ok="flowIo.ok ? '1' : '0'" />
            <strong>{{ flowIo.flow_name || flowIo.flow_id }}</strong>
            <span class="dbg-io-meta"> {{ flowIo.api_preset_name }} · {{ flowIo.elapsed_ms }}ms </span>
            <span class="dbg-expand-icon">{{ expandedIos.has(idx) ? '▼' : '▶' }}</span>
          </div>
          <div v-if="flowIo.error" class="dbg-io-error">{{ flowIo.error }}</div>
          <div v-if="flowIo.error" class="dbg-io-hint-grid">
            <span>类型：{{ formatFailureKind(flowIo.error_code ?? flowIo.error_kind ?? 'unknown') }}</span>
            <span>阶段：{{ formatFailureStage(flowIo.error_stage) }}</span>
            <span v-if="flowIo.error_status">HTTP：{{ flowIo.error_status }}</span>
          </div>
          <div v-if="flowIo.error_suggestion" class="dbg-io-suggestion">建议：{{ flowIo.error_suggestion }}</div>
          <div v-if="expandedIos.has(idx)" class="dbg-io-body">
            <div class="dbg-io-pair">
              <div class="dbg-io-block">
                <strong>Request</strong>
                <pre>{{ flowIo.request_preview || '(空)' }}</pre>
              </div>
              <div class="dbg-io-block">
                <strong>Response</strong>
                <pre>{{ flowIo.response_preview || '(空)' }}</pre>
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </EwSectionCard>
</template>

<script setup lang="ts">
import { getFieldHelp } from '../help-meta';
import { useEwStore } from '../store';
import { getCurrentChatIdSafe } from '../../st-adapter';
import EwFieldRow from './EwFieldRow.vue';
import EwSectionCard from './EwSectionCard.vue';

const store = useEwStore();
const manualMessage = ref('');

// 区域折叠状态
const promptSectionOpen = ref(true);
const snapshotSectionOpen = ref(false);
const logSectionOpen = ref(true);

// 消息展开状态
const expandedMsgs = ref(new Set<number>());
const expandedIos = ref(new Set<number>());
const promptRenderCount = ref(24);

type DisplayPromptMessage = (typeof store.promptPreview extends Ref<infer T> ? NonNullable<T>[number] : never) & {
  originalIndex: number;
  previewHtml: string;
};

const allFlows = computed(() => [...store.settings.flows, ...store.charFlows]);
const visiblePromptMessages = computed<DisplayPromptMessage[]>(() => {
  return (store.promptPreview ?? []).slice(0, promptRenderCount.value).map((msg, index) => ({
    ...msg,
    originalIndex: index,
    previewHtml: highlightEwTags(truncate(msg.content, msg.debugOnly ? 200 : 120)),
  }));
});
const hasMorePromptMessages = computed(() => (store.promptPreview?.length ?? 0) > visiblePromptMessages.value.length);

const dynEntries = computed(() => {
  if (!store.snapshotPreview) return [];
  return [...store.snapshotPreview.dyn.values()];
});

const controllerEntries = computed(() => store.snapshotPreview?.controllers ?? []);
const currentCommitSummary = computed(() => store.lastRun?.commit ?? null);
const dynCommitChangeCount = computed(() => {
  const commit = currentCommitSummary.value;
  if (!commit) return 0;
  return commit.dyn_entries_created + commit.dyn_entries_updated + commit.dyn_entries_removed;
});
const commitHintText = computed(() => {
  const commit = currentCommitSummary.value;
  if (!commit) {
    return '';
  }

  if (commit.write_scope === 'controller_only' && commit.dyn_entries_requested > 0) {
    return `本轮请求了 ${commit.dyn_entries_requested} 个 Dyn 条目，但最终只有 Controller 仓库发生变化。请重点检查模型返回的 desired_entries 是否真的产生了新内容，或这些 Dyn 条目是否与当前世界书内容完全一致。`;
  }

  if (commit.write_scope === 'none' && commit.target_worldbook_name) {
    return '本轮命中了目标世界书，但没有形成实际写回。';
  }

  return '';
});
const currentChatId = computed(() => getCurrentChatIdSafe());
const lastRunChatMismatch = computed(() => {
  const chatId = store.lastRun?.chat_id?.trim();
  return Boolean(chatId && currentChatId.value && chatId !== currentChatId.value);
});
const lastIoChatMismatch = computed(() => {
  const chatId = store.lastIo?.chat_id?.trim();
  return Boolean(chatId && currentChatId.value && chatId !== currentChatId.value);
});

watch(
  () => store.promptPreview,
  preview => {
    expandedMsgs.value = new Set<number>();
    promptRenderCount.value = Math.min(preview?.length ?? 0, 24);
  },
);

watch(promptSectionOpen, open => {
  if (!open) {
    return;
  }
  if (store.promptPreview?.length) {
    promptRenderCount.value = Math.min(store.promptPreview.length, Math.max(promptRenderCount.value, 24));
  }
});

function help(key: string) {
  return getFieldHelp(key);
}

function toggleMsgExpand(idx: number) {
  const next = new Set(expandedMsgs.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  expandedMsgs.value = next;
}

function toggleIoExpand(idx: number) {
  const next = new Set(expandedIos.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  expandedIos.value = next;
}

function showAllPromptMessages() {
  promptRenderCount.value = store.promptPreview?.length ?? promptRenderCount.value;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

function highlightEwTags(text: string): string {
  // 用强调样式高亮 [EW/xxx] 标签
  return text.replace(/\[([^\]]*(?:EW|Controller|Dyn)[^\]]*)\]/g, '<span class="dbg-ew-tag">[$1]</span>');
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatFailureStage(stage: string): string {
  switch (stage) {
    case 'dispatch':
      return '请求阶段';
    case 'merge':
      return '合并阶段';
    case 'commit':
      return '写回阶段';
    case 'semantic':
      return '语义校验';
    case 'cancelled':
      return '已取消';
    case 'config':
      return '配置阶段';
    default:
      return '未知阶段';
  }
}

function formatFailureKind(kind: string): string {
  switch (kind) {
    case 'worldbook_missing':
      return '未绑定世界书';
    case 'entry_conflict':
      return '条目冲突';
    case 'empty_desired_entry':
      return '条目内容为空';
    case 'response_status_not_ok':
      return '响应状态异常';
    case 'no_effective_write':
      return '没有有效写入';
    case 'http_error':
      return '接口请求失败';
    case 'auth_error':
      return '鉴权失败';
    case 'permission_error':
      return '权限不足';
    case 'not_found':
      return '地址或模型不存在';
    case 'rate_limit':
      return '触发限流';
    case 'tls_error':
      return 'TLS/证书错误';
    case 'connection_reset':
      return '连接被重置';
    case 'timeout':
      return '超时';
    case 'empty_response':
      return '空响应';
    case 'response_parse':
      return 'JSON解析失败';
    case 'regex_extract':
      return '提取正则未命中';
    case 'schema_invalid':
      return '响应结构不合法';
    case 'template_invalid':
      return '模板配置错误';
    case 'config_invalid':
      return '配置错误';
    case 'merge_failed':
      return '结果合并失败';
    case 'commit_failed':
      return '写回失败';
    case 'cancelled':
      return '已取消';
    default:
      return '未知错误';
  }
}

function formatWriteScope(scope: string): string {
  switch (scope) {
    case 'dyn_only':
      return '仅 Dyn 写回';
    case 'controller_only':
      return '仅 Controller 写回';
    case 'dyn_and_controller':
      return 'Dyn + Controller';
    default:
      return '无写回';
  }
}

</script>

<style scoped>
/* ── Toolbar ── */
.dbg-toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.75rem;
}

.dbg-flow-select {
  flex: 1;
  min-width: 0;
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 12%, transparent);
  color: var(--SmartThemeBodyColor, #edf2f9);
  font-size: 0.8rem;
  padding: 0.4rem 0.6rem;
}

/* ── Prompt Messages ── */
.dbg-messages {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.dbg-msg-count {
  font-size: 0.75rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 55%, transparent);
  margin-bottom: 0.25rem;
}

.dbg-msg-card {
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 25%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, rgba(0, 0, 0, 0.15));
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.dbg-msg-card[data-debug-only='1'] {
  border-style: dashed;
  border-color: color-mix(in srgb, #facc15 45%, transparent);
  background: color-mix(in srgb, #facc15 10%, rgba(0, 0, 0, 0.12));
}

.dbg-msg-card:hover {
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 50%, transparent);
}

.dbg-msg-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  user-select: none;
}

.dbg-marker-title {
  font-size: 0.72rem;
  font-weight: 700;
  color: #fde68a;
  background: color-mix(in srgb, #facc15 18%, transparent);
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  flex-shrink: 0;
}

.dbg-role-badge {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  flex-shrink: 0;
}

.dbg-role-badge[data-role='system'] {
  background: color-mix(in srgb, #6366f1 30%, transparent);
  color: #a5b4fc;
}
.dbg-role-badge[data-role='user'] {
  background: color-mix(in srgb, #22c55e 30%, transparent);
  color: #86efac;
}
.dbg-role-badge[data-role='assistant'] {
  background: color-mix(in srgb, #f59e0b 30%, transparent);
  color: #fcd34d;
}

.dbg-msg-name {
  font-size: 0.75rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 70%, transparent);
  font-style: italic;
}

.dbg-msg-idx {
  font-size: 0.7rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 40%, transparent);
  margin-left: auto;
}

.dbg-msg-len {
  font-size: 0.7rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 40%, transparent);
}

.dbg-expand-icon {
  font-size: 0.65rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent);
  width: 1rem;
  text-align: center;
}

.dbg-msg-body {
  padding: 0 0.75rem 0.75rem;
}

.dbg-msg-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  line-height: 1.6;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
  font-family: 'Fira Code', 'Consolas', monospace;
  max-height: 24rem;
  overflow: auto;
}

.dbg-msg-preview {
  padding: 0 0.75rem 0.5rem;
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
  line-height: 1.5;
}

/* ── EW Tag Highlight ── */
:deep(.dbg-ew-tag) {
  color: var(--ew-accent, #818cf8);
  font-weight: 700;
  background: color-mix(in srgb, var(--ew-accent, #818cf8) 15%, transparent);
  padding: 0.05rem 0.35rem;
  border-radius: 0.35rem;
}

/* ── Snapshot ── */
.dbg-snapshot {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.dbg-snap-section {
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 25%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 6%, rgba(0, 0, 0, 0.1));
  padding: 0.75rem;
}

.dbg-snap-label {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 85%, transparent);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.dbg-snap-status {
  font-size: 0.72rem;
  font-weight: 500;
}

.dbg-snap-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  line-height: 1.5;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 70%, transparent);
  font-family: 'Fira Code', 'Consolas', monospace;
  max-height: 12rem;
  overflow: auto;
}

.dbg-snap-table-wrap {
  overflow-x: auto;
}

.dbg-snap-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}

.dbg-snap-table th {
  text-align: left;
  padding: 0.35rem 0.5rem;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
}

.dbg-snap-table td {
  padding: 0.35rem 0.5rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 10%, transparent);
}

.dbg-enabled-dot {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ew-danger, #ef4444) 60%, transparent);
}
.dbg-enabled-dot[data-enabled='1'] {
  background: color-mix(in srgb, var(--ew-success, #22c55e) 70%, transparent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--ew-success, #22c55e) 30%, transparent);
}

.dbg-snap-name {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 0.72rem;
}

.dbg-snap-excerpt {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
}

/* ── Run Summary ── */
.dbg-run-summary {
  margin-bottom: 1rem;
}

.dbg-run-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.dbg-status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
}

.dbg-status-badge[data-ok='1'] {
  background: color-mix(in srgb, var(--ew-success, #22c55e) 20%, transparent);
  color: #86efac;
}
.dbg-status-badge[data-ok='0'] {
  background: color-mix(in srgb, var(--ew-danger, #ef4444) 20%, transparent);
  color: #fca5a5;
}

.dbg-run-meta {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 65%, transparent);
}

.dbg-stale-hint {
  font-size: 0.74rem;
  color: #fde68a;
}

.dbg-run-chatline {
  margin-top: 0.4rem;
  font-size: 0.73rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
}

.dbg-commit-card {
  margin-top: 0.7rem;
  padding: 0.75rem 0.8rem;
  border-radius: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 26%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 8%, rgba(0, 0, 0, 0.12));
}

.dbg-commit-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.55rem;
}

.dbg-commit-pill {
  padding: 0.16rem 0.55rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 90%, transparent);
  font-size: 0.68rem;
  font-weight: 700;
}

.dbg-commit-pill[data-scope='dyn_only'] {
  background: color-mix(in srgb, #3b82f6 20%, transparent);
  color: #bfdbfe;
}

.dbg-commit-pill[data-scope='controller_only'] {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: #fde68a;
}

.dbg-commit-pill[data-scope='dyn_and_controller'] {
  background: color-mix(in srgb, #22c55e 18%, transparent);
  color: #bbf7d0;
}

.dbg-commit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.4rem 0.75rem;
  font-size: 0.73rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 78%, transparent);
}

.dbg-commit-hint {
  margin-top: 0.55rem;
  font-size: 0.74rem;
  line-height: 1.5;
  color: #fde68a;
}

.dbg-run-time {
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 45%, transparent);
  margin-left: auto;
}

.dbg-run-error {
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--ew-danger, #ef4444) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ew-danger, #ef4444) 25%, transparent);
  font-size: 0.75rem;
  color: #fca5a5;
}

.dbg-failure-card {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border-radius: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--ew-danger, #ef4444) 28%, transparent);
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--ew-danger, #ef4444) 10%, transparent),
    rgba(0, 0, 0, 0.08)
  );
}

.dbg-failure-card[data-stage='commit'] {
  border-color: color-mix(in srgb, #f97316 35%, transparent);
}

.dbg-failure-card[data-stage='merge'] {
  border-color: color-mix(in srgb, #eab308 35%, transparent);
}

.dbg-failure-card__header {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
}

.dbg-failure-card__header strong {
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 92%, transparent);
  font-size: 0.82rem;
}

.dbg-failure-pill {
  padding: 0.16rem 0.55rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ew-danger, #ef4444) 18%, transparent);
  color: #fecaca;
  font-size: 0.68rem;
  font-weight: 700;
}

.dbg-failure-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.4rem 0.75rem;
  margin-top: 0.6rem;
  font-size: 0.73rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 75%, transparent);
}

.dbg-failure-suggestion,
.dbg-io-suggestion {
  margin-top: 0.55rem;
  font-size: 0.74rem;
  color: #fde68a;
  line-height: 1.55;
}

.dbg-failure-detail {
  margin-top: 0.65rem;
}

.dbg-failure-detail summary {
  cursor: pointer;
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 58%, transparent);
}

.dbg-failure-detail pre {
  margin: 0.45rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.71rem;
  line-height: 1.55;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 72%, transparent);
  font-family: 'Fira Code', 'Consolas', monospace;
  max-height: 14rem;
  overflow: auto;
}

/* ── IO Cards ── */
.dbg-io-title {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 80%, transparent);
}

.dbg-io-card {
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 25%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 6%, rgba(0, 0, 0, 0.1));
  margin-bottom: 0.5rem;
  overflow: hidden;
}

.dbg-io-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  user-select: none;
}

.dbg-status-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  flex-shrink: 0;
}
.dbg-status-dot[data-ok='1'] {
  background: var(--ew-success, #22c55e);
  box-shadow: 0 0 6px color-mix(in srgb, var(--ew-success, #22c55e) 40%, transparent);
}
.dbg-status-dot[data-ok='0'] {
  background: var(--ew-danger, #ef4444);
}

.dbg-io-meta {
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent);
  margin-left: auto;
}

.dbg-io-error {
  padding: 0.25rem 0.75rem 0.5rem;
  font-size: 0.72rem;
  color: #fca5a5;
}

.dbg-io-hint-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.8rem;
  padding: 0 0.75rem 0.25rem;
  font-size: 0.68rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 58%, transparent);
}

.dbg-io-body {
  padding: 0 0.75rem 0.75rem;
}

.dbg-io-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.dbg-io-block {
  border-radius: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 6%, rgba(0, 0, 0, 0.1));
  padding: 0.5rem;
}

.dbg-io-block strong {
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 65%, transparent);
}

.dbg-io-block pre {
  margin: 0.3rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.7rem;
  line-height: 1.5;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 70%, transparent);
  font-family: 'Fira Code', 'Consolas', monospace;
  max-height: 16rem;
  overflow: auto;
}

/* ── Shared ── */
.dbg-empty {
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 45%, transparent);
  padding: 0.5rem 0;
  font-style: italic;
}

/* ── Buttons (duplicated from App.vue scoped — cannot inherit) ── */
.ew-actions-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

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
    color 0.2s ease,
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 0.2s ease;
}

.ew-btn:hover,
.ew-btn:focus-visible {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px var(--ew-accent-glow);
  outline: none;
}

.ew-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.ew-btn--danger {
  border-color: color-mix(in srgb, var(--ew-danger) 45%, transparent);
  background: color-mix(in srgb, var(--ew-danger) 15%, transparent);
  color: color-mix(in srgb, var(--ew-danger) 90%, #fff);
}

.ew-btn--danger:hover,
.ew-btn--danger:focus-visible {
  background: color-mix(in srgb, var(--ew-danger) 80%, transparent);
  border-color: var(--ew-danger);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ew-danger) 30%, transparent);
}

@media (max-width: 900px) {
  .dbg-snap-section {
    padding: 0.5rem;
  }
  .dbg-snap-table {
    font-size: 0.68rem;
  }
  .dbg-snap-table th,
  .dbg-snap-table td {
    padding: 0.25rem 0.35rem;
  }
  .dbg-snap-excerpt {
    max-width: 180px;
  }
  .dbg-snap-content pre {
    font-size: 0.66rem;
    max-height: 8rem;
  }
}
</style>
