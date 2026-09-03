/*
 * Fork 皮肤运行时，document_start 注入。
 *
 * 只做三件事：解析当前主题、写到 <html data-minke-skin>、给一个切换快捷键。
 * 配色全部在 skin.css 里，这里不产生任何样式字符串。
 *
 * 选择存在 localStorage["minke.skin"]，可选值：
 *   photo | aurora | paper | mono | off | auto
 * auto 按日期在四个视觉主题之间轮换。
 * 快捷键：Alt+Shift+K 依次切换。
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

  // 背景图必须走扩展 URL：相对路径会解析到 Harness 的 HTTP origin。
  // 一个主题一张图，变量名和 skin.css 里的 var() 一一对应。
  const BACKGROUNDS = {
    "--minke-background-image": "minke-background.jpeg",
    "--minke-background-image-aurora": "minke-background-aurora.jpeg",
    "--minke-background-image-mono": "minke-background-mono.jpeg",
  };
  for (const [property, file] of Object.entries(BACKGROUNDS)) {
    document.documentElement.style.setProperty(
      property,
      `url("${chrome.runtime.getURL(file)}")`,
    );
  }
  applySkin(readChoice());

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
