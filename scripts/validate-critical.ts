import assert from 'node:assert/strict';

import { getExtensionSettingsBucketScore, shouldUseLegacySettingsBucket } from '../src/st-adapter';
import {
  mergeSharedSettingsWithLocalSecrets,
  redactDebugPayload,
  REDACTED_SECRET,
  sanitizeLastIoSummary,
  sanitizeSettingsForShared,
} from '../src/runtime/redaction';
import {
  CommitSummarySchema,
  DynWriteConfigSchema,
  EwSettingsSchema,
  LastIoSummarySchema,
  type MergedWorldbookDesiredEntry,
  type MergedWorldbookRemoveEntry,
} from '../src/runtime/types';
import { resolveMessageTextForVersioning } from '../src/runtime/helpers';
import { mergeSharedSettingsWithLocalFallback as mergeSharedSettingsWithLocalFallbackFromSettings } from '../src/runtime/settings';
import { buildDebugHighlightSegments } from '../src/ui/debug-highlight';
import { collectDynWriteConflictsForTest } from '../src/runtime/transaction';
import {
  buildNoEffectiveRequestWarningForTest,
  buildRunWarningFromCommitSummaryForTest,
} from '../src/runtime/pipeline';
import { isSnapshotResolutionUnsafeForDestructiveWriteForTest } from '../src/runtime/floor-binding';
import { applyLocalWorkflowRegexForTest, applyTavernRegexFallbackForTest } from '../src/runtime/regex-engine';
import { buildGenerateRawInvocationForTest } from '../src/runtime/dispatcher';
import {
  buildStructuredOutputRequestAugment,
  isLikelyStructuredOutputUnsupportedError,
} from '../src/runtime/structured-output';
import {
  clearDryRunPromptPreview,
  clearSendIntent,
  consumeDryRunPromptPreview,
  hasFreshSendIntent,
  isMvuExtraAnalysisGuardActive,
  isTavernHelperPromptViewerRefreshActive,
  markDryRunPromptPreview,
  readMvuExtraAnalysisFlag,
  recordUserSendIntent,
  resetRuntimeState,
  shouldSkipTavernHelperPromptViewerSyntheticGeneration,
} from '../src/runtime/state';
import {
  buildApiPresetCustomIncludeHeaders,
  getApiSourceDefinition,
  normalizeApiBaseUrl,
  normalizeApiSource,
  shouldUseGenerateRawCustomApi,
} from '../src/runtime/api-sources';

function buildSampleSettings() {
  return EwSettingsSchema.parse({
    enabled: true,
    api_presets: [
      {
        id: 'preset_primary',
        name: 'Primary API',
        api_url: 'https://example.invalid/v1',
        api_key: 'sk-live-secret',
        headers_json: '{"X-Api-Key":"header-secret"}',
        model: 'gpt-test',
      },
    ],
    flows: [
      {
        id: 'flow_cleanup',
        name: 'Cleanup Flow',
        enabled: true,
        api_preset_id: 'preset_primary',
        api_key: 'legacy-flow-key',
        headers_json: '{"Authorization":"Bearer legacy-secret"}',
      },
    ],
  });
}

function validateSharedSettingsSanitization(): void {
  const localSettings = buildSampleSettings();
  const sharedSettings = sanitizeSettingsForShared(localSettings);

  assert.equal(sharedSettings.api_presets[0].api_key, '');
  assert.equal(sharedSettings.api_presets[0].headers_json, '');
  assert.equal(sharedSettings.flows[0].api_key, '');
  assert.equal(sharedSettings.flows[0].headers_json, '');
  assert.equal(sharedSettings.api_presets[0].api_url, localSettings.api_presets[0].api_url);

  const mergedSettings = mergeSharedSettingsWithLocalSecrets(sharedSettings, localSettings);
  assert.equal(mergedSettings.api_presets[0].api_key, 'sk-live-secret');
  assert.equal(mergedSettings.api_presets[0].headers_json, '{"X-Api-Key":"header-secret"}');
  assert.equal(mergedSettings.flows[0].api_key, 'legacy-flow-key');
  assert.equal(
    mergedSettings.flows[0].headers_json,
    '{"Authorization":"Bearer legacy-secret"}',
  );

  const emptyShared = EwSettingsSchema.parse({});
  const mergedFallback = mergeSharedSettingsWithLocalFallbackFromSettings(
    emptyShared,
    localSettings,
  );

  assert.equal(mergedFallback.flows.length, 1);
  assert.equal(mergedFallback.api_presets.length, 1);
  assert.equal(mergedFallback.enabled, true);
}

