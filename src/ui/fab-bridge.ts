const FAB_VISIBILITY_EVENT_NAME = "ew:assistant:set-fab-visibility";

export function getFabVisibilityEventName(): string {
  return FAB_VISIBILITY_EVENT_NAME;
}

export function requestFabVisibility(visible: boolean): void {
  window.dispatchEvent(
    new CustomEvent(FAB_VISIBILITY_EVENT_NAME, {
      detail: { visible },
    }),
  );
}
