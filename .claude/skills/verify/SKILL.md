---
name: verify
description: Build, launch and drive Minke to observe a change at runtime — the isolated-harness and skin-surface recipes that actually work on this repo.
---

# 验证 Minke 的改动

FORK.md 第 3 节讲的是分层验证的思路和命令，那边是正的，先看那边。
这里只补它不会写的东西：**会让你得出假结论的环境坑**。

## 坑：三个会让你以为「没坏」的假象

1. **`pnpm start` 起不来，且不报错。** `desktop/main/main.ts:582` 有
   `requestSingleInstanceLock()`，而 `configureAppDataPaths()`
   （`desktop/main/app-data-paths.ts`）把 userData 硬钉在 `$HOME/.minke`。
   只要 `/Applications/Minke.app` 在跑，dev 版就静默 `app.quit()`，退出码 0。
   `--user-data-dir` 覆盖不了；`HOME=...` 也没用，macOS 上
   `app.getPath("home")` 走 NSHomeDirectory 而不是 `$HOME`。
   → 要么让用户退掉已装的 app，要么用下面的 skin-surface 小宿主。

2. **Chrome 151+ 的 `--load-extension` 已失效**，静默不加载（
   `Preferences` 里 `extensions.settings` 为空）。用 Chrome 验证皮肤扩展
   得到的一律是假阴性。用 Electron 的 `loadExtension` 才是真路径。

3. **Minke 吞掉 harness 的 stdout**（`desktop/main/harness-runtime.ts`
   只在非预期退出时才吐缓冲区）。`ctx.logger` 在真 app 里看不见。

## 第 3 层：隔离 harness（fork 插件 / MCP / subagent）

和 FORK.md 里那段一致，抄一份放这儿免得来回翻。注意环境变量是 `MINKE_` 前缀
（`config/embedded-node-runtime.mts`）——`DSH_` 那套是 v0.2.0 之前的名字，
harness 现在会主动把 `DSH_*` 从子进程环境里删掉。

```sh
R=$PWD/runtime/host
H=/tmp/dsh-verify-home          # 隔离，别用 ~/.minke
E=$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
mkdir -p "$H"                   # 需要的话在这里放 minke-mcp.json

ELECTRON_RUN_AS_NODE=1 DSH_HOME="$H" \
MINKE_NODE_EXECUTABLE="$E" \
MINKE_PNPM_ENTRY="$R/node_modules/pnpm/bin/pnpm.cjs" \
PATH="$R/bin:$PATH" \
"$E" --expose-internals "$R/index.mjs" web \
  --patch "$R/node_modules/@lencx/minke-harness-overlay/cordis.patch.yml" \
  --no-open --host 127.0.0.1 --port 0
```

起来后打印 `dsh web: http://127.0.0.1:<port>`。观察点：

- 浏览器开那个 URL → 设置 → 插件 → **插件列表**，拉到底看 fork 那几行
  （`subagent-claude-code` / `tool-subagent` / `mcp-client` / `…overlay/fork`）。
- MCP 是否真挂上：看子进程有没有起来，别只看插件列表——
  运行时用 `ctx.plugin()` 动态挂的 mcp-client 实例**不会**出现在插件列表里，
  那里只有 `cordis.patch.yml` 的静态模板行（显示「已停用」）。
- 没有 websocket 库也能查页面状态：`fetch http://127.0.0.1:9333/json/list`
  拿 target，再用 node 内建 `WebSocket` 发 `Runtime.evaluate`（node 25 自带）。

写个最小 stdio MCP server 当 fixture 最省事：响应 `initialize` /
`tools/list` 就够，往 stderr 打一行带 pid 的标记方便定位。

## 皮肤：Electron skin-surface 小宿主

不碰用户已装的 app，也绕开 single-instance lock。放任意目录：

```js
// main.js，配一个 {"main":"main.js"} 的 package.json
const { app, BrowserWindow, session } = require("electron");
app.whenReady().then(async () => {
  await session.defaultSession.extensions.loadExtension(process.env.SKIN_EXT);
  const win = new BrowserWindow({ width: 1440, height: 900 });
  await win.loadURL(process.env.SKIN_URL);   // 上面那个 harness URL
  // win.webContents.executeJavaScript(...) 读计算样式
  // win.webContents.capturePage() 拿真实渲染帧，比外部截图可靠
  // win.webContents.sendInputEvent({type:"keyDown",keyCode:"K",
  //   modifiers:["alt","shift"]}) 触发皮肤快捷键
});
```

```sh
SKIN_EXT=$PWD/resources/desktop-style-extension SKIN_URL=http://127.0.0.1:<port> \
  node_modules/.bin/electron /path/to/that/dir
```

**两个查 DOM 时会骗你的地方：**

- **别在 dump DOM 树时过滤掉 0×0 的节点。** 布局里有不少零尺寸的
  `[data-slot=...]` 包装层，滤掉之后你数出来的层级会少一层，写出来的
  `> * > *` 就永远匹配不中。要么全打印，要么直接从
  `elementFromPoint` 往上 walk 完整祖先链。
- **content script 注入的样式表不出现在 `document.styleSheets` 里。**
  拿 `[...document.styleSheets].some(s => [...s.cssRules]...)` 去查
  skin.css 在不在，永远返回 false，跟它有没有生效毫无关系。
  要判断有没有生效，去读目标元素的**计算样式**。

**别只看计算样式就下结论。** 皮肤画在 `body` 上（不是 `html`），
上面任何一个不透明的 div 都会把它整个盖掉，而计算样式看起来完全正常。
一定要 `capturePage()` 看真实的那一帧，或者从视口中心 `elementFromPoint`
往上钻一遍，找 `backgroundColor` 不透明且尺寸接近视口的元素。