function validateExtensionBucketFallback(): void {
  const assistantBucket = {
    settings: EwSettingsSchema.parse({}),
  };
  const legacyBucket = {
    settings: buildSampleSettings(),
    last_run: { ok: true },
  };

  assert.equal(
    shouldUseLegacySettingsBucket(assistantBucket, legacyBucket),
    true,
  );
  assert.ok(
    getExtensionSettingsBucketScore(legacyBucket) >
      getExtensionSettingsBucketScore(assistantBucket),
  );
}

function validateDebugRedaction(): void {
  const redacted = redactDebugPayload({
    transport_request: {
      custom_include_headers: 'Authorization: Bearer super-secret\nX-Test: still-secret',
      custom_api: {
        key: 'another-secret',
      },
      nested: {
        authorization: 'Bearer nested-secret',
      },
    },
  }) as {
    transport_request: {
      custom_include_headers: string;
      custom_api: { key: string };
      nested: { authorization: string };
    };
  };

  assert.match(redacted.transport_request.custom_include_headers, /Authorization: \[REDACTED\]/);
  assert.match(redacted.transport_request.custom_include_headers, /X-Test: \[REDACTED\]/);
  assert.equal(redacted.transport_request.custom_api.key, REDACTED_SECRET);
  assert.equal(redacted.transport_request.nested.authorization, REDACTED_SECRET);

  const lastIo = sanitizeLastIoSummary(
    LastIoSummarySchema.parse({
      request_id: 'req_1',
      flows: [
        {
          flow_id: 'flow_cleanup',
          flow_name: 'Cleanup Flow',
          request_preview:
            '{"api_key":"visible","custom_include_headers":"Authorization: Bearer visible"}',
          response_preview: 'Authorization: Bearer visible',
          error: 'upstream failed with HTTP 401 and Authorization: Bearer visible',
        },
      ],
    }),
  );

  assert.match(lastIo.flows[0].request_preview, /\[REDACTED\]/);
  assert.match(lastIo.flows[0].response_preview, /\[REDACTED\]/);
  assert.match(lastIo.flows[0].error, /\[REDACTED\]/);
}

function validateDebugHighlightSegmentation(): void {
  const segments = buildDebugHighlightSegments(
    'hello <img src=x onerror=alert(1)> [EW/Test] world',
  );

  assert.equal(segments.some((segment) => segment.text.includes('<img')), true);
  assert.equal(
    segments.some(
      (segment) => segment.highlighted && segment.text === '[EW/Test]',
    ),
    true,
  );
}

function buildDesiredEntry(
  overrides: Partial<MergedWorldbookDesiredEntry> = {},
): MergedWorldbookDesiredEntry {
  const baseDynWrite = DynWriteConfigSchema.parse({});
  return {
    name: 'EW/Dyn/shared',
    content: '- item',
    enabled: false,
    source_flow_id: 'flow_a',
    source_flow_name: 'Flow A',
    priority: 100,
    flow_order: 0,
    dyn_write: baseDynWrite,
    ...overrides,
  };
}

function buildRemoveEntry(
  overrides: Partial<MergedWorldbookRemoveEntry> = {},
): MergedWorldbookRemoveEntry {
  return {
    name: 'EW/Dyn/shared',
    source_flow_id: 'flow_remove',
    source_flow_name: 'Flow Remove',
    priority: 80,
    flow_order: 1,
    ...overrides,
  };
}

function validateDynConflictSemantics(): void {
  const settings = EwSettingsSchema.parse({});

  const overwriteConflict = collectDynWriteConflictsForTest(
    new Map([
      [
        'EW/Dyn/shared',
        [
          buildDesiredEntry(),
          buildDesiredEntry({
            source_flow_id: 'flow_b',
            source_flow_name: 'Flow B',
            flow_order: 1,
          }),
        ],
      ],
    ]),
    new Map(),
    settings,
  );
  assert.equal(overwriteConflict.length, 1);
  assert.equal(overwriteConflict[0].name, 'EW/Dyn/shared');

  const addConflictFree = collectDynWriteConflictsForTest(
    new Map([
      [
        'EW/Dyn/shared',
        [
          buildDesiredEntry({
            dyn_write: {
              ...DynWriteConfigSchema.parse({}),
              mode: 'add',
            },
          }),
          buildDesiredEntry({
            source_flow_id: 'flow_b',
            source_flow_name: 'Flow B',
            flow_order: 1,
            dyn_write: {
              ...DynWriteConfigSchema.parse({}),
              mode: 'add',
            },
          }),
        ],
      ],
    ]),
    new Map(),
    settings,
  );
  assert.equal(addConflictFree.length, 0);

  const removeConflict = collectDynWriteConflictsForTest(
    new Map([['EW/Dyn/shared', [buildDesiredEntry()]]]),
    new Map([['EW/Dyn/shared', [buildRemoveEntry()]]]),
    settings,
  );
  assert.equal(removeConflict.length, 1);
}

