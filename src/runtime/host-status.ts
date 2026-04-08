export type EwHostEventTypesSource = "eventTypes" | "event_types" | "missing";
export type EwBeforeReplySource = "idle" | "primary" | "fallback";
export type EwSendIntentHookStatus = "ready" | "degraded";
export type EwUnsupportedContextReason =
  | "group_chat_unsupported"
  | "no_active_character"
  | null;
export type EwSettingsMigrationSource =
  | "assistant"
  | "legacy:evolution_world"
  | "legacy:script_local_storage"
  | "initialized_empty"
  | "unknown";

export type EwHostStatus = {
  eventTypesSource: EwHostEventTypesSource;
  beforeReplySource: EwBeforeReplySource;
  sendIntentHookStatus: EwSendIntentHookStatus;
  unsupportedContextReason: EwUnsupportedContextReason;
  settingsMigrationSource: EwSettingsMigrationSource;
};

type HostStatusListener = (status: EwHostStatus) => void;

const hostStatus: EwHostStatus = {
  eventTypesSource: "missing",
  beforeReplySource: "idle",
  sendIntentHookStatus: "degraded",
  unsupportedContextReason: null,
  settingsMigrationSource: "unknown",
};

const listeners = new Set<HostStatusListener>();

function emitIfChanged(nextStatus: EwHostStatus): void {
  if (
    nextStatus.eventTypesSource === hostStatus.eventTypesSource &&
    nextStatus.beforeReplySource === hostStatus.beforeReplySource &&
    nextStatus.sendIntentHookStatus === hostStatus.sendIntentHookStatus &&
    nextStatus.unsupportedContextReason === hostStatus.unsupportedContextReason &&
    nextStatus.settingsMigrationSource === hostStatus.settingsMigrationSource
  ) {
    return;
  }

  hostStatus.eventTypesSource = nextStatus.eventTypesSource;
  hostStatus.beforeReplySource = nextStatus.beforeReplySource;
  hostStatus.sendIntentHookStatus = nextStatus.sendIntentHookStatus;
  hostStatus.unsupportedContextReason = nextStatus.unsupportedContextReason;
  hostStatus.settingsMigrationSource = nextStatus.settingsMigrationSource;

  const snapshot = getHostStatus();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function updateHostStatus(patch: Partial<EwHostStatus>): void {
  emitIfChanged({
    eventTypesSource: patch.eventTypesSource ?? hostStatus.eventTypesSource,
    beforeReplySource: patch.beforeReplySource ?? hostStatus.beforeReplySource,
    sendIntentHookStatus:
      patch.sendIntentHookStatus ?? hostStatus.sendIntentHookStatus,
    unsupportedContextReason:
      patch.unsupportedContextReason ?? hostStatus.unsupportedContextReason,
    settingsMigrationSource:
      patch.settingsMigrationSource ?? hostStatus.settingsMigrationSource,
  });
}

export function getHostStatus(): EwHostStatus {
  return { ...hostStatus };
}

export function subscribeHostStatus(
  listener: HostStatusListener,
): { stop: () => void } {
  listeners.add(listener);
  listener(getHostStatus());
  return {
    stop: () => listeners.delete(listener),
  };
}

export function setEventTypesSource(source: EwHostEventTypesSource): void {
  updateHostStatus({ eventTypesSource: source });
}

export function setBeforeReplySource(source: EwBeforeReplySource): void {
  updateHostStatus({ beforeReplySource: source });
}

export function resetBeforeReplySource(): void {
  updateHostStatus({ beforeReplySource: "idle" });
}

export function setSendIntentHookStatus(
  status: EwSendIntentHookStatus,
): void {
  updateHostStatus({ sendIntentHookStatus: status });
}

export function setUnsupportedContextReason(
  reason: EwUnsupportedContextReason,
): void {
  updateHostStatus({ unsupportedContextReason: reason });
}

export function setSettingsMigrationSource(
  source: EwSettingsMigrationSource,
): void {
  updateHostStatus({ settingsMigrationSource: source });
}
