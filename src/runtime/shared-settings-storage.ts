import { getRequestHeaders } from '../st-adapter';

import { sanitizeSettingsForShared } from './redaction';
import { EwSettings } from './types';

const SHARED_SETTINGS_FILE_NAME = 'ew__assistant_settings.shared.json';

type SharedSettingsPayload = {
  version: 'ew-settings/v1';
  updated_at: number;
  settings: EwSettings;
};

async function getHeaders(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    ...getRequestHeaders(),
  };
}

export async function readSharedSettings(): Promise<SharedSettingsPayload | null> {
  try {
    const response = await fetch(`/user/files/${SHARED_SETTINGS_FILE_NAME}`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (
      data &&
      data.version === 'ew-settings/v1' &&
      typeof data.updated_at === 'number' &&
      _.isPlainObject(data.settings)
    ) {
      return data as SharedSettingsPayload;
    }

    console.warn('[Evolution World] Invalid shared settings payload:', data);
    return null;
  } catch (error) {
    console.warn('[Evolution World] Failed to read shared settings:', error);
    return null;
  }
}

export async function writeSharedSettings(settings: EwSettings): Promise<void> {
  const sanitizedSettings = sanitizeSettingsForShared(settings);
  const payload: SharedSettingsPayload = {
    version: 'ew-settings/v1',
    updated_at: Date.now(),
    settings: sanitizedSettings,
  };
  const jsonContent = JSON.stringify(payload);
  const base64Content = btoa(unescape(encodeURIComponent(jsonContent)));

  const response = await fetch('/api/files/upload', {
    method: 'POST',
    headers: await getHeaders(),
    body: JSON.stringify({ name: SHARED_SETTINGS_FILE_NAME, data: base64Content }),
  });

  if (!response.ok) {
    throw new Error(`[Evolution World] Failed to write shared settings: ${response.status} ${response.statusText}`);
  }
}

export { SHARED_SETTINGS_FILE_NAME };
