import { parseJsonObject } from './helpers';
import type { EwApiPreset } from './types';

export type EwApiSourceTransport = 'reverse_proxy' | 'custom_headers';
export type EwApiModelLoadStrategy = 'openai_models' | 'anthropic_models' | 'makersuite_models' | 'xai_models';

export type EwApiSourceDefinition = {
  key: string;
  label: string;
  shortLabel: string;
  transport: EwApiSourceTransport;
  backendSource: string;
  generateRawSource: string | null;
  placeholder: string;
  note: string;
  modelLoadStrategy: EwApiModelLoadStrategy;
  allowsCustomHeaders: boolean;
  supportsStProxyModels: boolean;
  defaultHeaders?: Record<string, string>;
};

export const EW_API_SOURCE_OPTIONS: EwApiSourceDefinition[] = [
  {
    key: 'openai',
    label: 'OpenAI / 兼容反代',
    shortLabel: 'OpenAI',
    transport: 'reverse_proxy',
    backendSource: 'openai',
    generateRawSource: 'openai',
    placeholder: 'https://api.openai.com/v1',
    note: '适合 OpenAI 官方与大多数按 OpenAI 语义工作的反向代理地址。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'custom',
    label: '自定义 OpenAI 兼容',
    shortLabel: 'Custom',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: 'custom',
    placeholder: 'https://api.example.com/v1',
    note: '适合自建网关、聚合器与第三方 OpenAI 兼容端点。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    shortLabel: 'OpenRouter',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: null,
    placeholder: 'https://openrouter.ai/api/v1',
    note: '按 OpenAI 兼容方式转发，并自动补充 OpenRouter 推荐请求头。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/Youzini-afk/ST-Evolution-World-Assistant',
      'X-Title': 'Evolution World Assistant',
    },
  },
  {
    key: 'claude',
    label: 'Anthropic Claude',
    shortLabel: 'Claude',
    transport: 'reverse_proxy',
    backendSource: 'claude',
    generateRawSource: null,
    placeholder: 'https://api.anthropic.com/v1',
    note: '走 SillyTavern 的 Claude 原生通道，URL 请填写基础 API 地址。',
    modelLoadStrategy: 'anthropic_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'makersuite',
    label: 'Google AI Studio',
    shortLabel: 'Gemini',
    transport: 'reverse_proxy',
    backendSource: 'makersuite',
    generateRawSource: null,
    placeholder: 'https://generativelanguage.googleapis.com',
    note: '走 Gemini 原生通道，URL 只填基础域名即可，插件会自动补全 models/generateContent 路径。',
    modelLoadStrategy: 'makersuite_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'mistralai',
    label: 'Mistral AI',
    shortLabel: 'Mistral',
    transport: 'reverse_proxy',
    backendSource: 'mistralai',
    generateRawSource: 'mistralai',
    placeholder: 'https://api.mistral.ai/v1',
    note: '走 SillyTavern 的 Mistral 原生通道。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    shortLabel: 'DeepSeek',
    transport: 'reverse_proxy',
    backendSource: 'deepseek',
    generateRawSource: 'deepseek',
    placeholder: 'https://api.deepseek.com',
    note: '走 SillyTavern 的 DeepSeek 原生通道，推荐填基础域名。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'xai',
    label: 'xAI Grok',
    shortLabel: 'xAI',
    transport: 'reverse_proxy',
    backendSource: 'xai',
    generateRawSource: 'xai',
    placeholder: 'https://api.x.ai/v1',
    note: '走 SillyTavern 的 xAI 原生通道。',
    modelLoadStrategy: 'xai_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'moonshot',
    label: 'Moonshot / Kimi',
    shortLabel: 'Moonshot',
    transport: 'reverse_proxy',
    backendSource: 'moonshot',
    generateRawSource: 'moonshot',
    placeholder: 'https://api.moonshot.ai/v1',
    note: '走 SillyTavern 的 Moonshot 原生通道。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: false,
    supportsStProxyModels: true,
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    shortLabel: 'Perplexity',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: 'custom',
    placeholder: 'https://api.perplexity.ai',
    note: '按 OpenAI 兼容方式转发；若某些模型不兼容，可切回酒馆主 API 直连。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
  },
  {
    key: 'groq',
    label: 'Groq',
    shortLabel: 'Groq',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: 'custom',
    placeholder: 'https://api.groq.com/openai/v1',
    note: '按 OpenAI 兼容方式转发。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
  },
  {
    key: 'fireworks',
    label: 'Fireworks',
    shortLabel: 'Fireworks',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: 'custom',
    placeholder: 'https://api.fireworks.ai/inference/v1',
    note: '按 OpenAI 兼容方式转发。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
  },
  {
    key: 'aimlapi',
    label: 'AIMLAPI',
    shortLabel: 'AIMLAPI',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: 'custom',
    placeholder: 'https://api.aimlapi.com/v1',
    note: '按 OpenAI 兼容方式转发，并自动补充 AIMLAPI 推荐请求头。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/Youzini-afk/ST-Evolution-World-Assistant',
      'X-Title': 'Evolution World Assistant',
    },
  },
  {
    key: 'siliconflow',
    label: 'SiliconFlow',
    shortLabel: 'SiliconFlow',
    transport: 'custom_headers',
    backendSource: 'custom',
    generateRawSource: 'custom',
    placeholder: 'https://api.siliconflow.cn/v1',
    note: '按 OpenAI 兼容方式转发。',
    modelLoadStrategy: 'openai_models',
    allowsCustomHeaders: true,
    supportsStProxyModels: true,
  },
];

