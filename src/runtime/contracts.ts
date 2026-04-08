// NOTE: .prefault() is a SillyTavern-specific extension to Zod, not part of standard Zod.
// It sets a default value for the entire object when used in array contexts.
import { z } from 'zod';

export const TextSliceRuleSchema = z
  .object({
    start: z.string().default(''),
    end: z.string().default(''),
  })
  .prefault({});

const DynContextSecondaryLogicSchema = z.enum(['and_any', 'and_all', 'not_any', 'not_all']);
const DynContextPositionRoleSchema = z.enum(['system', 'user', 'assistant']);
const DynContextScanDepthSchema = z.union([z.literal('same_as_global'), z.number().int().min(0), z.string().min(1)]);

const DynContextEntrySchema = z.object({
  name: z.string().min(1),
  content: z.string().default(''),
  enabled: z.boolean().default(false),
  comment: z.string().default(''),
  position: z
    .object({
      type: z.string().default('before_character_definition'),
      role: DynContextPositionRoleSchema.default('system'),
      depth: z.number().int().min(0).default(0),
      order: z.number().int().default(100),
    })
    .default({
      type: 'before_character_definition',
      role: 'system',
      depth: 0,
      order: 100,
    }),
  strategy: z
    .object({
      type: z.string().default('constant'),
      keys: z.array(z.string()).default([]),
      keys_secondary: z
        .object({
          logic: DynContextSecondaryLogicSchema.default('and_any'),
          keys: z.array(z.string()).default([]),
        })
        .default({ logic: 'and_any', keys: [] }),
      scan_depth: DynContextScanDepthSchema.default('same_as_global'),
    })
    .default({
      type: 'constant',
      keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    }),
  probability: z.number().min(0).max(100).default(100),
  effect: z
    .object({
      sticky: z.number().int().min(0).nullable().default(null),
      cooldown: z.number().int().min(0).nullable().default(null),
      delay: z.number().int().min(0).nullable().default(null),
    })
    .default({ sticky: null, cooldown: null, delay: null }),
  extra: z
    .object({
      caseSensitive: z.boolean().default(false),
      matchWholeWords: z.boolean().default(false),
      group: z.string().default(''),
      groupOverride: z.boolean().default(false),
      groupWeight: z.number().default(100),
      useGroupScoring: z.boolean().default(false),
    })
    .default({
      caseSensitive: false,
      matchWholeWords: false,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      useGroupScoring: false,
    }),
});

export const FlowRequestSchema = z.object({
  version: z.literal('ew-flow/v1'),
  request_id: z.string().min(1),
  chat_id: z.string().min(1),
  message_id: z.number(),
  user_input: z.string().optional(),
  trigger: z
    .object({
      timing: z.enum(['before_reply', 'after_reply', 'manual']).default('before_reply'),
      source: z.string().default('unknown'),
      generation_type: z.string().default('normal'),
      user_message_id: z.number().optional(),
      assistant_message_id: z.number().optional(),
    })
    .optional(),
  flow: z.object({
    id: z.string().min(1),
    name: z.string().default(''),
    priority: z.number().default(100),
    timeout_ms: z.number().int().positive().default(300000),
    generation_options: z
      .object({
        unlock_context_length: z.boolean().default(false),
        max_context_tokens: z.number().int().positive().default(200000),
        max_reply_tokens: z.number().int().positive().default(65535),
        n_candidates: z.number().int().min(1).default(1),
        stream: z.boolean().default(true),
        temperature: z.number().min(0).max(2).default(1.2),
        frequency_penalty: z.number().min(0).max(2).default(0),
        presence_penalty: z.number().min(0).max(2).default(0),
        top_p: z.number().min(0).max(1).default(0.92),
      })
      .prefault({}),
    behavior_options: z
      .object({
        name_behavior: z.enum(['none', 'default', 'complete_target', 'message_content']).default('default'),
        continue_prefill: z.boolean().default(false),
        squash_system_messages: z.boolean().default(false),
        enable_function_calling: z.boolean().default(false),
        send_inline_media: z.boolean().default(false),
        request_thinking: z.boolean().default(false),
        reasoning_effort: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
        verbosity: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
      })
      .prefault({}),
  }),
  context: z.object({
    turns: z.number().int().min(1).default(8),
    extract_rules: z.array(TextSliceRuleSchema).default([]),
    exclude_rules: z.array(TextSliceRuleSchema).default([]),
    ew_dyn_entries: z
      .object({
        active_names: z.array(z.string().min(1)).default([]),
        inactive_names: z.array(z.string().min(1)).default([]),
        entries: z.array(DynContextEntrySchema).default([]),
        write_hint: z
          .object({
            mode: z.enum(['overwrite', 'add', 'add_remove']).default('overwrite'),
            item_format: z.literal('markdown_list').default('markdown_list'),
            activation_mode: z.enum(['controller_only', 'worldbook_direct']).default('controller_only'),
          })
          .default({
            mode: 'overwrite',
            item_format: 'markdown_list',
            activation_mode: 'controller_only',
          }),
      })
      .default({
        active_names: [],
        inactive_names: [],
        entries: [],
        write_hint: {
          mode: 'overwrite',
          item_format: 'markdown_list',
          activation_mode: 'controller_only',
        },
      }),
  }),
  rederive_context: z
    .object({
      job_type: z.enum(['live_auto', 'live_reroll', 'historical_rederive']).default('live_auto'),
      writeback_policy: z.enum(['dual_diff_merge']).default('dual_diff_merge'),
      target_message_id: z.number(),
      target_version_key: z.string().default(''),
      target_role: z.enum(['user', 'assistant', 'other']).default('other'),
      legacy_approx: z.boolean().default(false),
      capsule_mode: z.enum(['full', 'light']).default('full'),
    })
    .optional(),
  serial_results: z.array(z.record(z.string(), z.any())).default([]),
});

