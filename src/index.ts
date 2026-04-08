/**
 * Evolution World — ST 扩展入口
 *
 * ST 通过 <script type="module"> 加载此文件。
 * jQuery/lodash/toastr 等全局变量由 ST 主页面提供。
 *
 * 关键: ST 扩展脚本在页面加载早期执行，此时 SillyTavern.getContext()
 *       可能尚未可用。所有对 getSTContext() 的调用必须在 jQuery ready
 *       回调内部进行，不能在模块顶层。
 */
import { getSTContext, isSTReady } from "./st-adapter";

console.log("[Evolution World] 扩展脚本已加载");

// 使用 globalThis.jQuery 确保在 module scope 中能找到全局变量
const jq = (globalThis as any).jQuery || (globalThis as any).$;

if (typeof jq === "function") {
  jq(async () => {
    console.log("[Evolution World] jQuery ready — 开始初始化");

    // 等待 ST context 可用 (有些情况下 jQuery ready 触发时 ST 还没初始化完)
    let retries = 0;
    while (!isSTReady() && retries < 50) {
      await new Promise((r) => setTimeout(r, 100));
      retries++;
    }

    if (!isSTReady()) {
      console.error(
        "[Evolution World] SillyTavern.getContext() 在 5 秒后仍不可用，放弃初始化",
      );
      return;
    }

    try {
      const ctx = getSTContext();
      console.info("[Evolution World] ST context 已就绪");

      const [{ initRuntime }, { mountUI }] = await Promise.all([
        import(/* webpackMode: "eager" */ "./runtime/main"),
        import(/* webpackMode: "eager" */ "./ui/mount"),
      ]);

      // 初始化运行时 (settings, events, pipeline)
      await initRuntime();
      console.log("[Evolution World] 运行时初始化完成");

      // 挂载 UI (FAB + 魔法棒 + 浮动面板)
      mountUI();
      console.log("[Evolution World] UI 挂载完成");

      (globalThis as any).toastr?.success?.(
        "Evolution World 扩展已加载！",
        "EW",
        { timeOut: 2000 },
      );
    } catch (error) {
      console.error("[Evolution World] 初始化失败:", error);
      (globalThis as any).toastr?.error?.(
        `Evolution World 初始化失败: ${error}`,
        "EW",
      );
    }
  });
} else {
  // jQuery 尚未加载 — 不应发生，因为 ST 提供 jQuery
  console.error("[Evolution World] jQuery 未找到，无法初始化");
}
