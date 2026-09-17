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
 * 宿主只提供 preload（early.css 由它注入，皮肤要靠特异性压过它）。
 * **皮肤本身跟这个宿主没关系**：样式、脚本、初值、背景图全部由 harness 的
 * host 插件经 `webserver/index-inject` 写进 index.html，切换则 POST 回
 * `/api/minke-skin`。所以这里不再有任何 minke-fork:skin:* 的 IPC handler——
 * 从 Electron 那一侧完全撤出，正是这次改造要验的事。
 */
const { app, BrowserWindow } = require("electron");
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

/*
 * 页面侧探针。三件事各自对应一类真实发生过的回归：
 *
 * - punchThrough：打透明的选择器有没有匹配到元素。上游 581803bf 把
 *   conversation/details 改了名，规则匹配 0 个元素，而所有计算样式看着都正常。
 * - opaqueCovers：从视口中心往上钻，有没有铺满视口的不透明元素盖住 body。
 *   皮肤画在 body 上，上面任何一层不透明 div 都会让它"计算样式全对、渲染一片白"。
 * - body 背景：档位映射本身。
 *
 * 注意不要用 document.styleSheets 判断皮肤在不在：那只对 <style> 行成立，
 * 对 webFrame.insertCSS 注入的 early.css 不成立，两条路混在一页里，查了
 * 也说明不了问题。要判断有没有生效，只读计算样式。
 */
const PROBE = `(() => {
  const ANCHORS = ${JSON.stringify(ANCHORS)};
  const out = { skin: document.documentElement.dataset.minkeSkin ?? null };
  // host 插件写进来的初值。它不对，说明 index-inject 那条缝断了。
  out.injectedChoice = globalThis.__minkeSkinChoice ?? null;
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

/**
 * 走真实写回路径设置档位：同源 POST /minke-skin，鉴权用页面已持有的凭据。
 *
 * 不绕过它去直接改设置文件——那样就验不到这条路由，而它正是这次从 Electron
 * IPC 换过来的那一半。返回 HTTP 状态码，非 204 时编排侧会直接指出来。
 */
function writeChoice(win, choice) {
  return win.webContents.executeJavaScript(`
    fetch("/api/minke-skin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ choice: ${JSON.stringify(choice)} }),
    }).then(async (r) => r.status === 204 ? 204 : r.status + " " + await r.text())
      .catch((e) => String(e))
  `);
}

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

  const report = { skins: {}, writeStatus: {} };
  await win.loadURL(URL_UNDER_TEST);
  await sleep(1500);

  for (const choice of CHOICES) {
    // 先写回、再重载：初值由 index-inject 在渲染 index 时现读，所以刷新一次
    // 拿到的就是新档位。这条链路（POST → 设置文档 → 下次 index 注入）整体
    // 走一遍，才算验到了持久化。
    report.writeStatus[choice] = await writeChoice(win, choice);
    await win.loadURL(URL_UNDER_TEST);
    await sleep(1500);
    const frame = await settledFrame(win);
    report.skins[choice] = {
      frameBytes: frame.toPNG().length,
      ...await win.webContents.executeJavaScript(PROBE),
    };
  }

  // 快捷键：按一次推进档位，且那次推进要真的落到 host 上——重载后 host 注入
  // 回来的初值必须已经是新档位。以前这里只能看主进程收到过一次调用。
  await writeChoice(win, "photo");
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
  const after = await readSkin();
  await win.loadURL(URL_UNDER_TEST);
  await sleep(1500);
  report.shortcut = {
    before,
    after,
    persisted: await win.webContents.executeJavaScript(
      "globalThis.__minkeSkinChoice ?? null",
    ),
  };

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  app.quit();
});
