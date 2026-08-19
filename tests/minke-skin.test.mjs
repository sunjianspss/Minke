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
const earlyScript = read("resources/desktop-style-extension/early.js");
const manifest = JSON.parse(
  read("resources/desktop-style-extension/manifest.json"),
);

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
  assert.deepEqual(manifest.content_scripts[0].js, ["early.js"]);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["minke-background.jpeg"],
      matches: ["http://127.0.0.1/*", "http://localhost/*"],
    },
  ]);
});

test("the stable Harness background resolves through the extension runtime", () => {
  const declarations = [];
  runInNewContext(earlyScript, {
    chrome: {
      runtime: {
        getURL(path) {
          return `chrome-extension://minke/${path}`;
        },
      },
    },
    document: {
      documentElement: {
        style: {
          setProperty(...declaration) {
            declarations.push(declaration);
          },
        },
      },
    },
  });

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
