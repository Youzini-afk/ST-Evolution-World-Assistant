import { klona } from 'klona';
import { simpleHash } from './helpers';
import {
  DEFAULT_PROMPT_ORDER,
  EwApiPreset,
  EwApiPresetSchema,
  EwFlowConfig,
  EwFlowConfigSchema,
  EwPromptOrderEntry,
} from './types';

export function createDefaultApiPreset(index: number): EwApiPreset {
  const id = `api_${index}_${simpleHash(`api-${index}-${Date.now()}`)}`;
  return EwApiPresetSchema.parse({
    id,
    name: `API配置 ${index}`,
    mode: 'workflow_http',
    api_url: '',
    api_key: '',
    model: '',
    api_source: 'openai',
    model_candidates: [],
    headers_json: '',
  });
}

export function createDefaultFlow(index: number, apiPresetId: string): EwFlowConfig {
  const id = `flow_${index}_${simpleHash(`${index}-${Date.now()}`)}`;
  const promptSeed = `${id}-prompt`;
  // 直接生成完整 prompt_order，避免依赖 normalizeSettings 的 prompt_items 迁移路径。
  // klona 防止 DEFAULT_PROMPT_ORDER 被引用共享后修改污染。
  const customPrompts: EwPromptOrderEntry[] = [
    {
      identifier: `prompt_${simpleHash(`${promptSeed}-0`)}`,
      name: '输出格式',
      enabled: true,
      type: 'prompt',
      role: 'system',
      content: '',
      injection_position: 'relative',
      injection_depth: 0,
    },
    {
      identifier: `prompt_${simpleHash(`${promptSeed}-1`)}`,
      name: '回复风格',
      enabled: true,
      type: 'prompt',
      role: 'system',
      content: '',
      injection_position: 'relative',
      injection_depth: 0,
    },
  ];
  return EwFlowConfigSchema.parse({
    id,
    name: `工作流 ${index}`,
    enabled: true,
    run_every_n_floors: 1,
    priority: 100,
    timeout_ms: 300000,
    api_preset_id: apiPresetId,
    generation_options: {
      unlock_context_length: false,
      max_context_tokens: 200000,
      max_reply_tokens: 65535,
      n_candidates: 1,
      stream: true,
      temperature: 1.2,
      frequency_penalty: 0,
      presence_penalty: 0,
      top_p: 0.92,
    },
    behavior_options: {
      name_behavior: 'default',
      continue_prefill: false,
      squash_system_messages: false,
      enable_function_calling: false,
      send_inline_media: false,
      request_thinking: false,
      reasoning_effort: 'auto',
      verbosity: 'auto',
    },
    prompt_order: [...klona(DEFAULT_PROMPT_ORDER), ...customPrompts],
    prompt_items: [],
    api_url: '',
    api_key: '',
    context_turns: 8,
    extract_rules: [],
    exclude_rules: [],
    request_template: '',
    headers_json: '',
  });
}
