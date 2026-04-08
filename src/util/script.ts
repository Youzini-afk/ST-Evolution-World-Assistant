const ROOT_ID = 'evolution-world-assistant-root';
const STYLE_ID = 'evolution-world-assistant-style-anchor';

export function createScriptIdDiv(): JQuery<HTMLDivElement> {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    return $(existing as HTMLDivElement);
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  return $(root as HTMLDivElement);
}

export function teleportStyle(): { destroy: () => void } {
  let anchor = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!anchor) {
    anchor = document.createElement('style');
    anchor.id = STYLE_ID;
    anchor.textContent = '';
    document.head?.appendChild(anchor);
  }

  return {
    destroy: () => {
      anchor?.remove();
      anchor = null;
    },
  };
}
