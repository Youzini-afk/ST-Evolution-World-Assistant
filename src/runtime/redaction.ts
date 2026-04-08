import { EwFlowConfig, EwSettings, EwSettingsSchema, LastIoSummary, LastIoSummarySchema } from './types';

export const REDACTED_SECRET = '[REDACTED]';

type SecretBearingFlow = Pick<EwFlowConfig, 'id' | 'name' | 'api_url' | 'api_key' | 'headers_json'>;

function normalizeLookupName(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function buildFlowLookup(flows: SecretBearingFlow[]): {
  byId: Map<string, SecretBearingFlow>;
  byName: Map<string, SecretBearingFlow>;
} {
  const byId = new Map<string, SecretBearingFlow>();
  const byName = new Map<string, SecretBearingFlow>();

  for (const flow of flows) {
    if (flow.id.trim() && !byId.has(flow.id.trim())) {
      byId.set(flow.id.trim(), flow);
    }

    const normalizedName = normalizeLookupName(flow.name);
    if (normalizedName && !byName.has(normalizedName)) {
      byName.set(normalizedName, flow);
    }
  }

  return { byId, byName };
}

function resolveSecretSource<T extends { id: string; name: string }>(
  item: T,
  byId: Map<string, T>,
  byName: Map<string, T>,
): T | null {
  const byExactId = byId.get(String(item.id ?? '').trim());
  if (byExactId) {
    return byExactId;
  }

  const byNormalizedName = byName.get(normalizeLookupName(item.name));
  if (byNormalizedName) {
    return byNormalizedName;
  }

  return null;
}

function fillSecretField(currentValue: string, fallbackValue: string): string {
  return currentValue.trim() ? currentValue : fallbackValue.trim();
}

function redactHeaderLines(value: string): string {
  const lines = String(value ?? '').split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return '';
      }

      const separatorIndex = trimmed.indexOf(':');
      if (separatorIndex < 0) {
        return REDACTED_SECRET;
      }

      const headerName = trimmed.slice(0, separatorIndex).trim();
      return `${headerName}: ${REDACTED_SECRET}`;
    })
    .join('\n')
    .trim();
}

function isSecretPath(path: string[]): boolean {
  const last = String(path[path.length - 1] ?? '').toLowerCase();
  const prev = String(path[path.length - 2] ?? '').toLowerCase();

  return (
    last === 'api_key' ||
    last === 'headers_json' ||
    last === 'custom_include_headers' ||
    last === 'proxy_password' ||
    last === 'authorization' ||
    (last === 'key' && prev === 'custom_api')
  );
}

function redactStringByPath(value: string, path: string[]): string {
  const last = String(path[path.length - 1] ?? '').toLowerCase();

  if (last === 'custom_include_headers') {
    return redactHeaderLines(value);
  }

  if (isSecretPath(path)) {
    return REDACTED_SECRET;
  }

  return redactSensitiveText(value);
}

export function sanitizeSettingsForShared(settings: EwSettings): EwSettings {
  return EwSettingsSchema.parse({
    ...settings,
    api_presets: settings.api_presets.map((preset) => ({
      ...preset,
      api_key: '',
      headers_json: '',
    })),
    flows: settings.flows.map((flow) => ({
      ...flow,
      api_key: '',
      headers_json: '',
    })),
  });
}

export function mergeSharedSettingsWithLocalSecrets(shared: EwSettings, local: EwSettings): EwSettings {
  const localPresetById = new Map(local.api_presets.map((preset) => [preset.id.trim(), preset]));
  const localPresetByName = new Map(
    local.api_presets.map((preset) => [normalizeLookupName(preset.name), preset]),
  );
  const localFlows = buildFlowLookup(local.flows);

  return EwSettingsSchema.parse({
    ...shared,
    api_presets: shared.api_presets.map((preset) => {
      const source =
        localPresetById.get(preset.id.trim()) ??
        localPresetByName.get(normalizeLookupName(preset.name)) ??
        null;

      if (!source) {
        return preset;
      }

      return {
        ...preset,
        api_key: fillSecretField(preset.api_key, source.api_key),
        headers_json: fillSecretField(preset.headers_json, source.headers_json),
      };
    }),
    flows: shared.flows.map((flow) => {
      const source = resolveSecretSource(flow, localFlows.byId, localFlows.byName);
      if (!source) {
        return flow;
      }

      return {
        ...flow,
        api_key: fillSecretField(flow.api_key, source.api_key),
        headers_json: fillSecretField(flow.headers_json, source.headers_json),
      };
    }),
  });
}

export function redactSensitiveText(value: string): string {
  let next = String(value ?? '');

  next = next.replace(/(Authorization\s*:\s*)(.+)/gi, (_match, prefix) => `${prefix}${REDACTED_SECRET}`);
  next = next.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${REDACTED_SECRET}`);
  next = next.replace(/("api_key"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED_SECRET}$3`);
  next = next.replace(/("proxy_password"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED_SECRET}$3`);
  next = next.replace(/("Authorization"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED_SECRET}$3`);
  next = next.replace(/("custom_include_headers"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED_SECRET}$3`);
  next = next.replace(/("headers_json"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED_SECRET}$3`);
  next = next.replace(/("key"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED_SECRET}$3`);

  return next;
}

export function redactDebugPayload(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactDebugPayload(item, [...path, String(index)]));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        redactDebugPayload(nestedValue, [...path, key]),
      ]),
    );
  }

  if (typeof value === 'string') {
    return redactStringByPath(value, path);
  }

  return value;
}

export function sanitizeLastIoSummary(summary: LastIoSummary): LastIoSummary {
  return LastIoSummarySchema.parse({
    ...summary,
    flows: summary.flows.map((flow) => ({
      ...flow,
      error: redactSensitiveText(flow.error),
      request_preview: redactSensitiveText(flow.request_preview),
      response_preview: redactSensitiveText(flow.response_preview),
    })),
  });
}