function validateRunWarningSemantics(): void {
  const warning = buildRunWarningFromCommitSummaryForTest(
    CommitSummarySchema.parse({
      target_worldbook_name: 'WB_Main',
      dyn_entries_requested: 1,
      dyn_entries_created: 0,
      dyn_entries_updated: 0,
      dyn_entries_removed: 0,
      controller_entries_requested: 1,
      controller_entries_updated: 1,
      write_scope: 'controller_only',
      worldbook_verified: true,
      effective_change_count: 1,
    }),
  );
  assert.equal(warning?.code, 'dyn_not_updated');

  const noWarning = buildRunWarningFromCommitSummaryForTest(
    CommitSummarySchema.parse({
      target_worldbook_name: 'WB_Main',
      dyn_entries_requested: 0,
      controller_entries_updated: 1,
      effective_change_count: 1,
    }),
  );
  assert.equal(noWarning, null);

  const noopWarning = buildNoEffectiveRequestWarningForTest(
    CommitSummarySchema.parse({
      target_worldbook_name: 'WB_Main',
      dyn_entries_requested: 0,
      controller_entries_requested: 0,
      effective_change_count: 0,
    }),
    '',
  );
  assert.equal(noopWarning?.code, 'no_effective_request');

  const noopSuppressedByReply = buildNoEffectiveRequestWarningForTest(
    CommitSummarySchema.parse({
      target_worldbook_name: 'WB_Main',
      dyn_entries_requested: 0,
      controller_entries_requested: 0,
      effective_change_count: 0,
    }),
    'reply only',
  );
  assert.equal(noopSuppressedByReply, null);
}

function validateSnapshotResolutionSafety(): void {
  assert.equal(
    isSnapshotResolutionUnsafeForDestructiveWriteForTest('latest_fallback'),
    true,
  );
  assert.equal(
    isSnapshotResolutionUnsafeForDestructiveWriteForTest('same_swipe_fallback'),
    false,
  );
  assert.equal(
    isSnapshotResolutionUnsafeForDestructiveWriteForTest('single_fallback'),
    false,
  );
}

function validateMessageVersioningPrefersRawMessage(): void {
  const compatMessage = {
    message: '这是提示词查看器加工过的展示文本',
    raw: {
      mes: '这是原始助手回复',
      extra: {
        display_text: '这是提示词查看器加工过的展示文本',
      },
    },
  };

  assert.equal(resolveMessageTextForVersioning(compatMessage), '这是原始助手回复');
  assert.equal(resolveMessageTextForVersioning({ message: 'fallback text' }), 'fallback text');
}

function validateStructuredOutputAugment(): void {
  const customAugment = buildStructuredOutputRequestAugment('json_object', 'custom', '');
  assert.equal(customAugment.transportMode, 'response_format_json_object');
  assert.ok(customAugment.customIncludeBody);
  assert.deepEqual(JSON.parse(customAugment.customIncludeBody as string), {
    response_format: {
      type: 'json_object',
    },
  });

  const openAiAugment = buildStructuredOutputRequestAugment('json_object', 'openai', '');
  assert.equal(openAiAugment.transportMode, 'json_schema_fallback');
  assert.equal(openAiAugment.jsonSchema?.value.type, 'object');
  assert.equal(openAiAugment.jsonSchema?.value.additionalProperties, true);

  const invalidCustomBodyAugment = buildStructuredOutputRequestAugment('json_object', 'custom', 'top_k: [20');
  assert.equal(invalidCustomBodyAugment.transportMode, 'json_schema_fallback');
  assert.equal(typeof invalidCustomBodyAugment.note, 'string');

  const offAugment = buildStructuredOutputRequestAugment('off', 'custom', '');
  assert.equal(offAugment.transportMode, 'off');
}

