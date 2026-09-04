/*
 * Fork 皮肤运行时。
 *
 * 只做三件事：解析当前主题、写到 <html data-minke-skin>、给一个切换快捷键。
 * 配色全部在 skin.css 里，这里不产生任何样式字符串。
 *
 * 选择的可选值：photo | aurora | paper | mono | off | auto
 * auto 按日期在四个视觉主题之间轮换。
 * 快捷键：Alt+Shift+K 依次切换。
 *
 * 分发：由 desktop/preload/minke-skin.ts 用 webFrame.executeJavaScript 注入到
 * 页面的 main world。
 *
 * **选择不存在页面里。** 主窗口的 session 是内存态（`minke-main-window` 没有
 * `persist:` 前缀），localStorage 关掉 app 就没了；而且 harness 每次都用随机
 * 端口，origin 跟着变。所以初值由注入方写进 globalThis.__minkeSkinChoice，
 * 回写走 globalThis.__minkeSkinStore.save()（contextBridge 递过来的），
 * 两者都由主进程的 minke-skin-store.ts 落盘。localStorage 只剩兜底：
 * 桥不在时（测试沙箱、别的宿主）本次会话仍然记得住。
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

  /** 注入方给的初值优先；没有桥的时候才回落到页面存储。 */
  function initialChoice() {
    if (typeof globalThis.__minkeSkinChoice === "string") {
      return globalThis.__minkeSkinChoice;
    }
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CHOICE;
    } catch {
      // 极少数情况下 storage 被策略禁用，皮肤不该因此整个失效。
      return DEFAULT_CHOICE;
    }
  }

  // 当前选择只认这一份：初值来自注入方，之后由快捷键推进。
  // 每次都回头读存储会让循环卡在同一档上（存储可能根本没写成功）。
  let current = initialChoice();

  function writeChoice(choice) {
    current = choice;
    try {
      // 跨重启的那一份。桥不在就当没有，本次会话照样切得动。
      globalThis.__minkeSkinStore?.save(choice);
    } catch {
      /* 主进程没接住只影响持久化 */
    }
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
    applySkin(current);
  });

  addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.code !== "KeyK") return;
    event.preventDefault();
    const choice = nextChoice(current);
    writeChoice(choice);
    applySkin(choice);
    announce(choice);
  });

  // 供 tests/minke-skin.test.mjs 断言纯函数行为，页面代码不依赖它。
  globalThis.__minkeSkin = { CHOICES, VISUAL_SKINS, resolveSkin, nextChoice };
})();
