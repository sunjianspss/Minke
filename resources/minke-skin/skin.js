/*
 * Fork 皮肤运行时。
 *
 * 只做三件事：解析当前主题、写到 <html data-minke-skin>、给一个切换快捷键。
 * 配色全部在 skin.css 里，这里不产生任何样式字符串。
 *
 * 选择存在 localStorage["minke.skin"]，可选值：
 *   photo | aurora | paper | mono | off | auto
 * auto 按日期在四个视觉主题之间轮换。
 * 快捷键：Alt+Shift+K 依次切换。
 *
 * 分发：由 desktop/preload/minke-skin.ts 用 webFrame.executeJavaScript 注入到
 * 页面的 main world。**不能用 preload 自己的 isolated world**——那边的
 * localStorage 未必是 Harness origin 的那一份。
 *
 * 背景图的 data: URI 由注入方先写进 globalThis.__minkeSkinBackgrounds。
 * 这里不认识文件路径：v0.4.0 之前走的是 chrome.runtime.getURL()，扩展没了之后
 * 相对路径会解析到 Harness 的 HTTP origin，只有 data: URI 不依赖任何 origin。
 * 私人配图在 .gitignore 里，clone 下来那两档取不到值，对应的 var() 回落到 none。
 */
(() => {
  const STORAGE_KEY = "minke.skin";
  const VISUAL_SKINS = ["photo", "aurora", "paper", "mono"];
  const CHOICES = [...VISUAL_SKINS, "off", "auto"];
  const DEFAULT_CHOICE = "photo";
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** 把用户选择解析成真正生效的主题名。未知值一律回落到默认主题。 */
  function resolveSkin(choice, now) {
    if (choice === "auto") {
      const day = Math.floor(now / DAY_MS);
      return VISUAL_SKINS[((day % VISUAL_SKINS.length) + VISUAL_SKINS.length) %
        VISUAL_SKINS.length];
    }
    return CHOICES.includes(choice) ? choice : DEFAULT_CHOICE;
  }

  /** 下一个选择，按 CHOICES 顺序循环。 */
  function nextChoice(choice) {
    const index = CHOICES.indexOf(choice);
    return CHOICES[(index + 1) % CHOICES.length];
  }

  function readChoice() {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CHOICE;
    } catch {
      // 极少数情况下 storage 被策略禁用，皮肤不该因此整个失效。
      return DEFAULT_CHOICE;
    }
  }

  function writeChoice(choice) {
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* 存不下就只影响持久化，本次会话仍然生效 */
    }
  }

  function applySkin(choice) {
    document.documentElement.dataset.minkeSkin = resolveSkin(choice, Date.now());
  }

  /** 切换后给一个短提示，否则用户按了快捷键不知道现在是哪个主题。 */
  function announce(choice) {
    const body = document.body;
    if (!body) return;
    const toast = document.createElement("div");
    toast.dataset.minkeSkinToast = "";
    toast.textContent = `skin: ${choice}`;
    body.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 1200);
  }

  /** documentElement 要等一下：preload 注入得比 document_start 还早。 */
  function whenRoot(run) {
    if (document.documentElement !== null) {
      run();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.documentElement === null) return;
      observer.disconnect();
      run();
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  whenRoot(() => {
    // 一个主题一张图，变量名和 skin.css 里的 var() 一一对应。
    // 取不到的（私人配图没在本机）就不写，var() 自己回落到 none。
    const backgrounds = globalThis.__minkeSkinBackgrounds ?? {};
    for (const [property, url] of Object.entries(backgrounds)) {
      if (typeof url !== "string" || url === "") continue;
      document.documentElement.style.setProperty(property, `url("${url}")`);
    }
    applySkin(readChoice());
  });

  addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.code !== "KeyK") return;
    event.preventDefault();
    const choice = nextChoice(readChoice());
    writeChoice(choice);
    applySkin(choice);
    announce(choice);
  });

  // 供 tests/minke-skin.test.mjs 断言纯函数行为，页面代码不依赖它。
  globalThis.__minkeSkin = { CHOICES, VISUAL_SKINS, resolveSkin, nextChoice };
})();
