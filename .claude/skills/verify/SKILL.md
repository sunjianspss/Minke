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

2. **皮肤早就不是扩展了**（v0.4.0 起走 preload 注入，见 FORK.md 第 2 节）。
   任何"加载扩展再看皮肤"的做法——Chrome 的 `--load-extension`（151+ 已静默
   失效）、Electron 的 `loadExtension`——验的都是一条死路径，结论一律无效。
   真路径是下面那个 preload 小宿主。

3. **Minke 吞掉 harness 的 stdout**（`desktop/main/harness-runtime.ts`
   只在非预期退出时才吐缓冲区）。`ctx.logger` 在真 app 里看不见。

## 坑：一个会让你以为「坏了」的假象

`pnpm test:desktop` 里这条**在 Homebrew 装的 node 上恒失败**，与改动无关：

```
tests/harness-runtime-prune.test.mjs
✖ runtime pruning replaces esbuild's duplicate binary with a launcher
  assert.ok(report.optimized.bytes > 100_000)
```

它拿 `process.execPath` 当假的 esbuild 二进制素材，断言剪掉后省下 >100 KB。
而 Homebrew 的 `bin/node` 是个链到共享 `libnode` 的 stub，只有 ~68 KB
（`wc -c "$(node -p process.execPath)"` 一看便知），素材本身就不够大。
官方安装包或 nvm 装的 node 是几十 MB 的完整二进制，同一条测试就过。

**判断任何一条测试是不是自己改坏的，成本最低的办法是拉个对照 worktree：**

```sh
git worktree add -f --detach /tmp/ctrl origin/main
ln -s "$PWD/node_modules" /tmp/ctrl/node_modules      # 省一次 install
cd /tmp/ctrl && node --test tests/<那个文件>.test.mjs
git worktree remove --force /tmp/ctrl                  # 记得删软链再删 worktree
```

同样失败 → 环境或上游的问题，不是你的改动。

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

## 皮肤：先跑 `pnpm test:skin:surface`

**这一节的东西现在已经是一条命令了，别再手搓。**

```bash
pnpm test:skin:surface     # 约 25 秒，5 档逐帧 + 探针 + 快捷键，红绿结论
```

它自己起隔离 harness 和小宿主，抓两类真实回归：面板把皮肤盖住（v0.2.0 那次）、
锚的 slot 被上游改名后规则匹配 0 个元素（v0.6.1 漏掉的那次）。两条负向对照都验过。
脚本在 `scripts/tests/minke-skin-surface.mjs` + `tests/minke-skin-surface-runtime.cjs`，
背景与设计约束见 FORK.md 第 3 节第 3.5 层。

下面这套手搓宿主只在**改这个脚本本身**、或要看脚本没覆盖的东西时才需要——
比如开着会话的状态、右列展开后的样子、某个具体元素的层级。

### 手搓宿主（改脚本时才用）

不碰用户已装的 app，也绕开 single-instance lock。放任意目录。

**皮肤已经不由宿主提供了。** 样式、脚本、初值、背景图全部由 harness 的 host 插件
经 `webserver/index-inject` 写进 index.html，切换 POST 回 `/api/minke-skin`。
宿主只需要给一样东西：

- `webPreferences.preload` 指向构建产物 `.vite/build/desktop-preload.js`
  （先 `pnpm build:preload`）。**它注入的是上游的 early.css，不是皮肤**——皮肤要
  靠特异性压过它，少了它就验不到这场较量。

逐档验证不要去改宿主里的变量，直接走真实写回路径再刷新：

```js
await win.webContents.executeJavaScript(`
  fetch("/api/minke-skin", { method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin", body: JSON.stringify({ choice: "mono" }) })
    .then((r) => r.status)`);      // 204 以外都说明那条缝断了
await win.loadURL(process.env.SKIN_URL);   // 初值在渲染 index 时现读
```

```js
// main.js，配一个 {"main":"main.js"} 的 package.json
const { app, BrowserWindow } = require("electron");
```sh
SKIN_PRELOAD=$PWD/.vite/build/desktop-preload.js \
SKIN_URL='http://127.0.0.1:<port>/?token=<token>' \
  node_modules/.bin/electron /path/to/that/dir
```

宿主没注册上游那一堆 `minke:*` handler，控制台会刷
`No handler registered for 'minke:…'`——**那是宿主简陋，不是改动坏了**，
皮肤和布局照常渲染。

**两个查 DOM 时会骗你的地方：**

- **别在 dump DOM 树时过滤掉 0×0 的节点。** 布局里有不少零尺寸的
  `[data-slot=...]` 包装层，滤掉之后你数出来的层级会少一层，写出来的
  `> * > *` 就永远匹配不中。要么全打印，要么直接从
  `elementFromPoint` 往上 walk 完整祖先链。
- **`webFrame.insertCSS` 注入的样式表不出现在 `document.styleSheets` 里。**
  拿 `[...document.styleSheets].some(s => [...s.cssRules]...)` 去查
  skin.css 在不在，永远返回 false，跟它有没有生效毫无关系。
  要判断有没有生效，去读目标元素的**计算样式**。

**私人配图在 `~/.minke/harness/skins/`，不在仓库里。** 隔离 harness 用的是空的
`DSH_HOME`，不把图播进去的话 aurora / mono 一定没图——那是测试环境的事实，不是
回归。`test:skin:surface` 自己会播（`seedBackgrounds`），手搓宿主时记得也播一下。

**别再依赖「主进程那份初值」那套说法。** 选择现在存在 Harness 的用户设置文档里
（`DSH_HOME` 下，和 ui-theme 的 light/dark 同一份），不在 `<userData>/desktop/`，
也不经过任何 IPC 通道。

**别只看计算样式就下结论。** 皮肤画在 `body` 上（不是 `html`），
上面任何一个不透明的 div 都会把它整个盖掉，而计算样式看起来完全正常。
一定要 `capturePage()` 看真实的那一帧，或者从视口中心 `elementFromPoint`
往上钻一遍，找 `backgroundColor` 不透明且尺寸接近视口的元素。

**但 `capturePage()` 自己也会骗你：它可能返回上一次样式变更「之前」的帧。**
同一时刻 `executeJavaScript` 读到的计算样式却是当前的，两者错开一位。
后果很隐蔽：改一次样式截一张图，整批图会整体偏移一位——标着 A 的图里是
上一档，最后一档根本没截到——而报告里的 attribute 和计算样式全部正确，
光看数据完全看不出来。只有截图内容本身（或它的字节数）才会露馅。

改完样式后这样收帧：

```js
await win.webContents.executeJavaScript(
  `new Promise((r) => requestAnimationFrame(() =>
     requestAnimationFrame(() => setTimeout(r, 250))))`);
await win.capturePage();          // 丢掉可能陈旧的这一张
await new Promise((r) => setTimeout(r, 350));
const shot = await win.capturePage();   // 这张才作数
```

顺带：验证多档主题时**别依赖快捷键的循环顺序**去推当前是哪一档，
直接逐档改上面那个 `stored` 再 `loadURL` 一次，各自收帧。
**别去写页面的 `localStorage`**——那只是桥不在时的兜底，初值以主进程
read 回来的那份为准（`resources/minke-skin/skin.js` 的 `initialChoice`），
写了也会被盖掉。快捷键本身的循环行为单独验一遍：按一次，读
`dataset.minkeSkin` 加看主进程收到的 save，两边对上就够了（注意 `auto`
会解析成当天轮到的那个视觉档，dataset 里看到的不是 `auto`）。
