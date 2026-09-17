// Fork 本地皮肤的测试，刻意独立成文件：
// 上游的 tests/macos-window-css.test.mjs 改动频繁，混进去每次同步都会冲突。
// 手动运行：node --test tests/minke-skin.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const appSource = read("desktop/renderer/App.tsx");
const indexHtml = read("desktop/renderer/index.html");
const rendererStyles = read("desktop/renderer/styles.css");
const rendererSkin = read("desktop/renderer/skin.css");
const SKIN_ASSET_DIR = "packages/harness-overlay/assets/minke-skin";
const extensionSkin = read(`${SKIN_ASSET_DIR}/skin.css`);
const skinScript = read(`${SKIN_ASSET_DIR}/skin.js`);
// 皮肤整体从 Electron 侧搬到了 harness 的 host 插件，这三份是它现在的全部实现。
const skinPlugin = read("packages/harness-overlay/src/fork/skin/index.ts");
const skinAssets = read("packages/harness-overlay/src/fork/skin/assets.ts");
const forkEntry = read("packages/harness-overlay/src/fork/index.ts");

/**
 * 在隔离沙箱里跑一遍 skin.js，拿到它对页面做的全部动作。
 *
 * `injected` 是 host 插件经 index-inject 写进去的初值，`bridged` 决定写回路径
 * 在不在——它现在是同源的 POST /api/minke-skin，缺了它 skin.js 必须还能跑。
 */
function runSkinScript({ stored, injected, bridged = true } = {}) {
  const declarations = [];
  const listeners = [];
  const appended = [];
  const posted = [];
  const store = new Map(stored === undefined ? [] : [["minke.skin", stored]]);
  const documentElement = {
    dataset: {},
    style: {
      setProperty(...declaration) {
        declarations.push(declaration);
      },
    },
  };
  // 注入方（desktop/preload/minke-skin.ts）在 skin.js 之前写好这个全局，
  // 值是构建期内联的 data: URI。这里用可辨认的假值，只验映射关系。
  const sandbox = {
    __minkeSkinChoice: injected,
    // 回写用的 fetch。不可用时（别的宿主、被策略挡掉）skin.js 必须自己扛住。
    ...(bridged
      ? {
        fetch(url, init) {
          posted.push({ url, ...JSON.parse(init.body) });
          return Promise.resolve({ status: 204 });
        },
      }
      : {}),
    __minkeSkinBackgrounds: {
      "--minke-background-image": "data:image/jpeg;base64,PHOTO",
      "--minke-background-image-aurora": "data:image/jpeg;base64,AURORA",
      "--minke-background-image-mono": "data:image/jpeg;base64,MONO",
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      documentElement,
      body: {
        appendChild(node) {
          appended.push(node);
        },
      },
      createElement: () => ({ dataset: {}, remove() {} }),
    },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    setTimeout: () => 0,
  };
  runInNewContext(skinScript, sandbox);
  return {
    appended,
    declarations,
    documentElement,
    listeners,
    sandbox,
    posted,
    store,
  };
}

/** 给测试用的按键器：默认就是 Alt+Shift+K。 */
function pressSkinShortcut(listeners, overrides = {}) {
  const keydown = listeners.find((entry) => entry.type === "keydown");
  assert.ok(keydown, "皮肤切换必须挂在 keydown 上");
  keydown.handler({
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: "KeyK",
    preventDefault: () => {},
    ...overrides,
  });
}

// 只有 photo 那张随仓库分发。aurora / mono 用的是私人配图，仓库是公开的，
// 所以图不进历史（见 .gitignore），clone 下来那两档只剩底色。
const SHIPPED_BACKGROUND = "minke-background.jpeg";
const LOCAL_BACKGROUNDS = [
  "minke-background-aurora.jpeg",
  "minke-background-mono.jpeg",
];
const BACKGROUND_FILES = [SHIPPED_BACKGROUND, ...LOCAL_BACKGROUNDS];

test("the shipped background stays where the preload globs it", () => {
  assert.ok(
    existsSync(
      new URL(
        `../${SKIN_ASSET_DIR}/${SHIPPED_BACKGROUND}`,
        import.meta.url,
      ),
    ),
    "preload 的 import.meta.glob 从这里内联图片，挪走了默认档就没图",
  );
});

test("the private backgrounds never reach the public history", () => {
  // 仓库公开，这两张一旦提交就进历史，之后删文件也清不掉。
  const gitignore = read(".gitignore");
  for (const file of LOCAL_BACKGROUNDS) {
    assert.ok(
      gitignore.includes(`${SKIN_ASSET_DIR}/${file}`),
      `${file} 没被忽略，会跟着推进公开仓库`,
    );
  }
});

