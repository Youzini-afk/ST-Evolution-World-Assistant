<template>
  <article class="ew-api-card" :data-expanded="expanded ? '1' : '0'">
    <header class="ew-api-card__head">
      <div class="ew-api-card__summary">
        <strong class="ew-api-card__name">{{ preset.name || `API配置 ${index + 1}` }}</strong>
        <div class="ew-api-card__chips">
          <span class="ew-api-card__chip">{{ sourceDefinition.label }}</span>
          <span class="ew-api-card__chip">
            模型 {{ preset.model || '未选' }}
          </span>
          <span class="ew-api-card__chip">工作流引用 {{ bindCount }}</span>
        </div>
        <p class="ew-api-card__endpoint">端点: {{ endpointSummary }}</p>
      </div>

      <div class="ew-api-card__actions">
        <button type="button" class="ew-api-card__action" @click="$emit('toggle-expand')">
          {{ expanded ? '收起' : '编辑' }}
        </button>
        <button type="button" class="ew-api-card__action" @click="$emit('duplicate')">
          复制
        </button>
        <button type="button" class="ew-api-card__action ew-api-card__action--danger" @click="$emit('remove')">
          删除
        </button>
      </div>
    </header>

    <transition name="ew-api-expand">
      <div v-if="expanded" class="ew-api-card__body">
        <div class="ew-api-card__grid two">
          <EwFieldRow label="预设名称">
            <input :value="preset.name" type="text" @input="setText('name', $event)" />
          </EwFieldRow>
          <EwFieldRow label="渠道类型">
            <select :value="normalizedSource" @change="setApiSource">
              <option v-for="option in apiSourceOptions" :key="option.key" :value="option.key">
                {{ option.label }}
              </option>
            </select>
          </EwFieldRow>
          <EwFieldRow label="API URL">
            <input
              :value="preset.api_url"
              type="text"
              :placeholder="sourceDefinition.placeholder"
              @input="setText('api_url', $event)"
            />
          </EwFieldRow>

          <EwFieldRow label="API Key">
            <input :value="preset.api_key" type="password" @input="setText('api_key', $event)" />
          </EwFieldRow>

          <EwFieldRow label="模型">
            <div class="ew-api-card__model-wrap">
              <select
                v-if="preset.model_candidates.length > 0"
                :value="preset.model"
                @change="patch({ model: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="model in preset.model_candidates" :key="model" :value="model">
                  {{ model }}
                </option>
              </select>
              <input
                v-else
                :value="preset.model"
                type="text"
                placeholder="gpt-4o-mini"
                @input="setText('model', $event)"
              />
              <button
                type="button"
                class="ew-api-card__action"
                :disabled="loadingModels"
                @click="loadModels"
              >
                {{ loadingModels ? '加载中...' : '加载模型列表' }}
              </button>
            </div>
          </EwFieldRow>
          <EwFieldRow v-if="sourceDefinition.allowsCustomHeaders" label="额外请求头(JSON)">
            <textarea
              :value="preset.headers_json"
              rows="4"
              placeholder='{"X-Token":"value"}'
              @input="setText('headers_json', $event)"
            />
          </EwFieldRow>
        </div>

        <div class="ew-api-card__hint">
          <strong>渠道说明：</strong>{{ sourceDefinition.note }}
          <template v-if="normalizedApiUrl">
            <br />
            <span>归一化地址：{{ normalizedApiUrl }}</span>
          </template>
          <template v-if="!sourceDefinition.allowsCustomHeaders">
            <br />
            <span>当前渠道走宿主原生转发，额外请求头不会参与发送。</span>
          </template>
        </div>
      </div>
    </transition>
  </article>
</template>

<script setup lang="ts">
import {
  buildApiPresetCustomIncludeHeaders,
  buildApiPresetHeaderRecord,
  EW_API_SOURCE_OPTIONS,
  getApiSourceDefinition,
  normalizeApiBaseUrl,
  normalizeApiSource,
} from '../../runtime/api-sources';
import type { EwApiPreset } from '../../runtime/types';
import EwFieldRow from './EwFieldRow.vue';

const props = defineProps<{
  modelValue: EwApiPreset;
  index: number;
  expanded: boolean;
  bindCount: number;
}>();

const emit = defineEmits<{
  (event: 'toggle-expand'): void;
  (event: 'duplicate'): void;
  (event: 'remove'): void;
  (event: 'update:modelValue', value: EwApiPreset): void;
}>();

const preset = computed(() => props.modelValue);
const loadingModels = ref(false);
const apiSourceOptions = EW_API_SOURCE_OPTIONS;
const normalizedSource = computed(() => normalizeApiSource(preset.value.api_source));
const sourceDefinition = computed(() => getApiSourceDefinition(preset.value.api_source));
const normalizedApiUrl = computed(() => normalizeApiBaseUrl(preset.value.api_source, preset.value.api_url));
const endpointSummary = computed(() => {
  const endpoint = normalizedApiUrl.value;
  const model = preset.value.model.trim() || '未选模型';
  if (!endpoint && !model) {
    return '未配置';
  }
  if (!endpoint) {
    return `${sourceDefinition.value.shortLabel} / URL未配置 / ${model}`;
  }
  const merged = `${sourceDefinition.value.shortLabel} / ${endpoint} / ${model}`;
  return merged.length <= 72 ? merged : `${merged.slice(0, 69)}...`;
});

