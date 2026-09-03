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
const extensionSkin = read("resources/minke-skin/skin.css");
const skinScript = read("resources/minke-skin/skin.js");
const skinPreload = read("desktop/preload/minke-skin.ts");
const desktopPreload = read("desktop/preload/desktop-preload.ts");

/** 在隔离沙箱里跑一遍 skin.js，拿到它对页面做的全部动作。 */
function runSkinScript({ stored } = {}) {
  const declarations = [];
  const listeners = [];
  const appended = [];
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
  return { appended, declarations, documentElement, listeners, sandbox, store };
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
        `../resources/minke-skin/${SHIPPED_BACKGROUND}`,
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
      gitignore.includes(`resources/minke-skin/${file}`),
      `${file} 没被忽略，会跟着推进公开仓库`,
    );
  }
});

test("the skin hooks into upstream files with a single line each", () => {
  assert.match(rendererStyles, /@import "\.\/skin\.css";/);
  // 上游 preload 里只有两行 fork 代码：一个 import，一个调用。
  assert.match(desktopPreload, /import \{ installMinkeSkin \} from "\.\/minke-skin\.ts";/u);
  assert.match(
    desktopPreload,
    /webFrame\.insertCSS\(macOSSurfaceCss\);[\s\S]{0,200}?installMinkeSkin\(\);/u,
    "皮肤必须排在 early.css 之后注入，否则覆盖不掉它的底色",
  );
});

test("the skin rides the preload injection path, not the dead extension", () => {
  // v0.4.0 上游把主窗口搬到内存态 session，Electron 不允许往内存态 session
  // 加载扩展（Extensions cannot be loaded in a temporary session），所以
  // content_scripts 那条路是结构上走不通的，不是"忘了接"。
  assert.match(skinPreload, /webFrame\.insertCSS\(skinCss\)/u);
  assert.match(
    skinPreload,
    /webFrame\.executeJavaScript\(/u,
    "skin.js 要进页面的 main world，preload 的 isolated world 读不到对的 localStorage",
  );
  assert.match(
    skinPreload,
    /import\.meta\.glob<string>\(\s*"\.\.\/\.\.\/resources\/minke-skin\/minke-background\*\.jpeg",\s*\{ eager: true, query: "\?inline"/u,
    "私人配图可能不存在，必须用 glob 而不是静态 import，否则 clone 下来构建就炸",
  );
  // skin.js 不再依赖 chrome 这件事，由 runSkinScript 的沙箱直接证明：
  // 那里面**没有 chrome 这个全局**，脚本照样跑完并写出三个变量。行为断言比
  // 在源码里 grep "getURL" 强——后者会被注释里的历史说明骗到。
  assert.deepEqual(
    Object.keys(runSkinScript().declarations).length,
    3,
    "没有 chrome 的环境里 skin.js 必须仍能写出全部背景变量",
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
  for (const slot of ["sidebar", "conversation", "details"]) {
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
    // 注入方那张表要盖住 skin.css 用到的每一个变量。
    assert.match(
      skinPreload,
      new RegExp(`"${property}"`, "u"),
      `${property} 在 minke-skin.ts 的 BACKGROUND_PROPERTIES 里没有对应文件`,
    );
  }
  assert.doesNotMatch(
    extensionSkin,
    /url\(["']?\.?\.?\/?minke-background/u,
    "相对 URL 会解析到 Harness 的 HTTP origin，图片只能由 skin.js 写 data: URI",
  );
  // 三个变量、三个文件名，minke-skin.ts 里必须一一对得上。
  for (const file of BACKGROUND_FILES) {
    assert.match(skinPreload, new RegExp(`"${file}"`, "u"), `${file} 没被映射`);
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