test("the skin no longer touches any upstream desktop file", () => {
  // 皮肤整体搬到了 harness 的 host 插件，Electron 那一侧一行不剩。
  // v0.4.0 上游把主窗口搬进内存态 session 时，preload 那条注入路径被连根拔掉过
  // 一次；不再依赖它，那一类事故就不会重演。
  for (const file of [
    "desktop/preload/desktop-preload.ts",
    "desktop/main/main.ts",
  ]) {
    assert.doesNotMatch(
      read(file),
      /minke-?[Ss]kin/u,
      `${file} 里还有皮肤的痕迹，B 面对上游的 diff 应该是零`,
    );
  }
  for (const gone of [
    "desktop/preload/minke-skin.ts",
    "desktop/main/minke-skin-store.ts",
    "desktop/minke-skin-channels.ts",
  ]) {
    assert.ok(
      !existsSync(new URL(`../${gone}`, import.meta.url)),
      `${gone} 该随 preload 那条路一起退役`,
    );
  }

  // 只剩 A 面：Minke 自己的 bootstrap 页，那是 fork 的地盘，一行 @import。
  assert.match(rendererStyles, /@import "\.\/skin\.css";/);

  // fork 入口挂上它，一行。
  assert.match(forkEntry, /applySkin\(ctx\)/u);
});

test("the skin rides upstream's index-inject seam", () => {
  // 四行注入：两个 global（初值、背景图）+ 样式 + 脚本。global 必须排在
  // script 前面，否则脚本执行时读不到初值，第一帧是默认档然后跳一下。
  const handler = skinPlugin.match(
    /webserver\/index-inject[\s\S]*?\n {4}\}\);/u,
  );
  assert.ok(handler, "皮肤不再往 index-inject 推注入行了？");
  const kinds = [...handler[0].matchAll(/kind: "(\w+)"/gu)].map(([, k]) => k);
  assert.deepEqual(
    kinds,
    ["global", "global", "style", "script"],
    "顺序错了：两个 global 必须落在 script 之前",
  );

  // 初值每次渲染 index 时现读，而不是启动时读一次——否则切换完刷新还是旧档。
  assert.match(handler[0], /currentChoice\(\)/u);

  // skin.js 不依赖 chrome，也不依赖任何 Electron 全局：沙箱里没有它们，
  // 脚本照样跑完并写出三个背景变量。行为断言比在源码里 grep 强。
  assert.deepEqual(
    Object.keys(runSkinScript().declarations).length,
    3,
    "没有 chrome / Electron 的环境里 skin.js 必须仍能写出全部背景变量",
  );
});

test("the skin punches through upstream's per-column panels", () => {
  // v0.2.0 起上游在每一列里加了一层自带不透明底的面板，early.css 的
  // `#root > *` 够不到，皮肤就整个被盖住——计算样式全对，渲染出来一片白。
  // 只有跑起来截图才看得见，所以这里把「锚点必须稳定」这件事锁死。
  const rule = extensionSkin.match(
    /html:not\(\[data-minke-skin="off"\]\)[^{]*\{[^}]*\}/u,
  );
  assert.ok(rule, "面板透明规则不见了，皮肤会被上游面板整个盖住");
  for (const slot of ["sidebar", "main.conversation", "rightbar"]) {
    assert.match(
      rule[0],
      new RegExp(`\\[data-slot="${slot}"\\]`, "u"),
      `${slot} 这一列没被打透明`,
    );
  }
  assert.match(rule[0], /background-color:\s*transparent\s*!important/u);
  // off 档必须靠 :not() 排除，而不是事后 revert——revert-layer 会退到 UA 样式，
  // 退不回上游的作者样式，面板会跟着一起透明。
  assert.doesNotMatch(extensionSkin, /:\s*revert(-layer)?\s*!important/u);
  // 面板自己的类名是 CSS Module 哈希（-TPGmq_root / r3IEgq_root 之类），
  // 每次构建都变。锚到哈希类名上等于没锚。
  assert.doesNotMatch(
    extensionSkin,
    /\.[A-Za-z-]*[a-z][A-Z0-9][A-Za-z0-9]{3,}_[a-z]/u,
    "别拿 CSS Module 的哈希类名当选择器，构建一次就失效",
  );
});