function patch(partial: Partial<EwApiPreset>) {
  emit('update:modelValue', {
    ...preset.value,
    ...partial,
  });
}

function setText(key: 'name' | 'api_url' | 'api_key' | 'model' | 'headers_json', event: Event) {
  const next = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  patch({ [key]: next } as Partial<EwApiPreset>);
}

function setApiSource(event: Event) {
  const nextSource = normalizeApiSource((event.target as HTMLSelectElement).value);
  patch({
    api_source: nextSource,
    model_candidates: [],
  });
}

function buildOpenAiLikeModelsUrl(apiurl: string): string {
  const base = apiurl.replace(/\/+$/, '');
  return base.endsWith('/models') ? base : `${base}/models`;
}

function getStHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const g = globalThis as Record<string, any>;
  if (typeof g.SillyTavern?.getRequestHeaders === 'function') {
    Object.assign(headers, g.SillyTavern.getRequestHeaders());
  }
  headers['Content-Type'] = 'application/json';
  return headers;
}

async function loadModelsViaDirect(signal: AbortSignal): Promise<any> {
  const apiurl = normalizedApiUrl.value;
  const apiKey = preset.value.api_key.trim();
  const source = normalizedSource.value;
  const headers = buildApiPresetHeaderRecord(preset.value);
  const requestHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-type'),
  );

  if (sourceDefinition.value.modelLoadStrategy === 'anthropic_models') {
    const resp = await fetch(`${apiurl}/models`, {
      method: 'GET',
      headers: requestHeaders,
      signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return await resp.json();
  }

  if (sourceDefinition.value.modelLoadStrategy === 'makersuite_models') {
    if (!apiKey) {
      throw new Error('Google AI Studio 渠道需要先填写 API Key 才能加载模型列表。');
    }
    const apiVersion = 'v1beta';
    const resp = await fetch(`${apiurl}/${apiVersion}/models?key=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return await resp.json();
  }

  if (sourceDefinition.value.modelLoadStrategy === 'xai_models') {
    const resp = await fetch(`${apiurl}/language-models`, {
      method: 'GET',
      headers: requestHeaders,
      signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return await resp.json();
  }

  const resp = await fetch(buildOpenAiLikeModelsUrl(apiurl), {
    method: 'GET',
    headers: requestHeaders,
    signal,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return await resp.json();
}

async function loadModelsViaStProxy(signal: AbortSignal): Promise<any> {
  const apiurl = normalizedApiUrl.value;
  const definition = sourceDefinition.value;
  const stHeaders = getStHeaders();

  if (definition.transport === 'custom_headers') {
    const proxyResp = await fetch('/api/backends/chat-completions/models', {
      method: 'POST',
      headers: stHeaders,
      body: JSON.stringify({
        chat_completion_source: 'custom',
        custom_url: apiurl,
        custom_include_headers: buildApiPresetCustomIncludeHeaders(preset.value),
        reverse_proxy: apiurl,
        proxy_password: '',
      }),
      signal,
    });

    if (!proxyResp.ok) {
      throw new Error(`酒馆代理返回 HTTP ${proxyResp.status}`);
    }
    return await proxyResp.json();
  }

  if (definition.supportsStProxyModels) {
    const proxyResp = await fetch('/api/backends/chat-completions/models', {
      method: 'POST',
      headers: stHeaders,
      body: JSON.stringify({
        chat_completion_source: definition.backendSource,
        reverse_proxy: apiurl,
        proxy_password: preset.value.api_key.trim(),
      }),
      signal,
    });

    if (!proxyResp.ok) {
      throw new Error(`酒馆代理返回 HTTP ${proxyResp.status}`);
    }
    return await proxyResp.json();
  }

  throw new Error('该渠道暂不支持通过酒馆代理自动读取模型列表，请手动填写模型名。');
}

function normalizeModelListPayload(payload: any): string[] {
  if (normalizedSource.value === 'makersuite' && Array.isArray(payload?.models)) {
    return payload.models
      .map((item: any) => String(item?.name ?? item?.id ?? ''))
      .map((name: string) => name.replace(/^models\//, '').trim())
      .filter(Boolean);
  }

  if (normalizedSource.value === 'xai' && Array.isArray(payload?.models)) {
    return payload.models.map((item: any) => String(item?.id ?? item?.name ?? '')).filter(Boolean);
  }

  if (Array.isArray(payload?.data?.models)) {
    return payload.data.models.map((item: any) => String(item?.id ?? item?.name ?? '')).filter(Boolean);
  }

  if (Array.isArray(payload?.data)) {
    return payload.data.map((item: any) => String(item?.id ?? item?.name ?? item)).filter(Boolean);
  }

  if (Array.isArray(payload?.models)) {
    return payload.models.map((item: any) => String(item?.id ?? item?.name ?? item)).filter(Boolean);
  }

  if (Array.isArray(payload)) {
    return payload.map((item: any) => (typeof item === 'string' ? item : String(item?.id ?? item?.name ?? ''))).filter(Boolean);
  }

  return [];
}

async function loadModels() {
  const apiurl = normalizedApiUrl.value;
  if (!apiurl) {
    toastr.warning('请先填写 API URL', 'Evolution World');
    return;
  }

  loadingModels.value = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    let json: any;

    try {
      json = await loadModelsViaDirect(controller.signal);
    } catch (directError) {
      console.info(
        `[EW] Direct model fetch failed (${directError instanceof Error ? directError.message : directError}), trying ST backend proxy…`,
      );
      json = await loadModelsViaStProxy(controller.signal);
    }

    const rawList = normalizeModelListPayload(json);
    const deduped = Array.from(new Set(rawList.map(item => item.trim()).filter(Boolean)));
    if (deduped.length === 0) {
      throw new Error('接口返回成功，但没有解析到任何模型。你可以手动填写模型名继续使用。');
    }
    const current = preset.value.model.trim();
    const model_candidates = current && !deduped.includes(current) ? [current, ...deduped] : deduped;
    patch({
      model_candidates,
      model: current || model_candidates[0] || '',
    });
    toastr.success(`已加载 ${model_candidates.length} 个模型`, 'Evolution World');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      toastr.error('加载模型超时 (15s)', 'Evolution World');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      toastr.error(`加载模型失败: ${message}`, 'Evolution World');
    }
  } finally {
    clearTimeout(timeout);
    loadingModels.value = false;
  }
}
</script>

<style scoped>
.ew-api-card {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 5%, rgba(10, 14, 20, 0.4));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  overflow: visible;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.ew-api-card[data-expanded='1'] {
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 35%, transparent);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  transform: translateY(-2px);
}

.ew-api-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.9rem;
  padding: 0.9rem 1rem;
}

.ew-api-card__summary {
  min-width: 0;
}

.ew-api-card__name {
  display: block;
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.25;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 98%, transparent);
  letter-spacing: 0.01em;
}

.ew-api-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.5rem;
}

.ew-api-card__chip {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 85%, transparent);
  font-size: 0.72rem;
  font-weight: 500;
  padding: 0.15rem 0.6rem;
}

.ew-api-card__endpoint {
  margin: 0.5rem 0 0;
  font-size: 0.76rem;
  line-height: 1.35;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 65%, transparent);
  word-break: break-all;
}

.ew-api-card__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.45rem;
}

.ew-api-card__action {
  border-radius: 0.7rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);
  color: var(--SmartThemeBodyColor, #edf2f9);
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.35rem 0.65rem;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.ew-api-card__action:hover,
.ew-api-card__action:focus-visible {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--ew-accent-glow);
  outline: none;
}

.ew-api-card__action--danger {
  border-color: color-mix(in srgb, var(--ew-danger) 45%, transparent);
  background: color-mix(in srgb, var(--ew-danger) 15%, transparent);
  color: color-mix(in srgb, var(--ew-danger) 90%, #fff);
}

.ew-api-card__action--danger:hover,
.ew-api-card__action--danger:focus-visible {
  background: color-mix(in srgb, var(--ew-danger) 80%, transparent);
  border-color: var(--ew-danger);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ew-danger) 30%, transparent);
}

.ew-api-card__body {
  padding: 0 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.ew-api-card__grid {
  display: grid;
  gap: 0.75rem;
}

.ew-api-card__grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ew-api-card__model-wrap {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.55rem;
}

.ew-api-card__model-wrap datalist {
  display: none;
}

.ew-api-card__hint {
  border-radius: 0.8rem;
  border: 1px dashed color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 12%, rgba(8, 12, 18, 0.2));
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 85%, transparent);
  font-size: 0.82rem;
  line-height: 1.45;
  padding: 0.65rem 0.75rem;
}

.ew-api-expand-enter-active,
.ew-api-expand-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  transform-origin: top center;
}

.ew-api-expand-enter-from,
.ew-api-expand-leave-to {
  opacity: 0;
  transform: translateY(-8px) scaleY(0.98);
}

@supports not ((backdrop-filter: blur(1px))) {
  .ew-api-card {
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #2f4158) 18%, rgba(10, 14, 20, 0.92));
  }
}

@media (max-width: 900px) {
  .ew-api-card__head {
    flex-direction: column;
  }

  .ew-api-card__actions {
    width: 100%;
    justify-content: flex-start;
  }

  .ew-api-card__grid.two {
    grid-template-columns: 1fr;
  }

  .ew-api-card__model-wrap {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ew-api-card,
  .ew-api-card__action,
  .ew-api-expand-enter-active,
  .ew-api-expand-leave-active {
    transition: none;
  }
}
</style>