export const WorldbookDesiredEntrySchema = z.object({
  name: z.string().min(1),
  content: z.string().default(''),
  enabled: z.boolean().default(true),
});

export const WorldbookRemoveEntrySchema = z.object({
  name: z.string().min(1),
});

export const ControllerVariableSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  default: z.any(),
});

export const ControllerRuleSchema = z.object({
  when: z.string().min(1),
  include_entries: z.array(z.string().min(1)).default([]),
});

export const ControllerSetVarSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
  scope: z.enum(['local', 'global', 'message']).default('local'),
});

export const ControllerActivateSchema = z.object({
  world: z.string().optional(),
  entry: z.string().min(1),
});

export const ControllerCharDetectionSchema = z.object({
  alias_map: z.record(z.string(), z.string()).default({}),
  scene_var: z.string().optional(),
  scan_messages: z.number().int().min(0).default(1),
  entry_patterns: z.array(z.string().min(1)).default(['{name}']),
});

export const ControllerForEachSchema = z.object({
  list_var: z.string().min(1),
  entry_prefix: z.string().default(''),
  entry_suffix: z.string().default(''),
});

export const ControllerModelSchema = z.object({
  template_id: z.literal('entry_selector_v1'),
  // 现有字段
  variables: z.array(ControllerVariableSchema).default([]),
  rules: z.array(ControllerRuleSchema).default([]),
  fallback_entries: z.array(z.string().min(1)).default([]),
  // 新增字段
  decorators: z.array(z.string().min(1)).default([]),
  skip_floor_zero: z.boolean().default(false),
  set_variables: z.array(ControllerSetVarSchema).default([]),
  activate_entries: z.array(ControllerActivateSchema).default([]),
  inject_text: z.array(z.string()).default([]),
  char_detection: ControllerCharDetectionSchema.optional(),
  for_each: z.array(ControllerForEachSchema).default([]),
});

export const FlowResponseSchema = z.object({
  version: z.string().default('ew-flow/v1'),
  flow_id: z.string().default('unknown'),
  status: z.string().default('ok'),
  priority: z.number().default(100),
  reply_instruction: z.string().default(''),
  operations: z
    .object({
      worldbook: z
        .object({
          desired_entries: z.array(WorldbookDesiredEntrySchema).default([]),
          remove_entries: z.array(WorldbookRemoveEntrySchema).default([]),
        })
        .default({ desired_entries: [], remove_entries: [] }),
      controller_model: ControllerModelSchema.optional(),
    })
    .default({ worldbook: { desired_entries: [], remove_entries: [] } }),
  diagnostics: z
    .object({
      trace_id: z.string().optional(),
    })
    .default({}),
});

export type TextSliceRule = z.infer<typeof TextSliceRuleSchema>;
export type FlowRequestV1 = z.infer<typeof FlowRequestSchema>;
export type FlowTriggerV1 = NonNullable<FlowRequestV1['trigger']>;
export type FlowResponseV1 = z.infer<typeof FlowResponseSchema>;
export type ControllerModel = z.infer<typeof ControllerModelSchema>;
