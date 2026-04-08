import { disposeGlobalApi, initGlobalApi } from './api';
import { disposeRuntimeEvents, initRuntimeEvents } from './events';
import { scheduleHideSettingsApply } from './hide-engine';
import { getSettings, hydrateSharedSettings, loadLastIo, loadLastRun, loadSettings } from './settings';

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initRuntime() {
  if (initialized) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    loadSettings();
    loadLastRun();
    loadLastIo();
    await hydrateSharedSettings();
    initGlobalApi();
    initRuntimeEvents();
    scheduleHideSettingsApply(getSettings().hide_settings, 220);

    // 不再通过酒馆助手的 initializeGlobal 注册全局变量，
    // 避免框架将 EvolutionWorldAPI（含 getConfig()）序列化写入角色卡变量。
    // EvolutionWorldAPI 已由 initGlobalApi() 直接挂载到 window，外部脚本仍可访问。

    initialized = true;
    console.info('[Evolution World] runtime initialized');
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export function disposeRuntime() {
  if (!initialized) {
    return;
  }

  disposeRuntimeEvents();
  disposeGlobalApi();

  initialized = false;
  console.info('[Evolution World] runtime disposed');
}