const API_SOURCE_ALIAS: Record<string, string> = {
  mistral: 'mistralai',
  google: 'makersuite',
  gemini: 'makersuite',
  anthropic: 'claude',
  kimi: 'moonshot',
};

const API_SOURCE_MAP = new Map(EW_API_SOURCE_OPTIONS.map(option => [option.key, option]));

export function normalizeApiSource(source: string | undefined | null): string {
  const normalized = String(source ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return 'openai';
  }

  const aliasResolved = API_SOURCE_ALIAS[normalized] ?? normalized;
  return API_SOURCE_MAP.has(aliasResolved) ? aliasResolved : 'openai';
}

export function getApiSourceDefinition(source: string | undefined | null): EwApiSourceDefinition {
  return API_SOURCE_MAP.get(normalizeApiSource(source)) ?? EW_API_SOURCE_OPTIONS[0];
}

export function normalizeApiBaseUrl(source: string | undefined | null, rawUrl: string | undefined | null): string {
  const normalizedSource = normalizeApiSource(source);
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    return '';
  }

  let next = trimmed.replace(/\/+$/, '');

  if (['openai', 'custom', 'openrouter', 'perplexity', 'groq', 'fireworks', 'aimlapi', 'siliconflow'].includes(normalizedSource)) {
    next = next.replace(/\/chat\/completions$/i, '');
    next = next.replace(/\/completions$/i, '');
    next = next.replace(/\/models$/i, '');
    return next;
  }

  if (['mistralai', 'deepseek', 'xai', 'moonshot'].includes(normalizedSource)) {
    next = next.replace(/\/chat\/completions$/i, '');
    next = next.replace(/\/models$/i, '');
    next = next.replace(/\/language-models$/i, '');
    return next;
  }

  if (normalizedSource === 'claude') {
    next = next.replace(/\/messages$/i, '');
    next = next.replace(/\/models$/i, '');
    return next;
  }

  if (normalizedSource === 'makersuite') {
    next = next.replace(/\/models$/i, '');
    next = next.replace(/\/v1beta$/i, '');
    next = next.replace(/\/v1$/i, '');
    return next;
  }

  return next;
}

export function parseApiPresetHeadersJson(headersJson: string): Record<string, string> {
  return parseJsonObject(headersJson);
}

export function buildApiPresetHeaderRecord(apiPreset: Pick<EwApiPreset, 'api_source' | 'api_key' | 'headers_json'>): Record<string, string> {
  const definition = getApiSourceDefinition(apiPreset.api_source);
  const headers = definition.allowsCustomHeaders ? parseApiPresetHeadersJson(apiPreset.headers_json) : {};

  if (definition.defaultHeaders) {
    Object.assign(headers, definition.defaultHeaders);
  }

  const apiKey = String(apiPreset.api_key ?? '').trim();
  if (apiKey) {
    if (definition.key === 'claude') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  return headers;
}

export function buildApiPresetCustomIncludeHeaders(
  apiPreset: Pick<EwApiPreset, 'api_source' | 'api_key' | 'headers_json'>,
): string {
  return Object.entries(buildApiPresetHeaderRecord(apiPreset))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export function shouldUseGenerateRawCustomApi(
  apiPreset: Pick<EwApiPreset, 'api_source' | 'headers_json'>,
): boolean {
  const definition = getApiSourceDefinition(apiPreset.api_source);
  if (!definition.generateRawSource) {
    return false;
  }

  if (definition.transport === 'custom_headers') {
    if (Object.keys(definition.defaultHeaders ?? {}).length > 0) {
      return false;
    }
    return !String(apiPreset.headers_json ?? '').trim();
  }

  return true;
}
