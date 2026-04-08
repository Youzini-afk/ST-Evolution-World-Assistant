import { getHostDocument, getHostRuntime } from '../st-adapter';

export type EwNoticeLevel = 'success' | 'error' | 'info' | 'warning';

type EwNoticeAction = {
  label: string;
  onClick: () => void;
  kind?: 'neutral' | 'danger';
};

export type EwNoticeInput = {
  title: string;
  message: string;
  level?: EwNoticeLevel;
  duration_ms?: number;
  persist?: boolean;
  busy?: boolean;
  action?: EwNoticeAction;
};

export type EwWorkflowNoticeInput = EwNoticeInput & {
  collapse_after_ms?: number;
  island?: {
    entry_name?: string;
    content?: string;
    extra_count?: number;
  };
  workflow_name?: string;
  flow_progress?: { completed: number; total: number; failed?: number };
};

export type EwNoticeHandle = {
  update: (nextInput: EwNoticeInput) => void;
  dismiss: () => void;
};

export type EwWorkflowNoticeHandle = {
  update: (nextInput: EwWorkflowNoticeInput) => void;
  dismiss: () => void;
  collapse: () => void;
  expand: () => void;
};

const STYLE_ID = 'ew-floating-notice-style';
const HOST_ID = 'ew-floating-notice-host';
const WORKFLOW_STYLE_ID = 'ew-workflow-notice-style';
const WORKFLOW_HOST_ID = 'ew-workflow-notice-host';

