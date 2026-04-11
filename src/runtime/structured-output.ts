import JSON5 from 'json5';

export type EwStructuredOutputMode = 'off' | 'json_object';
export type EwStructuredOutputTransportMode = 'off' | 'response_format_json_object' | 'json_schema_fallback';

export type EwStructuredOutputSchema = {
  name: string;
  description: string;
  strict: boolean;
  value: Record<string, any>;
};

export type EwStructuredOutputRequestAugment = {
  transportMode: EwStructuredOutputTransportMode;
  customIncludeBody?: string;
  jsonSchema?: EwStructuredOutputSchema;
  note?: string;
};

const JSON_OBJECT_RESPONSE_FORMAT_BODY = {
  response_format: {
    type: 'json_object',
  },
};

const JSON_OBJECT_SCHEMA: EwStructuredOutputSchema = {
  name: 'ew_flow_json_object',
  description: 'Return a valid JSON object.',
  strict: false,
  value: {
    type: 'object',
    additionalProperties: true,
  },
};

export function isJsonObjectStructuredOutputMode(mode: string | null | undefined): mode is 'json_object' {
  return String(mode ?? '').trim() === 'json_object';
}

export function buildJsonObjectStructuredSchema(): EwStructuredOutputSchema {
  return {
    ...JSON_OBJECT_SCHEMA,
    value: {
      ...JSON_OBJECT_SCHEMA.value,
    },
  };
}

function mergeJsonObjectResponseFormatIntoCustomIncludeBody(existingBody: string): {
  customIncludeBody?: string;
  note?: string;
} {
  const trimmed = existingBody.trim();
  if (!trimmed) {
    return {
      customIncludeBody: JSON.stringify(JSON_OBJECT_RESPONSE_FORMAT_BODY, null, 2),
    };
  }

  try {
    const parsed = JSON5.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        note: 'custom_include_body 不是 JSON/JSON5 对象，已改用宽松 JSON Schema 兼容模式。',
      };
    }

    return {
      customIncludeBody: JSON.stringify(
        {
          ...(parsed as Record<string, any>),
          ...JSON_OBJECT_RESPONSE_FORMAT_BODY,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    return {
      note: `custom_include_body 无法解析为 JSON/JSON5 对象，已改用宽松 JSON Schema 兼容模式：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function buildStructuredOutputRequestAugment(
  mode: EwStructuredOutputMode | string | null | undefined,
  chatCompletionSource: string | null | undefined,
  existingCustomIncludeBody: string | null | undefined,
): EwStructuredOutputRequestAugment {
  if (!isJsonObjectStructuredOutputMode(mode)) {
    return {
      transportMode: 'off',
    };
  }

  let fallbackNote: string | undefined;

  if (String(chatCompletionSource ?? '').trim() === 'custom') {
    const merged = mergeJsonObjectResponseFormatIntoCustomIncludeBody(String(existingCustomIncludeBody ?? ''));
    if (merged.customIncludeBody) {
      return {
        transportMode: 'response_format_json_object',
        customIncludeBody: merged.customIncludeBody,
        ...(merged.note ? { note: merged.note } : {}),
      };
    }
    fallbackNote = merged.note;
  }

  return {
    transportMode: 'json_schema_fallback',
    jsonSchema: buildJsonObjectStructuredSchema(),
    ...(fallbackNote ? { note: fallbackNote } : {}),
  };
}
