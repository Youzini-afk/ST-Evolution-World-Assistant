<template>
  <article class="ew-api-card" :data-expanded="expanded ? '1' : '0'">
    <header class="ew-api-card__head">
      <div class="ew-api-card__summary">
        <strong class="ew-api-card__name">{{ preset.name || `API配置 ${index + 1}` }}</strong>
        <div class="ew-api-card__chips">
          <span class="ew-api-card__chip">自定义API</span>
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
          <EwFieldRow label="API URL">
            <input
              :value="preset.api_url"
              type="text"
              placeholder="https://api.example.com/v1/chat/completions"
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
        </div>
      </div>
    </transition>
  </article>
</template>

<script setup lang="ts">
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
const endpointSummary = computed(() => {
  const endpoint = preset.value.api_url.trim();
  const model = preset.value.model.trim() || '未选模型';
  if (!endpoint && !model) {
    return '未配置';
  }
  if (!endpoint) {
    return `URL未配置 / ${model}`;
  }
  const merged = `${endpoint} / ${model}`;
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

async function loadModels() {
  const apiurl = preset.value.api_url.trim();
  if (!apiurl) {
    toastr.warning('请先填写 API URL', 'Evolution World');
    return;
  }

  loadingModels.value = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    // 构建 models 端点 URL
    const base = apiurl.replace(/\/+$/, '');
    const modelsUrl = base.endsWith('/models') ? base : `${base}/models`;

    // 构建请求头
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const headersJson = preset.value.headers_json?.trim();
    if (headersJson) {
      try {
        const custom = JSON.parse(headersJson);
        if (custom && typeof custom === 'object') {
          Object.assign(headers, custom);
        }
      } catch {
        /* ignore */
      }
    }
    const apiKey = preset.value.api_key.trim();
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let json: any;

    // 策略1: 直接从浏览器 fetch（适用于公网 API）
    try {
      const resp = await fetch(modelsUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      json = await resp.json();
    } catch (directError) {
      // 策略2: 通过 ST 后端代理（适用于本地端口、CORS 限制的 API）
      console.info(
        `[EW] Direct model fetch failed (${directError instanceof Error ? directError.message : directError}), trying ST backend proxy…`,
      );

      // 获取 ST 请求头
      const stHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const g = globalThis as Record<string, any>;
      if (typeof g.SillyTavern?.getRequestHeaders === 'function') {
        Object.assign(stHeaders, g.SillyTavern.getRequestHeaders());
      }
      stHeaders['Content-Type'] = 'application/json';

      // 构建 custom_include_headers（将用户的 API key 和自定义头传给 ST 后端）
      const includeHeaders = Object.entries(headers)
        .filter(([k]) => k.toLowerCase() !== 'content-type')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      // 通过 ST 后端代理发送请求
      // 使用 chat-completions/generate 端点 + 特殊的 model_list 模式
      // ST 后端会将请求转发到 custom_url
      const proxyResp = await fetch('/api/backends/chat-completions/models', {
        method: 'POST',
        headers: stHeaders,
        body: JSON.stringify({
          chat_completion_source: 'custom',
          custom_url: modelsUrl,
          custom_include_headers: includeHeaders,
          reverse_proxy: modelsUrl,
          proxy_password: '',
        }),
        signal: controller.signal,
      });

      if (proxyResp.ok) {
        json = await proxyResp.json();
      } else {
        // 策略3: 通用 OpenAI 模型列表端点
        const openaiProxyResp = await fetch('/api/backends/chat-completions/models', {
          method: 'POST',
          headers: stHeaders,
          body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: apiurl,
            proxy_password: apiKey,
          }),
          signal: controller.signal,
        });
        if (!openaiProxyResp.ok) {
          throw new Error(
            `本地端口加载失败。请确认: 1) API 服务已启动 2) URL 正确 (当前: ${modelsUrl})`,
          );
        }
        json = await openaiProxyResp.json();
      }
    }

    // 解析响应：支持多种格式
    let rawList: string[];
    if (Array.isArray(json?.data)) {
      rawList = json.data.map((m: any) => String(m.id ?? m.name ?? '')).filter(Boolean);
    } else if (Array.isArray(json)) {
      rawList = json.map((m: any) => (typeof m === 'string' ? m : String(m.id ?? m.name ?? ''))).filter(Boolean);
    } else {
      rawList = [];
    }

    const deduped = Array.from(new Set(rawList.map(item => item.trim()).filter(Boolean)));
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