function resolveNoticeDocument(): Document {
  const runtime = getHostRuntime();
  const chatDocument = runtime.SillyTavern?.Chat?.document;
  if (chatDocument && typeof chatDocument.querySelector === 'function') {
    return chatDocument as Document;
  }

  return getHostDocument();
}

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }

  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${HOST_ID} {
      position: fixed;
      top: 14px;
      left: 14px;
      z-index: 12000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: min(420px, calc(100vw - 28px));
      pointer-events: none;
    }

    .ew-floating-notice {
      --ew-notice-accent: #73b8ff;
      position: relative;
      pointer-events: auto;
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: start;
      gap: 12px;
      padding: 12px 12px 12px 10px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--ew-notice-accent) 48%, rgba(255, 255, 255, 0.2));
      background:
        linear-gradient(140deg, rgba(31, 46, 66, 0.9), rgba(16, 27, 40, 0.86)),
        radial-gradient(circle at 10% -10%, color-mix(in srgb, var(--ew-notice-accent) 30%, transparent), transparent 52%);
      color: #e9f0f8;
      box-shadow:
        0 14px 34px rgba(5, 10, 16, 0.52),
        0 0 0 1px rgba(255, 255, 255, 0.06) inset;
      backdrop-filter: blur(10px) saturate(125%);
      -webkit-backdrop-filter: blur(10px) saturate(125%);
      overflow: hidden;
      transform: translateY(-8px) scale(0.985);
      opacity: 0;
      animation: ewNoticeIn 190ms ease forwards;
      font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
    }

    .ew-floating-notice::after {
      content: '';
      position: absolute;
      inset: 0;
      border-left: 3px solid var(--ew-notice-accent);
      border-radius: 14px;
      pointer-events: none;
      opacity: 0.9;
    }

    .ew-floating-notice--out {
      animation: ewNoticeOut 160ms ease forwards;
    }

    .ew-floating-notice__icon {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 800;
      color: #f4f8ff;
      background: color-mix(in srgb, var(--ew-notice-accent) 28%, rgba(6, 12, 20, 0.6));
      border: 1px solid color-mix(in srgb, var(--ew-notice-accent) 54%, transparent);
      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.16);
      flex: 0 0 auto;
    }

    .ew-floating-notice[data-busy='true'] .ew-floating-notice__icon {
      animation: ewNoticeBusy 900ms linear infinite;
    }

    .ew-floating-notice__content {
      min-width: 0;
    }

    .ew-floating-notice__title {
      margin: 0;
      font-size: 19px;
      line-height: 1.16;
      font-weight: 800;
      letter-spacing: 0.01em;
      color: #f0f6ff;
    }

    .ew-floating-notice__message {
      margin: 4px 0 0;
      font-size: 15px;
      line-height: 1.34;
      color: color-mix(in srgb, #f0f6ff 86%, #91a6bc);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .ew-floating-notice__actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .ew-floating-notice__action {
      min-height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.08);
      color: #eef4ff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    }

    .ew-floating-notice__action:hover,
    .ew-floating-notice__action:focus-visible {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.24);
      transform: translateY(-1px);
      outline: none;
    }

    .ew-floating-notice__action[data-kind='danger'] {
      background: rgba(245, 123, 143, 0.16);
      border-color: rgba(245, 123, 143, 0.42);
      color: #ffd9df;
    }

    .ew-floating-notice__action[data-kind='danger']:hover,
    .ew-floating-notice__action[data-kind='danger']:focus-visible {
      background: rgba(245, 123, 143, 0.24);
      border-color: rgba(245, 123, 143, 0.58);
    }

    .ew-floating-notice__close {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.08);
      color: #d7e0ec;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      transition: background 140ms ease;
    }

    .ew-floating-notice__close:hover,
    .ew-floating-notice__close:focus-visible {
      background: rgba(255, 255, 255, 0.2);
      outline: none;
    }

    .ew-floating-notice__progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 2px;
      width: 100%;
      background: linear-gradient(90deg, var(--ew-notice-accent), rgba(255, 255, 255, 0.25));
      transform-origin: left center;
      animation: ewNoticeProgress linear forwards;
    }

    .ew-floating-notice[data-level='success'] {
      --ew-notice-accent: #65d39c;
    }

    .ew-floating-notice[data-level='error'] {
      --ew-notice-accent: #f57b8f;
    }

    .ew-floating-notice[data-level='warning'] {
      --ew-notice-accent: #eab96f;
    }

    @keyframes ewNoticeIn {
      to {
        transform: translateY(0) scale(1);
        opacity: 1;
      }
    }

    @keyframes ewNoticeOut {
      to {
        transform: translateY(-6px) scale(0.98);
        opacity: 0;
      }
    }

    @keyframes ewNoticeProgress {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }

    @keyframes ewNoticeBusy {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    @media (max-width: 900px) {
      #${HOST_ID} {
        top: 8px;
        left: 8px;
        width: calc(100vw - 16px);
      }

      .ew-floating-notice__title {
        font-size: 17px;
      }

      .ew-floating-notice__message {
        font-size: 14px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .ew-floating-notice,
      .ew-floating-notice--out,
      .ew-floating-notice__progress {
        animation-duration: 1ms !important;
      }
    }
  `;

  (doc.head || doc.documentElement).appendChild(style);
}

function ensureHost(doc: Document): HTMLElement {
  let host = doc.getElementById(HOST_ID);
  if (host) {
    return host;
  }

  host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'false');
  (doc.body || doc.documentElement).appendChild(host);
  return host;
}

function ensureWorkflowStyle(doc: Document) {
  if (doc.getElementById(WORKFLOW_STYLE_ID)) {
    return;
  }

  const style = doc.createElement('style');
  style.id = WORKFLOW_STYLE_ID;
  style.textContent = `
    #${WORKFLOW_HOST_ID} {
      position: fixed;
      top: 8px;
      left: 0;
      right: 0;
      z-index: 12010;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 0 12px;
      pointer-events: none;
    }

    .ew-workflow-notice {
      --ew-notice-accent: #73b8ff;
      width: min(520px, calc(100vw - 24px));
      pointer-events: auto;
      position: relative;
      color: #eef5ff;
      border-radius: 18px;
      border: 1px solid color-mix(in srgb, var(--ew-notice-accent) 42%, rgba(255, 255, 255, 0.18));
      background:
        radial-gradient(circle at 12% -18%, color-mix(in srgb, var(--ew-notice-accent) 22%, transparent), transparent 52%),
        radial-gradient(circle at 88% 120%, rgba(60, 100, 180, 0.06), transparent 50%),
        linear-gradient(135deg, rgba(8, 20, 40, 0.96), rgba(4, 12, 26, 0.94));
      box-shadow:
        0 18px 40px rgba(3, 8, 17, 0.48),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset;
      backdrop-filter: blur(24px) saturate(150%);
      -webkit-backdrop-filter: blur(24px) saturate(150%);
      transform: translateY(-12px) scale(0.92);
      opacity: 0;
      animation: ewWorkflowNoticeIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      overflow: hidden;
      transition:
        width 240ms ease,
        border-radius 240ms ease,
        box-shadow 240ms ease,
        background 240ms ease,
        transform 220ms ease,
        border-color 1.5s ease;
      cursor: pointer;
    }

    /* border breathing glow — only when busy */
    .ew-workflow-notice[data-busy='true'] {
      animation: ewWorkflowNoticeIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards, ewBorderGlow 3s ease-in-out infinite 0.4s;
    }

    .ew-workflow-notice::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      border: 1px solid rgba(255, 255, 255, 0.05);
      pointer-events: none;
    }

    .ew-workflow-notice[data-level='success'] {
      --ew-notice-accent: #65d39c;
    }

    .ew-workflow-notice[data-level='error'] {
      --ew-notice-accent: #f57b8f;
    }

    .ew-workflow-notice[data-level='warning'] {
      --ew-notice-accent: #eab96f;
    }

    .ew-workflow-notice[data-collapsed='true'] {
      width: auto;
      min-width: 72px;
      max-width: min(760px, calc(100vw - 20px));
      border-radius: 999px;
      box-shadow:
        0 14px 30px rgba(3, 8, 17, 0.42),
        0 0 0 1px rgba(255, 255, 255, 0.05) inset;
      transform: translateY(0) scale(1);
      cursor: pointer;
    }

    .ew-workflow-notice__card {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: start;
      gap: 12px;
      padding: 12px 12px 12px 10px;
    }

    .ew-workflow-notice[data-collapsed='true'] .ew-workflow-notice__card {
      display: none;
    }

    .ew-workflow-notice__icon {
      width: 38px;
      height: 38px;
      border-radius: 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 800;
      color: #f4f8ff;
      background: color-mix(in srgb, var(--ew-notice-accent) 28%, rgba(6, 12, 20, 0.6));
      border: 1px solid color-mix(in srgb, var(--ew-notice-accent) 54%, transparent);
      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.16);
    }

    .ew-workflow-notice[data-busy='true'] .ew-workflow-notice__icon {
      animation: ewNoticeBusy 900ms linear infinite;
    }

    .ew-workflow-notice__content {
      min-width: 0;
    }

    .ew-workflow-notice__title {
      margin: 0;
      font-size: 19px;
      line-height: 1.16;
      font-weight: 800;
      letter-spacing: 0.01em;
      color: #f0f6ff;
    }

    .ew-workflow-notice__message {
      margin: 4px 0 0;
      font-size: 15px;
      line-height: 1.34;
      color: color-mix(in srgb, #f0f6ff 86%, #91a6bc);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .ew-workflow-notice__actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .ew-workflow-notice__action {
      min-height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.08);
      color: #eef4ff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    }

    .ew-workflow-notice__action:hover,
    .ew-workflow-notice__action:focus-visible {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.24);
      transform: translateY(-1px);
      outline: none;
    }

    .ew-workflow-notice__action[data-kind='danger'] {
      background: rgba(245, 123, 143, 0.16);
      border-color: rgba(245, 123, 143, 0.42);
      color: #ffd9df;
    }

    .ew-workflow-notice__action[data-kind='danger']:hover,
    .ew-workflow-notice__action[data-kind='danger']:focus-visible {
      background: rgba(245, 123, 143, 0.24);
      border-color: rgba(245, 123, 143, 0.58);
    }

    .ew-workflow-notice__close {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.08);
      color: #d7e0ec;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      transition: background 140ms ease;
    }

    .ew-workflow-notice__close:hover,
    .ew-workflow-notice__close:focus-visible {
      background: rgba(255, 255, 255, 0.2);
      outline: none;
    }

    .ew-workflow-notice__progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 2px;
      width: 100%;
      background: linear-gradient(90deg, var(--ew-notice-accent), rgba(255, 255, 255, 0.25));
      transform-origin: left center;
      animation: ewNoticeProgress linear forwards;
    }

    .ew-workflow-notice[data-collapsed='true'] .ew-workflow-notice__progress {
      opacity: 0;
    }

    .ew-workflow-notice__island {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 8px 12px;
      min-height: 48px;
    }

    .ew-workflow-notice[data-collapsed='true'] .ew-workflow-notice__island {
      display: flex;
    }

    .ew-workflow-notice__island-slot {
      max-width: min(280px, 36vw);
      min-width: 0;
      padding: 7px 14px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.06);
      color: #edf4ff;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.01em;
    }

    .ew-workflow-notice__island-slot--content {
      color: color-mix(in srgb, #f2f7ff 88%, #98afc8);
      font-weight: 600;
    }

    /* A: inner text wrapper for marquee scroll */
    .ew-workflow-notice__island-text {
      display: inline-block;
      white-space: nowrap;
    }

    /* A: marquee scroll — animate inner text only, container stays fixed */
    .ew-workflow-notice__island-slot--content[data-overflow='true'] {
      text-overflow: clip;
    }
    .ew-workflow-notice__island-slot--content[data-overflow='true'] .ew-workflow-notice__island-text {
      animation: ewIslandScroll 8s linear infinite;
      animation-delay: 2s;
    }

    /* D: +N badge for multi-flow */
    .ew-workflow-notice__island-extra {
      min-width: 22px;
      height: 18px;
      padding: 0 6px;
      border-radius: 999px;
      border: 1px solid rgba(163, 207, 255, 0.36);
      background: rgba(13, 30, 52, 0.92);
      color: #eef5ff;
      font-size: 11px;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .ew-workflow-notice[data-has-preview='false'] .ew-workflow-notice__island-slot {
      display: none;
    }

    .ew-workflow-notice__island-orb {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      position: relative;
      flex: 0 0 auto;
      overflow: hidden;
      background: #184477;
      border: 2px solid #6fa4ea;
      box-shadow:
        0 10px 18px rgba(3, 8, 17, 0.28),
        0 0 14px rgba(96, 159, 255, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
      transition: border-color 400ms ease, box-shadow 400ms ease;
    }

    .ew-workflow-notice__island-orb::before {
      content: '';
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      background: #ffe27a;
      box-shadow:
        inset 2px 2px 0 rgba(255, 247, 196, 0.95),
        inset -2px -2px 0 rgba(219, 177, 58, 0.45),
        0 0 6px rgba(255, 226, 122, 0.14);
      transition: background 500ms ease, box-shadow 500ms ease;
    }

    .ew-workflow-notice__island-orb::after {
      content: '';
      position: absolute;
      top: 4px;
      left: -20px;
      width: 26px;
      height: 24px;
      border-radius: inherit;
      background: #102746;
      box-shadow:
        46px 0 0 #102746,
        inset 1px 0 0 rgba(255, 255, 255, 0.04);
      transform: translate3d(0, 0, 0);
      will-change: transform;
      animation: ewWorkflowMoonPhase 4.8s linear infinite;
      transition: transform 600ms ease;
    }

    .ew-workflow-notice[data-busy='false'] .ew-workflow-notice__island-orb::after {
      animation-duration: 7.4s;
    }

    /* B: success full moon — gold, shadow mask slides away */
    .ew-workflow-notice__island-orb[data-moon='full']::before {
      background: #ffe27a;
      box-shadow:
        inset 2px 2px 0 rgba(255, 247, 196, 0.95),
        inset -2px -2px 0 rgba(219, 177, 58, 0.45),
        0 0 12px rgba(255, 226, 122, 0.6);
    }
    .ew-workflow-notice__island-orb[data-moon='full']::after {
      animation: none;
      transform: translate3d(-30px, 0, 0);
    }
    .ew-workflow-notice__island-orb[data-moon='full'] {
      border-color: #eac85a;
      box-shadow:
        0 8px 16px rgba(3, 8, 17, 0.24),
        0 0 18px rgba(255, 226, 122, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
    }

    /* B: failure blood moon — red, shadow mask slides away */
    .ew-workflow-notice__island-orb[data-moon='blood']::before {
      background: #e84060;
      box-shadow:
        inset 2px 2px 0 rgba(255, 140, 160, 0.6),
        inset -2px -2px 0 rgba(180, 40, 60, 0.45),
        0 0 12px rgba(232, 64, 96, 0.5);
    }
    .ew-workflow-notice__island-orb[data-moon='blood']::after {
      animation: none;
      transform: translate3d(-30px, 0, 0);
    }
    .ew-workflow-notice__island-orb[data-moon='blood'] {
      border-color: #c44060;
      box-shadow:
        0 8px 16px rgba(3, 8, 17, 0.24),
        0 0 18px rgba(232, 64, 96, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
    }

    .ew-workflow-notice--out {
      animation: ewNoticeOut 160ms ease forwards;
    }

    /* G: spring enter animation */
    @keyframes ewWorkflowNoticeIn {
      0%   { transform: translateY(-12px) scale(0.92); opacity: 0; }
      60%  { transform: translateY(2px) scale(1.01); opacity: 1; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }

    /* G: spring exit animation */
    @keyframes ewNoticeOut {
      0%   { transform: translateY(0) scale(1); opacity: 1; }
      100% { transform: translateY(-16px) scale(0.94); opacity: 0; }
    }

    @keyframes ewWorkflowMoonPhase {
      0%   { transform: translate3d(0, 0, 0); }
      100% { transform: translate3d(46px, 0, 0); }
    }

    /* F: border breathing glow */
    @keyframes ewBorderGlow {
      0%, 100% { border-color: color-mix(in srgb, var(--ew-notice-accent) 42%, rgba(255, 255, 255, 0.18)); }
      50%      { border-color: color-mix(in srgb, var(--ew-notice-accent) 62%, rgba(255, 255, 255, 0.28)); }
    }

    /* A: marquee scroll for long content */
    @keyframes ewIslandScroll {
      0%, 15%  { transform: translateX(0); }
      85%, 100% { transform: translateX(var(--ew-scroll-dist, -50%)); }
    }

    @media (max-width: 900px) {
      .ew-workflow-notice {
        width: min(92vw, 520px);
      }

      .ew-workflow-notice__title {
        font-size: 17px;
      }

      .ew-workflow-notice__message {
        font-size: 14px;
      }

      .ew-workflow-notice__island-slot {
        max-width: min(34vw, 180px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .ew-workflow-notice,
      .ew-workflow-notice--out,
      .ew-workflow-notice__progress,
      .ew-workflow-notice__island-orb::after {
        animation-duration: 1ms !important;
      }
    }
  `;

  (doc.head || doc.documentElement).appendChild(style);
}

function ensureWorkflowHost(doc: Document): HTMLElement {
  let host = doc.getElementById(WORKFLOW_HOST_ID);
  if (host) {
    return host;
  }

  host = doc.createElement('div');
  host.id = WORKFLOW_HOST_ID;
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'false');
  (doc.body || doc.documentElement).appendChild(host);
  return host;
}

function getIcon(level: EwNoticeLevel): string {
  switch (level) {
    case 'success':
      return '✓';
    case 'error':
      return '!';
    case 'warning':
      return '?';
    default:
      return 'i';
  }
}

function applyNoticeState(item: HTMLElement, input: EwNoticeInput, progress: HTMLElement) {
  const level = input.level ?? 'info';

  item.dataset.level = level;
  item.dataset.busy = input.busy ? 'true' : 'false';

  const icon = item.querySelector('.ew-floating-notice__icon');
  if (icon) {
    icon.textContent = input.busy ? '◌' : getIcon(level);
  }

  const title = item.querySelector('.ew-floating-notice__title');
  if (title) {
    title.textContent = input.title;
  }

  const message = item.querySelector('.ew-floating-notice__message');
  if (message) {
    message.textContent = input.message;
  }

  const actionButton = item.querySelector('.ew-floating-notice__action') as HTMLButtonElement | null;
  const actionWrap = item.querySelector('.ew-floating-notice__actions') as HTMLElement | null;
  if (actionButton && actionWrap) {
    if (input.action) {
      actionWrap.style.display = '';
      actionButton.style.display = '';
      actionButton.textContent = input.action.label;
      actionButton.dataset.kind = input.action.kind ?? 'neutral';
    } else {
      actionWrap.style.display = 'none';
      actionButton.style.display = 'none';
      actionButton.textContent = '';
      actionButton.dataset.kind = 'neutral';
    }
  }

  if (input.persist) {
    progress.style.display = 'none';
    progress.style.animationDuration = '';
  } else {
    const duration = Math.max(1400, input.duration_ms ?? 3200);
    progress.style.display = '';
    progress.style.animationDuration = `${duration}ms`;
  }
}

export function showManagedEwNotice(input: EwNoticeInput): EwNoticeHandle {
  const initialDuration = Math.max(1400, input.duration_ms ?? 3200);

  const doc = resolveNoticeDocument();
  ensureStyle(doc);
  const host = ensureHost(doc);

  const item = doc.createElement('article');
  item.className = 'ew-floating-notice';

  const icon = doc.createElement('span');
  icon.className = 'ew-floating-notice__icon';

  const content = doc.createElement('div');
  content.className = 'ew-floating-notice__content';

  const title = doc.createElement('h4');
  title.className = 'ew-floating-notice__title';
  title.textContent = input.title;

  const message = doc.createElement('p');
  message.className = 'ew-floating-notice__message';
  message.textContent = input.message;

  const actions = doc.createElement('div');
  actions.className = 'ew-floating-notice__actions';

  const actionButton = doc.createElement('button');
  actionButton.className = 'ew-floating-notice__action';
  actionButton.type = 'button';
  actionButton.style.display = 'none';
  actionButton.dataset.kind = 'neutral';

  const closeButton = doc.createElement('button');
  closeButton.className = 'ew-floating-notice__close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭提示');
  closeButton.textContent = '×';

  const progress = doc.createElement('div');
  progress.className = 'ew-floating-notice__progress';

  content.appendChild(title);
  content.appendChild(message);
  actions.appendChild(actionButton);
  content.appendChild(actions);
  item.appendChild(icon);
  item.appendChild(content);
  item.appendChild(closeButton);
  item.appendChild(progress);

  applyNoticeState(item, input, progress);

  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let currentAction = input.action?.onClick ?? null;

  const clearCloseTimer = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const close = () => {
    if (closed) {
      return;
    }
    clearCloseTimer();
    closed = true;
    item.classList.add('ew-floating-notice--out');
    setTimeout(() => {
      item.remove();
      if (!host.childElementCount) {
        host.remove();
      }
    }, 170);
  };

  const scheduleAutoClose = (nextInput: EwNoticeInput) => {
    clearCloseTimer();
    if (nextInput.persist) {
      return;
    }

    const duration = Math.max(1400, nextInput.duration_ms ?? initialDuration);
    closeTimer = setTimeout(close, duration);
  };

  const update = (nextInput: EwNoticeInput) => {
    if (closed) {
      return;
    }

    currentAction = nextInput.action?.onClick ?? null;
    applyNoticeState(item, nextInput, progress);
    scheduleAutoClose(nextInput);
  };

  actionButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    currentAction?.();
  });
  closeButton.addEventListener('click', close);
  scheduleAutoClose(input);

  host.appendChild(item);

  return {
    update,
    dismiss: close,
  };
}

export function showEwNotice(input: EwNoticeInput) {
  showManagedEwNotice(input);
}

function applyWorkflowNoticeState(item: HTMLElement, input: EwWorkflowNoticeInput, progress: HTMLElement) {
  const level = input.level ?? 'info';
  const hasPreview = Boolean(input.island?.content?.trim());

  item.dataset.level = level;
  item.dataset.busy = input.busy ? 'true' : 'false';
  item.dataset.hasPreview = hasPreview ? 'true' : 'false';

  const icon = item.querySelector('.ew-workflow-notice__icon');
  if (icon) {
    icon.textContent = input.busy ? '◌' : getIcon(level);
  }

  const title = item.querySelector('.ew-workflow-notice__title');
  if (title) {
    title.textContent = input.title;
  }

  // H: expanded view shows workflow name + flow progress
  const message = item.querySelector('.ew-workflow-notice__message');
  if (message) {
    let text = input.message;
    if (input.flow_progress && input.flow_progress.total > 0) {
      const wfName = input.workflow_name?.trim() || '工作流';
      const failed = Math.max(0, Math.trunc(Number(input.flow_progress.failed ?? 0) || 0));
      text += `\n━━━ ${wfName}  ·  已完成 ${input.flow_progress.completed}/${input.flow_progress.total}`;
      if (failed > 0) {
        text += `，其中 ${failed} 条失败`;
      }
    }
    message.textContent = text;
  }

  const actionButton = item.querySelector('.ew-workflow-notice__action') as HTMLButtonElement | null;
  const actionWrap = item.querySelector('.ew-workflow-notice__actions') as HTMLElement | null;
  if (actionButton && actionWrap) {
    if (input.action) {
      actionWrap.style.display = '';
      actionButton.style.display = '';
      actionButton.textContent = input.action.label;
      actionButton.dataset.kind = input.action.kind ?? 'neutral';
    } else {
      actionWrap.style.display = 'none';
      actionButton.style.display = 'none';
      actionButton.textContent = '';
      actionButton.dataset.kind = 'neutral';
    }
  }

  const islandName = item.querySelector('.ew-workflow-notice__island-slot--name');
  if (islandName) {
    islandName.textContent = input.island?.entry_name?.trim() || '';
  }

  const islandContent = item.querySelector('.ew-workflow-notice__island-slot--content') as HTMLElement | null;
  if (islandContent) {
    const contentText = input.island?.content?.trim() || '';
    const textSpan = islandContent.querySelector('.ew-workflow-notice__island-text') as HTMLElement | null;
    if (textSpan) {
      textSpan.textContent = contentText;
    } else {
      islandContent.textContent = contentText;
    }

    // A: detect overflow for marquee scroll — compare inner text width vs container
    requestAnimationFrame(() => {
      const inner = textSpan ?? islandContent;
      const overflows = inner.scrollWidth > islandContent.clientWidth + 4;
      islandContent.dataset.overflow = overflows ? 'true' : 'false';
      if (overflows && textSpan) {
        const dist = inner.scrollWidth - islandContent.clientWidth;
        textSpan.style.setProperty('--ew-scroll-dist', `-${dist}px`);
      }
    });
  }

  // B: moon state for success/fail
  const orb = item.querySelector('.ew-workflow-notice__island-orb') as HTMLElement | null;
  if (orb) {
    if (level === 'success' && !input.busy) {
      orb.dataset.moon = 'full';
    } else if (level === 'error' && !input.busy) {
      orb.dataset.moon = 'blood';
    } else {
      delete orb.dataset.moon;
    }
  }

  // D: badge — ×N (total) when no preview, +N (remaining) when streaming
  const extraBadge = item.querySelector('.ew-workflow-notice__island-extra') as HTMLElement | null;
  if (extraBadge) {
    const count = input.island?.extra_count ?? 0;
    if (hasPreview && count > 0) {
      // streaming visible: show "+N" (other flows besides the one displayed)
      extraBadge.textContent = `+${count}`;
      extraBadge.style.display = '';
    } else if (!hasPreview && count > 0) {
      // no streaming yet: show "×N" (total active flows = extra_count + 1)
      extraBadge.textContent = `×${count + 1}`;
      extraBadge.style.display = '';
    } else {
      extraBadge.textContent = '';
      extraBadge.style.display = 'none';
    }
  }

  if (input.persist) {
    progress.style.display = 'none';
    progress.style.animationDuration = '';
  } else {
    const duration = Math.max(1400, input.duration_ms ?? 3200);
    progress.style.display = '';
    progress.style.animationDuration = `${duration}ms`;
  }
}

export function showManagedWorkflowNotice(input: EwWorkflowNoticeInput): EwWorkflowNoticeHandle {
  const initialDuration = Math.max(1400, input.duration_ms ?? 3200);
  const doc = resolveNoticeDocument();
  ensureWorkflowStyle(doc);
  const host = ensureWorkflowHost(doc);

  const item = doc.createElement('article');
  item.className = 'ew-workflow-notice';
  item.dataset.collapsed = 'false';

  const card = doc.createElement('div');
  card.className = 'ew-workflow-notice__card';

  const icon = doc.createElement('span');
  icon.className = 'ew-workflow-notice__icon';

  const content = doc.createElement('div');
  content.className = 'ew-workflow-notice__content';

  const title = doc.createElement('h4');
  title.className = 'ew-workflow-notice__title';

  const message = doc.createElement('p');
  message.className = 'ew-workflow-notice__message';

  const actions = doc.createElement('div');
  actions.className = 'ew-workflow-notice__actions';

  const actionButton = doc.createElement('button');
  actionButton.className = 'ew-workflow-notice__action';
  actionButton.type = 'button';
  actionButton.style.display = 'none';
  actionButton.dataset.kind = 'neutral';

  const closeButton = doc.createElement('button');
  closeButton.className = 'ew-workflow-notice__close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭提示');
  closeButton.textContent = '×';

  const island = doc.createElement('div');
  island.className = 'ew-workflow-notice__island';

  const islandName = doc.createElement('span');
  islandName.className = 'ew-workflow-notice__island-slot ew-workflow-notice__island-slot--name';

  const islandOrb = doc.createElement('span');
  islandOrb.className = 'ew-workflow-notice__island-orb';

  const islandContent = doc.createElement('span');
  islandContent.className = 'ew-workflow-notice__island-slot ew-workflow-notice__island-slot--content';

  const islandContentText = doc.createElement('span');
  islandContentText.className = 'ew-workflow-notice__island-text';
  islandContent.appendChild(islandContentText);

  const islandExtra = doc.createElement('span');
  islandExtra.className = 'ew-workflow-notice__island-extra';
  islandExtra.style.display = 'none';

  const progress = doc.createElement('div');
  progress.className = 'ew-workflow-notice__progress';

  content.appendChild(title);
  content.appendChild(message);
  actions.appendChild(actionButton);
  content.appendChild(actions);
  card.appendChild(icon);
  card.appendChild(content);
  card.appendChild(closeButton);
  island.appendChild(islandName);
  island.appendChild(islandOrb);
  island.appendChild(islandContent);
  island.appendChild(islandExtra);
  item.appendChild(card);
  item.appendChild(island);
  item.appendChild(progress);

  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;
  let currentAction = input.action?.onClick ?? null;
  let currentInput: EwWorkflowNoticeInput = input;

  const clearCloseTimer = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const clearCollapseTimer = () => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  };

  const collapse = () => {
    if (closed) {
      return;
    }
    clearCollapseTimer();
    item.dataset.collapsed = 'true';
  };

  const expand = () => {
    if (closed) {
      return;
    }
    item.dataset.collapsed = 'false';
    scheduleCollapse(currentInput);
  };

  const close = () => {
    if (closed) {
      return;
    }
    clearCloseTimer();
    clearCollapseTimer();
    closed = true;
    item.classList.add('ew-workflow-notice--out');
    setTimeout(() => {
      item.remove();
      if (!host.childElementCount) {
        host.remove();
      }
    }, 170);
  };

  const scheduleAutoClose = (nextInput: EwWorkflowNoticeInput) => {
    clearCloseTimer();
    if (nextInput.persist) {
      return;
    }

    const duration = Math.max(1400, nextInput.duration_ms ?? initialDuration);
    closeTimer = setTimeout(close, duration);
  };

  const scheduleCollapse = (nextInput: EwWorkflowNoticeInput) => {
    if (item.dataset.collapsed === 'true') {
      return;
    }

    if ((nextInput.collapse_after_ms ?? 0) <= 0) {
      clearCollapseTimer();
      return;
    }

    if (collapseTimer) {
      return;
    }

    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      collapse();
    }, nextInput.collapse_after_ms);
  };

  const update = (nextInput: EwWorkflowNoticeInput) => {
    if (closed) {
      return;
    }
    currentInput = nextInput;
    currentAction = nextInput.action?.onClick ?? null;
    applyWorkflowNoticeState(item, nextInput, progress);
    scheduleAutoClose(nextInput);
    scheduleCollapse(nextInput);
  };

  applyWorkflowNoticeState(item, input, progress);
  scheduleAutoClose(input);
  scheduleCollapse(input);

  actionButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    currentAction?.();
  });
  closeButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  item.addEventListener('click', event => {
    event.preventDefault();
    if (item.dataset.collapsed === 'true') {
      expand();
      return;
    }
    collapse();
  });

  host.appendChild(item);

  return {
    update,
    dismiss: close,
    collapse,
    expand,
  };
}
