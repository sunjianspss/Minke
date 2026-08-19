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
const extensionSkin = read("resources/desktop-style-extension/skin.css");
const skinScript = read("resources/desktop-style-extension/skin.js");
const manifest = JSON.parse(
  read("resources/desktop-style-extension/manifest.json"),
);

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
  const sandbox = {
    chrome: {
      runtime: {
        getURL: (path) => `chrome-extension://minke/${path}`,
      },
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

test("the background image ships with the extension resources", () => {
  assert.ok(
    existsSync(
      new URL(
        "../resources/desktop-style-extension/minke-background.jpeg",
        import.meta.url,
      ),
    ),
    "forge 的 extraResource 整目录拷贝，图片必须留在这里",
  );
});

test("the skin hooks into upstream files with a single line each", () => {
  assert.match(rendererStyles, /@import "\.\/skin\.css";/);
  assert.deepEqual(
    manifest.content_scripts[0].css,
    ["early.css", "skin.css"],
    "skin.css 必须排在 early.css 之后才能覆盖它的透明背景",
  );
  assert.deepEqual(manifest.content_scripts[0].js, ["skin.js"]);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["minke-background.jpeg"],
      matches: ["http://127.0.0.1/*", "http://localhost/*"],
    },
  ]);
});

test("the stable Harness background resolves through the extension runtime", () => {
  const { declarations } = runSkinScript();

  assert.deepEqual(declarations, [
    [
      "--minke-background-image",
      'url("chrome-extension://minke/minke-background.jpeg")',
    ],
  ]);
  assert.match(extensionSkin, /var\(--minke-background-image(?:,\s*none)?\)/);
  assert.doesNotMatch(
    extensionSkin,
    /url\(["']?\.\/minke-background\.jpeg/,
    "相对 URL 会解析到 Harness 的 HTTP origin，必须走扩展 URL",
  );
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