function validateStructuredOutputFallbackDetection(): void {
  assert.equal(
    isLikelyStructuredOutputUnsupportedError(
      '[flow_a] 上游 API 请求失败：response_format of type json_object is not supported with this model (unsupported_parameter)',
    ),
    true,
  );
  assert.equal(
    isLikelyStructuredOutputUnsupportedError(
      '[flow_b] 上游 API 请求失败：json_schema is not available for this endpoint',
    ),
    true,
  );
  assert.equal(
    isLikelyStructuredOutputUnsupportedError(
      '[flow_c] ST backend error: 400 Structured Outputs are only supported on selected models',
    ),
    true,
  );
  assert.equal(
    isLikelyStructuredOutputUnsupportedError(
      '[flow_d] 上游 API 请求失败：temperature must be between 0 and 2',
    ),
    false,
  );
  assert.equal(
    isLikelyStructuredOutputUnsupportedError(
      '[flow_e] response_format supplied but request timed out before upstream returned any body',
    ),
    false,
  );
}

function validateWorkflowRegexPipeline(): void {
  const localRegex = applyLocalWorkflowRegexForTest(
    'Alpha Beta',
    [
      {
        id: 'local_1',
        find_regex: '/Beta/g',
        replace_string: 'Gamma',
      },
    ],
    'ai_output',
    'assistant',
  );
  assert.equal(localRegex.text, 'Alpha Gamma');
  assert.equal(localRegex.appliedCount, 1);

  const displayOnlyFallback = applyTavernRegexFallbackForTest(
    'Alpha Beta',
    [
      {
        id: 'display_only',
        findRegex: '/Alpha/g',
        replaceString: '<span>Promptless</span>',
        destination: {
          prompt: false,
          display: true,
        },
      },
    ],
    'user_input',
    'user',
  );
  assert.equal(displayOnlyFallback.text, 'Alpha Beta');
  assert.equal(displayOnlyFallback.appliedCount, 0);
  assert.equal(displayOnlyFallback.skippedDisplayOnlyRuleCount, 1);

  const worldInfoLocalRegex = applyLocalWorkflowRegexForTest(
    '秘密摘要',
    [
      {
        id: 'local_world_info',
        find_regex: '/秘密/g',
        replace_string: '公开',
        source: {
          user_input: false,
          ai_output: false,
          world_info: true,
          reasoning: false,
        },
      },
    ],
    'world_info',
    'system',
  );
  assert.equal(worldInfoLocalRegex.text, '公开摘要');
  assert.equal(worldInfoLocalRegex.appliedCount, 1);
}

function validateRuntimeTriggerGuards(): void {
  resetRuntimeState();
  assert.equal(consumeDryRunPromptPreview(), false);

  markDryRunPromptPreview(600);
  assert.equal(clearDryRunPromptPreview(), true);
  assert.equal(consumeDryRunPromptPreview(), false);

  markDryRunPromptPreview(600);
  assert.equal(consumeDryRunPromptPreview(), true);
  assert.equal(consumeDryRunPromptPreview(), false);

  const runtime = globalThis as typeof globalThis & {
    Mvu?: { isDuringExtraAnalysis?: () => boolean };
    window?: any;
    getActivePinia?: () => any;
  };
  const previousMvu = runtime.Mvu;
  const previousWindow = runtime.window;
  const previousGetActivePinia = runtime.getActivePinia;

  try {
    runtime.Mvu = undefined;
    runtime.getActivePinia = undefined;
    runtime.window = {
      Mvu: {
        isDuringExtraAnalysis: () => true,
      },
      parent: {},
    };

    assert.equal(readMvuExtraAnalysisFlag(), true);
    assert.equal(isMvuExtraAnalysisGuardActive(1000), true);

    runtime.window = {
      Mvu: {
        isDuringExtraAnalysis: () => false,
      },
      parent: {},
    };

    assert.equal(isMvuExtraAnalysisGuardActive(1200), true);
    assert.equal(isMvuExtraAnalysisGuardActive(4000), false);
  } finally {
    runtime.Mvu = previousMvu;
    runtime.window = previousWindow;
    runtime.getActivePinia = previousGetActivePinia;
    resetRuntimeState();
  }
}

