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
import { mergeSharedSettingsWithLocalFallback as mergeSharedSettingsWithLocalFallbackFromSettings } from '../src/runtime/settings';
import { buildDebugHighlightSegments } from '../src/ui/debug-highlight';
import { collectDynWriteConflictsForTest } from '../src/runtime/transaction';
import { buildRunWarningFromCommitSummaryForTest } from '../src/runtime/pipeline';
import { isSnapshotResolutionUnsafeForDestructiveWriteForTest } from '../src/runtime/floor-binding';

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

function main(): void {
  validateSharedSettingsSanitization();
  validateExtensionBucketFallback();
  validateDebugRedaction();
  validateDebugHighlightSegmentation();
  validateDynConflictSemantics();
  validateRunWarningSemantics();
  validateSnapshotResolutionSafety();
  console.log('validate:critical passed');
}

main();
