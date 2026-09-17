/*
 * 皮肤的运行时验证：小宿主一侧。
 *
 * 由 scripts/tests/minke-skin-surface.mjs 拉起，不直接跑。它只负责把每一档
 * 皮肤渲染出来、收真实帧、量计算样式，把观测结果写成 JSON；断言全在编排侧。
 *
 * 为什么要自己搭宿主，而不是 `pnpm start` 起真 app：
 * 主进程有 requestSingleInstanceLock()，而 userData 被钉在 $HOME/.minke，
 * 只要 /Applications/Minke.app 在跑，dev 版就静默 app.quit() 且退出码 0——
 * 验证会"通过"而其实什么都没跑。详见 .claude/skills/verify。
 *
 * 宿主必须提供两样东西，缺一样皮肤就是"看起来没生效"：
 *   1. webPreferences.preload 指向构建产物，皮肤的 CSS/JS 由它注入；
 *   2. 主进程接住 minke-fork:skin:read / :write，preload 先 read 拿初值，
 *      没人接的话 invoke 直接 reject，所有档位一起回落默认值。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFileSync } = require("node:fs");

const CHOICES = ["photo", "aurora", "paper", "mono", "off"];
const REPORT = process.env.MINKE_SKIN_REPORT;
const URL_UNDER_TEST = process.env.MINKE_SKIN_URL;
const PRELOAD = process.env.MINKE_SKIN_PRELOAD;
/*
 * 皮肤打透明用到的 data-slot，由编排侧从 skin.css 里解析出来传进来。
 *
 * **不能在这里写死。** 写死的话，探针量的永远是"对的那几个名字"，而皮肤 CSS
 * 里锚的是什么完全不影响结果——守卫对它唯一要防的那个故障就是空的
 * （第一版就是这样，种回 v0.6.1 的失效锚点照样全绿）。
 */
const ANCHORS = JSON.parse(process.env.MINKE_SKIN_ANCHORS ?? "[]");

/** 主进程那一侧的持久化通道，行为对齐 desktop/main/minke-skin-store.ts。 */
let stored = "photo";
const saves = [];
ipcMain.handle("minke-fork:skin:read", () => stored);
ipcMain.handle("minke-fork:skin:write", (_event, choice) => {
  saves.push(choice);
  stored = choice;
});

/*
 * 页面侧探针。三件事各自对应一类真实发生过的回归：
 *
 * - punchThrough：打透明的选择器有没有匹配到元素。上游 581803bf 把
 *   conversation/details 改了名，规则匹配 0 个元素，而所有计算样式看着都正常。
 * - opaqueCovers：从视口中心往上钻，有没有铺满视口的不透明元素盖住 body。
 *   皮肤画在 body 上，上面任何一层不透明 div 都会让它"计算样式全对、渲染一片白"。
 * - body 背景：档位映射本身。
 *
 * 注意不要用 document.styleSheets 判断皮肤在不在：webFrame.insertCSS 注入的
 * 样式表不出现在那里面，查了永远是 false，跟生效与否无关。只能读计算样式。
 */
const PROBE = `(() => {
  const ANCHORS = ${JSON.stringify(ANCHORS)};
  const out = { skin: document.documentElement.dataset.minkeSkin ?? null };
  const body = getComputedStyle(document.body);
  out.backgroundImage = body.backgroundImage;
  out.backgroundColor = body.backgroundColor;
  out.hasDataUri = body.backgroundImage.includes("data:image");

  out.punchThrough = {};
  for (const key of ANCHORS) {
    const anchor = document.querySelector('[data-slot="' + key + '"]');
    out.punchThrough[key] = {
      // 锚点在不在，和它有没有子元素，是两件事：右列默认折叠，元素在但没有
      // 子元素；而一个被上游改了名的 slot 是整个查不到。分开记才区分得了。
      present: anchor !== null,
      children: anchor === null
        ? []
        : [...anchor.children].map((el) => getComputedStyle(el).backgroundColor),
    };
  }

  const vw = innerWidth;
  const vh = innerHeight;
  const covers = [];
  let node = document.elementFromPoint(vw / 2, vh / 2);
  while (node) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const opaque = style.backgroundColor !== "rgba(0, 0, 0, 0)"
      && !/rgba\\(.*,\\s*0\\)$/.test(style.backgroundColor);
    if (opaque && rect.width > vw * 0.8 && rect.height > vh * 0.8) {
      covers.push(
        node.tagName
        + (node.dataset.slot ? '[' + node.dataset.slot + ']' : "")
        + " " + style.backgroundColor,
      );
    }
    node = node.parentElement;
  }
  out.opaqueCovers = covers;
  return out;
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * capturePage() 可能返回样式变更"之前"的那一帧，而同一时刻 executeJavaScript
 * 读到的计算样式却是当前的。两者错开一位时，整批帧会集体偏移——报告里的
 * attribute 和计算样式全部正确，只有帧内容本身会露馅。所以先丢一张再收一张。
 */
async function settledFrame(win) {
  await win.webContents.executeJavaScript(
    "new Promise((r) => requestAnimationFrame(() =>"
    + " requestAnimationFrame(() => setTimeout(r, 250))))",
  );
  await win.capturePage();
  await sleep(350);
  return win.capturePage();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    // 和 desktop/main/main-window.ts 对齐，否则量到的不是真窗口里的样子。
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      transparent: process.platform === "darwin",
    },
  });

  const report = { skins: {} };
  for (const choice of CHOICES) {
    // 逐档改主进程那份初值再重新 loadURL，而不是靠快捷键循环推当前是哪一档。
    // 也别写页面的 localStorage：那只是桥不在时的兜底，会被主进程 read 盖掉。
    stored = choice;
    await win.loadURL(URL_UNDER_TEST);
    await sleep(1500);
    const frame = await settledFrame(win);
    report.skins[choice] = {
      frameBytes: frame.toPNG().length,
      ...await win.webContents.executeJavaScript(PROBE),
    };
  }

  // 快捷键单独验：按一次，看页面上的档位和主进程收到的写回是否一致。
  stored = "photo";
  saves.length = 0;
  await win.loadURL(URL_UNDER_TEST);
  await sleep(1500);
  const readSkin = () =>
    win.webContents.executeJavaScript("document.documentElement.dataset.minkeSkin");
  const before = await readSkin();
  win.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "K",
    modifiers: ["alt", "shift"],
  });
  await sleep(600);
  report.shortcut = { before, after: await readSkin(), saves: [...saves] };

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  app.quit();
});