function validatePromptViewerSyntheticGenerationGuard(): void {
  resetRuntimeState();

  const runtime = globalThis as typeof globalThis & {
    document?: {
      querySelectorAll?: (selector: string) => Array<{
        textContent?: string;
        querySelector?: (selector: string) => unknown;
      }>;
    };
  };
  const previousDocument = runtime.document;

  try {
    runtime.document = {
      querySelectorAll: (selector: string) => {
        if (selector !== '[role="dialog"]') {
          return [];
        }

        return [
          {
            textContent: '酒馆助手 Prompt Viewer 提示词查看器',
            querySelector: (innerSelector: string) =>
              innerSelector === '.fa-rotate-right.animate-spin' ? {} : null,
          },
        ];
      },
    };

    assert.equal(isTavernHelperPromptViewerRefreshActive(), true);
    assert.equal(hasFreshSendIntent(), false);
    assert.equal(
      shouldSkipTavernHelperPromptViewerSyntheticGeneration(),
      true,
    );

    recordUserSendIntent('用户刚刚点击了发送');
    assert.equal(hasFreshSendIntent(), true);
    assert.equal(
      shouldSkipTavernHelperPromptViewerSyntheticGeneration(),
      false,
    );

    clearSendIntent();
    assert.equal(
      shouldSkipTavernHelperPromptViewerSyntheticGeneration(),
      true,
    );
  } finally {
    runtime.document = previousDocument;
    resetRuntimeState();
  }
}

function validateApiSourceCompatibility(): void {
  assert.equal(normalizeApiSource('mistral'), 'mistralai');
  assert.equal(normalizeApiSource('anthropic'), 'claude');
  assert.equal(normalizeApiSource('unknown-provider'), 'openai');
  assert.equal(
    normalizeApiBaseUrl('openai', 'https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1',
  );
  assert.equal(
    normalizeApiBaseUrl('claude', 'https://api.anthropic.com/v1/messages'),
    'https://api.anthropic.com/v1',
  );

  const openRouterHeaders = buildApiPresetCustomIncludeHeaders({
    api_source: 'openrouter',
    api_key: 'sk-or-secret',
    headers_json: '',
  } as any);
  assert.match(openRouterHeaders, /Authorization: Bearer sk-or-secret/);
  assert.match(openRouterHeaders, /HTTP-Referer:/);
  assert.match(openRouterHeaders, /X-Title:/);

  const aimlapiHeaders = buildApiPresetCustomIncludeHeaders({
    api_source: 'aimlapi',
    api_key: 'sk-aiml-secret',
    headers_json: '',
  } as any);
  assert.match(aimlapiHeaders, /Authorization: Bearer sk-aiml-secret/);
  assert.match(aimlapiHeaders, /HTTP-Referer:/);
  assert.match(aimlapiHeaders, /X-Title:/);

  assert.equal(
    shouldUseGenerateRawCustomApi({
      api_source: 'openrouter',
      headers_json: '',
    } as any),
    false,
  );
  assert.equal(
    shouldUseGenerateRawCustomApi({
      api_source: 'custom',
      headers_json: '',
    } as any),
    true,
  );

  assert.equal(getApiSourceDefinition('claude').transport, 'reverse_proxy');
  assert.equal(getApiSourceDefinition('claude').supportsStProxyModels, true);
  assert.equal(getApiSourceDefinition('groq').transport, 'custom_headers');
}

function validateGenerateRawInvocationUsesPromptMessages(): void {
  const orderedPrompts = [
    { role: 'system', content: 'worldInfoBefore block' },
    { role: 'system', content: 'charDescription' },
    { role: 'user', content: '{"hello":"world"}' },
  ] as const;
  const invocation = buildGenerateRawInvocationForTest(
    {
      behavior_options: {
        structured_output: 'off',
      },
    } as any,
    [...orderedPrompts],
    {
      generation_id: 'req:flow',
      should_stream: false,
      should_silence: true,
    },
  );

  assert.deepEqual(invocation.prompt, orderedPrompts);
  assert.equal('ordered_prompts' in invocation, false);
  assert.equal(invocation.generation_id, 'req:flow');
}

function main(): void {
  validateSharedSettingsSanitization();
  validateExtensionBucketFallback();
  validateDebugRedaction();
  validateDebugHighlightSegmentation();
  validateDynConflictSemantics();
  validateRunWarningSemantics();
  validateSnapshotResolutionSafety();
  validateMessageVersioningPrefersRawMessage();
  validateStructuredOutputAugment();
  validateStructuredOutputFallbackDetection();
  validateWorkflowRegexPipeline();
  validateRuntimeTriggerGuards();
  validatePromptViewerSyntheticGenerationGuard();
  validateApiSourceCompatibility();
  validateGenerateRawInvocationUsesPromptMessages();
  console.log('validate:critical passed');
}

main();
