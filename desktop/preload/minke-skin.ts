// >>> minke-fork
/**
 * Fork 皮肤的注入层。
 *
 * v0.4.0 之前皮肤走的是 Chrome 扩展的 content_scripts。上游 63861c2 把主窗口
 * 搬到内存态的 #surfaceSession（为了不让 Chromium 提前初始化 Keychain），
 * 7471219 接着删掉了整个扩展——而 Electron **不允许往内存态 session 里加载扩展**
 * （`Extensions cannot be loaded in a temporary session`），所以那条路不是"上游
 * 忘了接"，是结构上就走不通。
 *
 * 现在跟着上游走同一条路：CSS 用 webFrame.insertCSS（early.css 就是这么注入的），
 * JS 用 webFrame.executeJavaScript 送进页面的 main world。
 *
 * 两个关键约束，改这个文件前先读：
 *
 * 1. **skin.js 必须进 main world，不能留在 preload 的 isolated world。**
 *    它要摸 document 和键盘事件，跟页面同一个世界最省事；
 *    executeJavaScript 默认就在 main world。
 *
 *    代价是它够不到 ipcRenderer，所以**选择的持久化由这一侧负责**：注入前先
 *    从主进程读一次初值塞进去，切换时经 contextBridge 递过去的 save 写回来。
 *    页面自己的 localStorage 只当本次会话的兜底——主窗口的 session 是内存态
 *    （`minke-main-window` 没有 `persist:` 前缀），存进去关掉 app 就没了。
 *    详见 desktop/main/minke-skin-store.ts。
 *
 * 2. **背景图只能用 data: URI。** 没有 chrome.runtime 了，相对路径会解析到
 *    Harness 的 HTTP origin（这正是当初改用扩展 URL 的原因），file:// 又会被
 *    Chromium 按跨协议拦掉。所以在构建期就把 jpeg 内联成 base64。
 */
import { contextBridge, ipcRenderer, webFrame } from "electron";
import {
  MINKE_SKIN_READ_CHANNEL,
  MINKE_SKIN_WRITE_CHANNEL,
} from "../minke-skin-channels.ts";
import skinCss from "../../resources/minke-skin/skin.css?raw";
import skinScript from "../../resources/minke-skin/skin.js?raw";

// 用 glob 而不是三条 import：aurora / mono 是私人配图，在 .gitignore 里，
// clone 下来根本不存在。静态 import 会让构建直接失败，glob 匹配不到就没有这一项，
// skin.css 的 var() 自己回落到 none——缺图只是少一档，不该炸整个构建。
const backgroundModules = import.meta.glob<string>(
  "../../resources/minke-skin/minke-background*.jpeg",
  { eager: true, query: "?inline", import: "default" },
);

/** 文件名 → skin.css 里那个 CSS 变量名。两边必须一一对应。 */
const BACKGROUND_PROPERTIES: Record<string, string> = {
  "minke-background.jpeg": "--minke-background-image",
  "minke-background-aurora.jpeg": "--minke-background-image-aurora",
  "minke-background-mono.jpeg": "--minke-background-image-mono",
};

function skinBackgrounds(): Record<string, string> {
  const backgrounds: Record<string, string> = {};
  for (const [path, dataUrl] of Object.entries(backgroundModules)) {
    const property = BACKGROUND_PROPERTIES[path.split("/").pop() ?? ""];
    if (property !== undefined) backgrounds[property] = dataUrl;
  }
  return backgrounds;
}

/**
 * 把 skin.js 送进 main world，顺带把它自己拿不到的两样东西一起塞进去：
 * 背景图的 data: URI，和主进程存着的上次选择（没有就 null，让它回落默认档）。
 */
function injectSkinScript(choice: unknown): void {
  const stored = typeof choice === "string" ? choice : null;
  void webFrame.executeJavaScript(
    `globalThis.__minkeSkinBackgrounds=${
      JSON.stringify(skinBackgrounds())
    };\nglobalThis.__minkeSkinChoice=${
      JSON.stringify(stored)
    };\n${skinScript}`,
  );
}

/** 装上皮肤。和 early.css 一样只在 macOS 生效，由调用方判断平台。 */
export function installMinkeSkin(): void {
  webFrame.insertCSS(skinCss);
  // main world 够不到 ipcRenderer，只能由这里递一个函数过去。
  contextBridge.exposeInMainWorld("__minkeSkinStore", {
    save(choice: unknown): void {
      void ipcRenderer.invoke(MINKE_SKIN_WRITE_CHANNEL, choice);
    },
  });
  // 读一次初值再注入。这一趟是进程内 IPC，skin.js 自己还要等
  // documentElement 出现（whenRoot），所以晚这几毫秒不会看见闪白。
  // 读失败也照样注入——皮肤宁可回落默认档，也不能整个不出现。
  void ipcRenderer.invoke(MINKE_SKIN_READ_CHANNEL).then(
    injectSkinScript,
    () => {
      injectSkinScript(null);
    },
  );
}
// <<< minke-fork
