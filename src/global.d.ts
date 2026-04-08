/**
 * 全局类型声明
 *
 * 声明 SillyTavern 主页面提供的全局变量和函数。
 * 旧 TavernHelper 运行时函数已迁移到 src/runtime/compat/ 层,
 * 此文件只保留 ST 宿主真正在 window 上的全局。
 */

// ── SillyTavern 全局 API ──
declare namespace SillyTavern {
  interface v1CharData {
    name?: string;
    avatar?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    mes_example?: string;
    data?: {
      description?: string;
      personality?: string;
      scenario?: string;
      mes_example?: string;
      system_prompt?: string;
      post_history_instructions?: string;
      extensions?: Record<string, any>;
      [key: string]: any;
    };
    [key: string]: any;
  }
}

declare const SillyTavern: {
  getContext(): import("./st-adapter").STContext;
  getCurrentChatId(): string;
  getRequestHeaders(): Record<string, string>;
  chat: any[];
  chatId?: string;
  selectedGroupId?: string | null;
  eventTypes?: Record<string, string>;
  stopGeneration?(): void;
};

// ── SillyTavern 网络请求 (真实 ST window 全局) ──
declare function getRequestHeaders(): Record<string, string>;

// ── YAML (ST 全局) ──
declare const YAML: {
  parseDocument(content: string, options?: any): { toJS(): any };
  stringify(value: any, options?: any): string;
};

// ── 模块声明 ──
declare module "*.vue" {
  import { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "*.html" {
  const content: string;
  export default content;
}