test("every data-slot the skin anchors to still exists upstream", () => {
  // 上一条只验「fork 自己写了这几个选择器」，从不验「上游还在发这些 slot」。
  // 两者的差别不是理论上的：上游 581803bf（dsh-v0.1.5-alpha.2）把 conversation
  // 改名成 main.conversation、details 换成 rightbar，皮肤的三个锚点当场废掉两个，
  // 而上一条依旧全绿，v0.6.1 那次同步就这么漏过去了。
  //
  // slot-catalog.ts 是上游自己维护的 slot 目录（`key: '<名字>'` 一条一行），
  // 它就是那份「稳定命名契约」的正本。锚到目录上，上游一改名这里立刻红。
  const catalogPath =
    "vendor/deepseek-harness/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts";
  assert.ok(
    existsSync(new URL(`../${catalogPath}`, import.meta.url)),
    `${catalogPath} 不见了——submodule 没 init，或上游挪了目录`,
  );
  const catalogKeys = new Set(
    [...read(catalogPath).matchAll(/key: '([^']+)'/gu)].map((m) => m[1]),
  );
  assert.ok(catalogKeys.size > 20, "slot 目录解析出来是空的，正则跟上游对不上了");

  // 只看真正生效的规则：注释里也提到过 slot 名字，那些不该参与断言。
  const rules = extensionSkin.replace(/\/\*[\s\S]*?\*\//gu, "");
  const anchored = [
    ...new Set([...rules.matchAll(/\[data-slot="([^"]+)"\]/gu)].map((m) => m[1])),
  ].sort();
  assert.ok(anchored.length >= 3, "皮肤一个 data-slot 都没锚，规则被删了？");

  for (const slot of anchored) {
    assert.ok(
      catalogKeys.has(slot),
      `[data-slot="${slot}"] 在上游 slot 目录里已经没有了——` +
        "皮肤这条规则现在匹配不到任何元素，去 slot-catalog.ts 找它的新名字",
    );
  }
});

test("every Harness background reaches the page as an inlined data URI", () => {
  const { declarations } = runSkinScript();

  // 变量名 → 图片的映射是 skin.js / skin.css / minke-skin.ts 三方的契约。
  // skin.js 自己不认识文件名了，它只转发注入方给的 data: URI。
  assert.deepEqual(declarations, [
    ["--minke-background-image", 'url("data:image/jpeg;base64,PHOTO")'],
    ["--minke-background-image-aurora", 'url("data:image/jpeg;base64,AURORA")'],
    ["--minke-background-image-mono", 'url("data:image/jpeg;base64,MONO")'],
  ]);
  for (const [property] of declarations) {
    assert.match(
      extensionSkin,
      new RegExp(`var\\(${property}(?:,\\s*none)?\\)`, "u"),
      `${property} 声明了却没人用，图片白内联进 preload`,
    );
    // host 侧那张表要盖住 skin.css 用到的每一个变量。
    assert.match(
      skinAssets,
      new RegExp(`"${property}"`, "u"),
      `${property} 在 fork/skin/assets.ts 的 BACKGROUNDS 里没有对应文件`,
    );
  }
  assert.doesNotMatch(
    extensionSkin,
    /url\(["']?\.?\.?\/?minke-background/u,
    "相对 URL 会解析到 Harness 的 HTTP origin，图片只能由 skin.js 写 data: URI",
  );
  // 三个变量、三个文件名，assets.ts 里必须一一对得上。
  for (const file of BACKGROUND_FILES) {
    assert.match(skinAssets, new RegExp(`"${file}"`, "u"), `${file} 没被映射`);
  }
});

test("every skin choice reaches the stylesheet that defines it", () => {
  const { sandbox } = runSkinScript();
  // vm 里造的数组换了 realm，deepEqual 会因为原型不同而失败，先搬回本 realm。
  const CHOICES = Array.from(sandbox.__minkeSkin.CHOICES);
  const VISUAL_SKINS = Array.from(sandbox.__minkeSkin.VISUAL_SKINS);

  // 默认主题不带属性，靠 :root 生效，所以不需要选择器。
  for (const skin of VISUAL_SKINS.slice(1)) {
    assert.match(
      extensionSkin,
      new RegExp(`\\[data-minke-skin="${skin}"\\]`, "u"),
      `skin.css 缺少 ${skin} 主题`,
    );
  }
  assert.match(extensionSkin, /\[data-minke-skin="off"\] body/u);
  assert.deepEqual(CHOICES, [...VISUAL_SKINS, "off", "auto"]);
});

test("a stored choice decides the skin and unknown values fall back", () => {
  assert.equal(runSkinScript().documentElement.dataset.minkeSkin, "photo");
  assert.equal(
    runSkinScript({ stored: "aurora" }).documentElement.dataset.minkeSkin,
    "aurora",
  );
  assert.equal(
    runSkinScript({ stored: "nonsense" }).documentElement.dataset.minkeSkin,
    "photo",
    "旧版本或手改出来的坏值不该让页面裸奔",
  );
});

test("auto rotates the visual skins by day and never yields off", () => {
  const { sandbox } = runSkinScript();
  const { resolveSkin } = sandbox.__minkeSkin;
  const VISUAL_SKINS = Array.from(sandbox.__minkeSkin.VISUAL_SKINS);
  const day = 24 * 60 * 60 * 1000;

  const week = Array.from({ length: 8 }, (_, index) =>
    resolveSkin("auto", index * day),
  );
  assert.deepEqual(week, [...VISUAL_SKINS, ...VISUAL_SKINS]);
  assert.equal(
    resolveSkin("auto", 3 * day),
    resolveSkin("auto", 3 * day + day - 1),
    "同一天内不该换主题",
  );
});

test("the choice outlives the window through the Host settings document", () => {
  // 页面侧存不住：主窗口的 session 没有 persist: 前缀（内存态，上游用它推迟
  // Keychain 初始化），localStorage 关掉 app 就没了；harness 每次还换随机端口，
  // origin 跟着变。所以初值必须由 host 注入，回写必须发出去。
  assert.equal(
    runSkinScript({ injected: "mono", stored: "paper" })
      .documentElement.dataset.minkeSkin,
    "mono",
    "注入方给了初值就以它为准，页面存储只是兜底",
  );

  const { listeners, posted, store } = runSkinScript({ injected: "off" });
  pressSkinShortcut(listeners);
  assert.deepEqual(
    posted,
    [{ url: "/api/minke-skin", choice: "auto" }],
    "切换必须 POST 回 host，否则选择活不过重启",
  );
  assert.equal(store.get("minke.skin"), "auto", "本次会话的兜底也要跟着写");

  // 写回路径不可用（别的宿主、fetch 被挡）时不能炸，退回页面存储即可。
  const withoutBridge = runSkinScript({ stored: "paper", bridged: false });
  assert.equal(withoutBridge.documentElement.dataset.minkeSkin, "paper");
  pressSkinShortcut(withoutBridge.listeners);
  assert.equal(withoutBridge.store.get("minke.skin"), "mono");
  assert.deepEqual(withoutBridge.posted, []);
});

test("the host plugin and skin.js agree on the same choices and route", () => {
  const { sandbox } = runSkinScript();
  // host 侧那份白名单是落盘前的最后一道闸：它和 skin.js 的 CHOICES 对不上，
  // 就会出现"切得动但存不下"——页面显示新档，写回被 400 挡掉，刷新退回旧档。
  const declared = [
    ...skinPlugin.matchAll(/^\s{2}"([a-z]+)",$/gmu),
  ].map(([, choice]) => choice);
  assert.deepEqual(
    declared,
    Array.from(sandbox.__minkeSkin.CHOICES),
    "SKIN_CHOICES 和 skin.js 的 CHOICES 必须逐项一致，否则存得进读不出",
  );

  // 路由两侧共用同一个字符串。写全路径这件事错过一次：只写下半截能注册成功，
  // 查表却用完整 pathname，表现是稳定的 404。
  assert.match(skinPlugin, /SKIN_WRITE_ROUTE = "\/api\/minke-skin"/u);
  assert.match(skinPlugin, /path: SKIN_WRITE_ROUTE/u);
  assert.match(skinScript, /fetch\("\/api\/minke-skin"/u);

  // 绘制和写回必须是两个 inject。绑在一起时 connection 缺席会让整块回调都不跑，
  // 表现是皮肤整个消失，而不是"切换存不下来"。踩过一次。
  assert.match(skinPlugin, /ctx\.inject\(\["webServer"\]/u);
  assert.match(skinPlugin, /ctx\.inject\(\["connection"\]/u);

  // 设置命名空间就是落盘的位置，和 ui-theme 同一份文档。
  assert.match(skinPlugin, /SKIN_SETTINGS_NAMESPACE = "minke-skin"/u);
  assert.match(skinPlugin, /settings\.register\(/u);
});

test("the shortcut cycles the choice and persists it", () => {
  const { documentElement, listeners, store } = runSkinScript();
  const keydown = listeners.find((entry) => entry.type === "keydown");
  assert.ok(keydown, "皮肤切换必须挂在 keydown 上");

  let prevented = 0;
  const press = (overrides = {}) =>
    keydown.handler({
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      code: "KeyK",
      preventDefault: () => {
        prevented += 1;
      },
      ...overrides,
    });

  press();
  assert.equal(store.get("minke.skin"), "aurora");
  assert.equal(documentElement.dataset.minkeSkin, "aurora");
  assert.equal(prevented, 1);

  press({ altKey: false });
  press({ code: "KeyJ" });
  assert.equal(store.get("minke.skin"), "aurora", "别的按键不该改主题");
});

test("the bootstrap markup the skin selectors depend on is unchanged", () => {
  // skin.css 用 #root > main > div 代替往 App.tsx 加 className，
  // 换来上游文件零 diff。上游一改结构，这条断言就会失败而不是静默掉样式。
  assert.match(indexHtml, /<div id="root">/);
  assert.match(
    appSource,
    /<main className="[^"]*">\s*<div className="[^"]*">/,
    "App 的根仍须是 main，且面板仍是它的第一个 div 子节点",
  );
  assert.match(rendererSkin, /#root > main > div \{/);
});
