# Fork 公约

这个仓库是 [lencx/Minke](https://github.com/lencx/Minke) 的 fork，要长期跟着上游走。
所有本地扩展都必须做到一件事：**`git rebase origin/main` 时冲突面接近零**。

下面是达成这一点的全部约定。加任何新功能前先读完。

> **先看全局**：[Minke 架构地图](https://claude.ai/code/artifact/5843c0ff-475f-4be0-9fd1-699adc932b39)
> ——构建管线（submodule → `stage.mjs` → `runtime/host` → app）、运行时拓扑
> （主进程 spawn harness 子进程，窗口 `loadURL` 到本地 HTTP）、client 层的
> 15 个模块与它们挂载的 slot，以及下面这四条缝各自接在运行时的什么位置。
> 链接是私有的 Claude artifact，只有仓库所有者能打开；本文件本身是自足的，
> 打不开也不影响读。

## 1. 扩展缝：优先用靠上的那一层

| 层 | 位置 | 改动上游文件 | 适合做什么 |
|---|---|---|---|
| L0 运行时 | `~/.minke/harness/`（`DSH_HOME`） | 无 | skills、MCP server 列表、任何用户态配置 |
| L1 注入层 | `resources/desktop-style-extension/` | 只有 `manifest.json` | 皮肤、页面级 CSS/JS |
| L2 组合层 | `packages/harness-overlay/cordis.patch.yml` | 末尾追加块 | 打开 harness 里现成但没组合的插件 |
| L3 自研层 | `packages/harness-overlay/src/fork/**` | 无（入口已经接好） | 自己写的 host 插件、工具、服务 |

**能用 L0 就别用 L1，能用 L3 就别再往 L2 加行。** L2 已经 insert 了 fork 的唯一入口
`@lencx/minke-harness-overlay/fork`，以后新增功能一律在 `src/fork/**` 里用
`ctx.plugin()` 自己挂，组合层不再增行。

## 2. 改上游文件的三条规则

1. **只新增，不重写。** fork 的内容永远追加在文件末尾——上游在中间加行时 3-way
   merge 不会冲突。
2. **一律加围栏。** 用 `>>> minke-fork` / `<<< minke-fork` 注释包住（YAML/JS 用
   `#` 或 `//`），这样冲突时一眼看得出哪半边是我们的。
3. **松开上游的精确断言，而不是跟着改。** 上游测试里
   `assert.deepEqual(某个清单)` 这种写法，fork 每加一项都要改一次。改成子集断言
   （`includes` / 只断言上游关心的字段），精确清单交给 fork 自己的测试拥有。

`packages/harness-overlay/tsconfig.fork.json` 是 fork 独有的新文件（不算改上游）：
`src/fork` import 的全是 `@deepseek-ai/*`，那些包名只在
`vendor/deepseek-harness/tsconfig.base.json` 的 paths + 项目引用下解析得到，
而 `tsconfig.host.json` 继承的是 Minke 根 tsconfig，`paths` 会被整体替换掉。
单开一个工程（抄 `packages/model-runtime/tsconfig.json` 的姿势）之后，
`tsconfig.host.json` 得以和上游保持逐字一致。

当前被改过的上游文件，全部带围栏：

- `packages/harness-overlay/cordis.patch.yml` — 末尾的 fork 组合块
- `packages/harness-overlay/package.json` — `exports["./fork"]`，以及 `typecheck`
  脚本追加 `tsconfig.fork.json`
- `config/harness-runtime.json` — `runtimePackages` 追加
- `scripts/harness/build-product-packages.mjs` — fork 的 esbuild entry
  （v0.2.0 前叫 `scripts/harness/build-overlay.mjs`）
- `scripts/harness/runtime-prune.mjs` — 多剪一条：Claude Agent SDK 随包发布的
  平台二进制（245 MiB，从不被执行）
- `package.json` — `test:fork` 脚本
- `config/source-assertion-baseline.json` — fork 两个测试文件的 source-text 断言配额
  （见下面那条「断言棘轮」）
- `tests/harness-overlay.test.mjs` — `runtimePackages` 的 deepEqual 换成 fork 自己的清单
  （上游 v0.2.0 起断言它是空的）
- `tests/macos-window-css.test.mjs` — 上游那条「不得出现 `session.defaultSession`
  **或** `extensions.loadExtension`」收窄成两条：禁 `defaultSession` 照旧，
  `loadExtension` 改成只许挂在 `#surfaceSession` 上（v0.4.0 起，见下面「皮肤的
  加载点」）
- `resources/desktop-style-extension/manifest.json` — 注入 `skin.css` / `skin.js`。
  **上游 v0.4.0 已经删掉了这个文件**，fork 整份留着
- `desktop/main/main-window.ts` — 恢复 `installSurfaceBootstrap()` 与
  `#macOSSurfaceBootstrapRoot()`（v0.4.0 起）
- `desktop/main/application.ts` — 恢复 `await windows.installSurfaceBootstrap()`
  的调用，排在 `installPermissionPolicy()` 之前（v0.4.0 起）
- `forge.config.ts` — `extraResource` 补回 `resources/desktop-style-extension`
  （v0.4.0 起）
- `desktop/renderer/styles.css` — 一行 `@import "./skin.css"`
- `.gitignore` — 忽略 `.claude/settings.local.json`；忽略 aurora / mono 两档的私人配图

`tests/web-search.test.mjs` 不再是被改的上游文件：上游 v0.4.0 把它从「boot 整棵
插件树」改回了纯单元测试，fork 那两处补丁没有了作用对象，同步时整个提交被 skip。
**代价是 fork 在 CI 里唯一一条真跑起来的上游测试没了**——「fork 的 host 插件能在
新版 harness 上加载」重新只能靠第 3 层手验。

**断言棘轮（v0.3.0 起）。** 上游加了 `tests/assertion-policy.test.mjs`：它扫全仓库
对「读进来的源码文本」做的 `assert.match`，和 `config/source-assertion-baseline.json`
**逐文件精确比对**——多了红，少了也红。fork 的两个测试文件本来就是靠读上游源码来锁缝的，
天然全是这种断言，所以必须在 baseline 里登记。**以后给 `tests/minke-*.test.mjs` 增删
一条 `assert.match`，同一次改动里就要改 baseline 的数字**，否则 `pnpm test:desktop` 红。
当前配额：`minke-fork` 13 条、`minke-skin` 16 条。改上游测试文件同样要跟——
v0.4.0 那次把 `macos-window-css` 的一条断言拆成两条，baseline 从 141 改成 142。

**`vendor/deepseek-harness` 永远不改。** `tests/harness-source-boundary.test.mjs`
会断言这个 submodule 是干净的；要改 harness 行为，走 L2/L3，不走 patch。

## 3. 如何验证

四层，从快到慢。关键是知道**每层能抓到什么、抓不到什么**——MCP 那个 shim bug 就是
前两层全绿、第三层才暴露的。

### 第 1 层：静态 + 构建期（秒级）

```bash
pnpm test:fork      # fork 自己的缝，必须绿
pnpm test:desktop   # 上游全量，fork 改动不该让它变红
pnpm harness:verify # 组合层与 runtime closure 的契约
```

`tests/minke-fork.test.mjs` 和 `tests/minke-skin.test.mjs` 是 fork 独有的，刻意不混进
上游测试文件。它们锁住了每一处缝：围栏在不在、入口有没有被挤掉、依赖的上游包还在不在。
**上游一改缝，这两个文件立刻红，而不是等打包或运行时才炸。**

抓不到：任何和真实进程、环境变量、子进程有关的事。

### 第 2 层：staged runtime（分钟级）

```bash
pnpm harness:stage
ls runtime/host/node_modules/@deepseek-ai/ | grep <你的包>
grep -c "minke-fork" runtime/host/node_modules/@lencx/minke-harness-overlay/cordis.patch.yml
```

抓得到：包没进 runtime closure、体积预算超标、patch 没被正确 staged。
Claude Code 那 245 MiB 的平台二进制就是被这层拦下来的。

### 第 3 层：隔离 harness —— 性价比最高，别跳过

**Minke 会吞掉 harness 的 stdout**：`desktop/main/harness-runtime.ts` 把子进程输出捕获进
缓冲区，只在**非预期退出**时才吐出来。正常运行时你在终端什么都看不到，`ctx.logger` 的
输出也看不到。这是调试 fork 插件最大的坑。

绕过办法是用隔离的 `DSH_HOME` 单独把 harness 跑起来，日志直接进终端，且不碰
`~/.minke` 里的真实会话：

```bash
R=$PWD/runtime/host
H=/tmp/dsh-test-home
E=$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
mkdir -p "$H" && cp ~/.minke/harness/minke-mcp.json "$H/" 2>/dev/null

ELECTRON_RUN_AS_NODE=1 DSH_HOME="$H" MINKE_NODE_EXECUTABLE="$E" \
MINKE_PNPM_ENTRY="$R/node_modules/pnpm/bin/pnpm.cjs" PATH="$R/bin:$PATH" \
"$E" --expose-internals "$R/index.mjs" web \
  --patch "$R/node_modules/@lencx/minke-harness-overlay/cordis.patch.yml" \
  --no-open --host 127.0.0.1 --port 0
```

参数取自 `desktop/main/harness-launch.ts` 的 `harnessWebArguments()`，环境取自
`harness-runtime.ts` 的 `harnessRuntimeEnvironment()`；那两个函数改了，这段也要跟着改。

抓得到：插件加载失败、子进程起不来、环境变量问题。而且能做干净的 A/B——改一个变量
再跑一次，因果立刻清楚。

### 第 4 层：真实 app

```bash
pnpm start   # 必须在有 TTY 的终端里跑，electron-forge start 是交互式的
```

三个观察点，可信度递增：

1. **插件清单**：设置 → 插件 → 插件列表，拉到底找你的插件
2. **进程树**：`ps -ax -o pid,ppid,command | grep <你的子进程>`
3. **问 agent**：「你可用的工具里有没有 xxx」

第三点不能省。**插件「已启用」不等于模型能看到它的工具**——preset 的工具过滤在最后一步
还能把它挡掉。`subagent_claude_code` 就是靠问 agent 才敢下结论的（结果是能看到：preset
自带的同名行是禁用的，我们 host 层 insert 的那行生效）。

### 加新功能时的最小流程

1. 写代码 → `pnpm test:fork`
2. `pnpm harness:stage` 看体积和闭包
3. **第 3 层跑一次读日志**
4. `pnpm start` 问一句 agent 确认工具可见

打包验证（`pnpm package` / `pnpm make:macos`）只在改动可能影响产物结构时才需要；
它会再跑一遍完整 stage，并报出 Host 与 app 的最终体积。

## 4. 同步上游的流程

```bash
git fetch origin
git rebase origin/main          # fork 改动都在自己的分支上
git submodule update --init     # 上游可能 bump 了 harness
pnpm test:fork && pnpm harness:verify
```

冲突只会落在带围栏的那几处。fork 改动尽量按主题分成独立 commit，rebase 时更好处理。

**上游 bump 了 harness 版本时，上面这四行不够。** `runtime/host` 还是旧版本，
`test:fork` 全是静态断言、`harness:verify` 也只查契约，三者都不会碰新 runtime，
于是全绿但什么都没验证。按这个顺序补：

```bash
# fork 的 runtimePackages 在新版 harness 里是否还存在
node -e 'import("./scripts/harness/contract.mjs")
  .then(m => m.verifyHarnessContract(process.cwd()))
  .then(() => console.log("contract OK"))
  .catch(e => { console.error("contract FAILED:", e.message); process.exit(1) })'

# fork 对 dsh-* 的调用签名是否还对得上（三个工程，含 src/fork）
pnpm --filter @lencx/minke-harness-overlay typecheck

# 重建 runtime/host，否则后面验的还是旧版本
pnpm harness:stage
```

`contract.mjs` 要求每个 `productBundle.runtimePackages` 条目在 `cordis.patch.yml`
里有对应的 `name: '<pkg>'`——`mcp-client-template` 那行 disabled 模板就是为它留的。
真正的运行时验证走上面第 3 节的第 3 层（隔离 harness）。

### 同步记录

| 日期 | 上游 | harness | 结果 |
|---|---|---|---|
| 2026-08-24 | `bd23660 → 3c79629` | `0.1.0-rc.8 → 0.1.1-rc.1` | rebase 零冲突 |
| 2026-08-25 | `3c79629 → 104249b`（v0.3.0，73 个提交） | `0.1.1-rc.1 → 0.1.1-rc.2` | 1 处冲突 + 2 处新缝 |
| 2026-09-03 | `104249b → 39cf048`（v0.4.0，31 个提交） | `0.1.1-rc.2 → 0.1.2-alpha.5` | 皮肤的注入路径被上游拆掉，重接 |

上游那次改了三块：Host RPC 换成 `MinkeHostRpcEndpoint` 泛型分发（未知 endpoint
现在返回 `bad-request`）、`main.ts` 拆出 `harness-lifecycle.ts` 与
`harness-permission-policy.ts`、新增 `scripts/harness/contract.mjs` 契约校验。
删掉的 `profile-plugin-location.patch` 是上游自己的，fork 不依赖。

两边只碰同一个文件 `config/harness-runtime.json`：上游改头部（commit / 版本 /
patches），fork 改尾部（`runtimePackages`），不同 hunk，3-way 自动合。
`cordis.patch.yml`、`skin.*`、`runtime-prune.mjs` 上游一行没动，`data-slot`
也全部原样——**末尾追加**那条规则这次是真的省事了。

验证：typecheck 三工程 `--force` 全量过、`test:fork` 20/20、5 档皮肤逐帧确认、
fork 四行插件全部挂载、MCP 动态挂载握手跑通。

#### 2026-08-25：v0.3.0

上游这次很大（IM 网关 + Telegram/Discord、agent browser、web_search、跨平台更新、
消息大纲导航），但和 fork 的缝几乎不重叠。rebase 14 个提交只冲突一处：
`packages/harness-overlay/package.json` 的 `exports`——上游加了 `./web-search`，
fork 加了 `./fork`，同一行位置。两条都留，fork 那条排在后面。

真正要新做的是**两条新缝**，都是上游新增的机制第一次撞上 fork：

1. **断言棘轮**（`tests/assertion-policy.test.mjs` + `config/source-assertion-baseline.json`）。
   fork 的两个测试文件全是读源码文本的断言，不登记就红。细节见第 2 节末尾。
2. **`tests/web-search.test.mjs` 会真的 boot 整棵插件树**——它把
   `packages/harness-overlay/cordis.patch.yml` 原样喂给 `boot()`，于是连 fork 的
   `minke-fork` 那行一起加载。两处要改：解析 hook 只短路了 `…overlay/web-search`
   一个子路径，得补上 `…overlay/fork`（否则整棵树起不来）；host 层工具清单的
   `assert.deepEqual(…, [])` 得收窄成 `["subagent_claude_code"]`（fork 在 host 层
   组合了 `dsh-tool-subagent`）。

   **顺带的好消息**：这条测试现在是 fork 唯一一条真跑起来的上游测试——
   它等于在 CI 里替我们验了「fork 的 host 插件能在新版 harness 上加载、
   `subagent_claude_code` 确实注册到 host 层」。以前这只能靠第 3 层手验。

`cordis.patch.yml`、`skin.*`、`runtime-prune.mjs`、`manifest.json` 上游一行没动。
皮肤依赖的 bootstrap 结构也没变——`data-slot` 那圈选择器原样生效。

验证：contract OK、typecheck 三工程 `--force` 全量过、`test:fork` 20/20、
`test:desktop` 283 条只剩 Homebrew node 那条恒失败的（见 `.claude/skills/verify`）、
`harness:stage` 127.4 MiB/11947 文件（预算 150 MiB/15000）、隔离 harness 干净启动、
MCP fixture 的 `initialize → tools/list` 握手跑通且子进程在、5 档皮肤逐帧确认。

#### 2026-09-03：v0.4.0 —— 皮肤的加载点被上游拆掉

这次和前两次性质不同。上游没碰 fork 的任何围栏，却把**皮肤赖以存在的那条注入路径**
整个拆了，两个提交连着做的：

1. `63861c2 fix(macos): defer credential access until authorization` —— 主窗口从
   `session.defaultSession` 搬到专用分区 `minke-main-window`（`#surfaceSession`），
   为的是推迟 macOS 凭据访问。`installSurfaceBootstrap()` 里那句 `loadExtension`
   顺手删了，`early.css` 改走 preload 的 `webFrame.insertCSS`。
2. `7471219 build(package): harden macOS artifact verification` —— 既然没人加载了，
   `manifest.json` 整个文件删掉，`forge.config.ts` 的 `extraResource` 也摘掉。

于是 `skin.css` / `skin.js` 还在，但没有任何代码去加载它们——**这是一次静默失效，
rebase 的冲突只报 `manifest.json`，硬解掉冲突皮肤照样是死的**。

fork 的选择是把扩展加载恢复回来，但挂在上游新建的 `#surfaceSession` 上而不是
`defaultSession`：上游真正关心的不变量（启动不得初始化 Chromium 的持久化 default
Session）没有被破坏，凭据推迟访问那个修复也照样成立。代价是 fork 改的上游文件从
2 个涨到 4 个（`main-window.ts`、`application.ts`、`forge.config.ts`、
`tests/macos-window-css.test.mjs`），而且 `main-window.ts` 那两处是**中间插入**不是
末尾追加——上游再重构 `MainWindowRuntime` 就要跟一次。

这三处新缝全部锁进了 `tests/minke-skin.test.mjs` 的
`the extension delivery path the skin rides on stays wired`：加载点、根目录解析、
启动顺序、打包条目，断一处就红。

rebase 17 个提交，冲突集中在三处：`manifest.json`（modify/delete，保留 fork 版本）、
`tests/macos-window-css.test.mjs`（上游重写，逐次取上游侧、末尾统一重接）、
`cordis.patch.yml`（上游也在末尾追加了 `ui-schedule`，两边都留、fork 块排最后）。
`tests/web-search.test.mjs` 那个 fork 提交整个 skip 掉了，原因见第 2 节末尾。

**又一次踩到「bump 后不重建 runtime」那个坑**，而且这次它伪装成了别的样子：
`test:desktop` 报 `embedded-node-permissions` 失败、`process-environment-boundaries.patch`
打不上。看着像 fork 改坏了 patch，实际是 `runtime/host` 还是上一版 harness 的产物、
patch 打在已经打过的代码上。`pnpm harness:stage` 之后就好。
**判据：先 `git diff --name-only origin/main..HEAD -- patches/ scripts/harness/`
看 fork 到底有没有碰到相关路径**，比拉对照 worktree 快得多。

排查这条时还踩了两个会给出无效结论的假象，都不是真信号：

- **对照 worktree 少了 `node_modules`**。`git worktree add` 出来的干净 origin/main
  照样红，但红的原因是依赖没装，不是同一个失败。要么装完再比，要么干脆别比。
- **单独 `node --test tests/某条.test.mjs` 会 `ERR_MODULE_NOT_FOUND`**
  （`Cannot find package '@minke/harness-overlay'`）。上游测试依赖 `pnpm test:desktop`
  里配的解析器，脱离 runner 单跑必红，和改动无关。缩小范围要用 runner 的过滤参数，
  不要直接 `node --test`。

## 5. 现有 fork 功能

### MCP 客户端（L2 + L3）

上游 harness 自带 `@deepseek-ai/dsh-mcp-client` 但 Minke 没组合。fork 打开了它，
并且**不在 YAML 里写死 server 列表**——列表放在 `~/.minke/harness/minke-mcp.json`，
由 `src/fork/mcp-servers.ts` 在启动时逐条展开成 mcp-client 实例：

```json
{
  "servers": [
    {
      "name": "files",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"]
    },
    {
      "name": "web",
      "enabled": false,
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  ]
}
```

模型看到的工具名是 `mcp__files__read_file` 这种形式。

**stdio server 的环境变量**：只来自用户自己在 `minke-mcp.json` 里写的 `env`，fork 不再
往里塞任何东西。

> 历史：v0.2.0 之前这里有一套 `FORWARDED_STDIO_ENV`。Minke 把 `runtime/host/bin` 放在
> PATH 最前面，那里的 `node` 是个 shim，缺 `DSH_ELECTRON_EXECUTABLE` 就直接退出，而
> harness 给子进程的是清洗过的环境，不带这个变量——任何走 `node`/`npx` 的 MCP server
> 一启动就死在 shim 上。上游 v0.2.0 把这个变量改名成 `MINKE_NODE_EXECUTABLE`
> （`config/embedded-node-runtime.mts`），并且**用 `MINKE_` 前缀让它主动活过环境清洗**，
> 同时显式 `delete` 掉旧名。也就是说上游从设计上解决了这个问题，而 fork 那套补丁既没用了、
> 转发的又是个已被删掉的变量名。整套已删除。

**已知副作用：Dock 里会多一个没有图标的 Minke 条目**。stdio server 走
`npx` → bin 脚本的 `#!/usr/bin/env node` → PATH 上的 `runtime/host/bin/node` shim →
`exec .../Minke.app/Contents/MacOS/Minke`。因为是从普通 shell 环境 exec bundle 内的
可执行文件（而不是像 harness 子进程那样由 Electron 主进程直接 spawn），macOS 会给它记一条
「最近使用的应用」，拿不到 bundle 图标，显示成通用 exec 图标。

它是无害的：不是第二个实例，不占额外内存，退出 Minke 就消失，不留持久垃圾。但右键只给
「强制退出」不给「从 Dock 中移除」——因为进程确实在跑；强制退出后 mcp-client 会重连把它
拉回来，所以看起来「杀不掉」。

已用对照实验确认是 MCP 引入的，不是上游行为：清空 `recent-apps` 后，不带
`minke-mcp.json` 启动记录保持为空（harness 子进程照跑），带上就出现。

不修。三个规避方案各有代价，留给使用者按需选：

- **配非 node 实现的 server**（Go/Rust 之类的独立二进制）——根本不走 shim，副作用自然
  不存在。成本最低，但取决于你要接的 server 有没有这种实现。
- **把 `command` 写成系统 node/npx 的绝对路径**——绕开 PATH 上的 shim，但要求机器上装了
  node，失去用 app 自带 runtime 的好处。
- **关掉 Dock 最近应用区**（`defaults write com.apple.dock show-recents -bool false`）
  ——一劳永逸，但改的是用户全局设置。

**默认姿态：代码常驻，功能休眠。** 仓库不带 `minke-mcp.json`，所以开箱状态下不挂载任何
server、不产生子进程、也就没有上面那个 Dock 条目；要用的时候建配置文件重启即可。
休眠的成本只是启动时一次 ENOENT 的 `readFile`。

顺带记一个容易误判的点：**删掉 MCP 代码并不会让 runtime 变小**。`dsh-mcp-client` 在 fork
介入之前就作为传递依赖躺在 runtime closure 里了，我们只是把它显式声明进 `runtimePackages`。
所以"删了能瘦身"这个理由不成立，删它的唯一收益是少一块要维护的代码。

配置改完**需要重启 Minke**
（暂不 watch）。配置文件不存在是正常状态；坏条目只会被跳过并打 warn，不会拖垮启动。

`cordis.patch.yml` 里那行 `mcp-client-template` 是 **disabled** 的模板行：它存在的唯一
理由是让 `contract.mjs` 认得这个包（校验要求 `runtimePackages` 的每个包都在 patch 里
被显式组合），从而把它留在 runtime closure 里。不要删，也不要启用。

### Claude Code subagent（L2）

组合了 `@deepseek-ai/dsh-subagent-claude-code` + 一个 `dsh-tool-subagent` 实例。
模型可以调 `subagent_claude_code` 把一个自包含任务委派给本机的 `claude` CLI。
登录、模型、沙箱全部由 Claude Code 自己拥有，Minke 既不装 CLI 也不碰它的配置。
要用得先本机装好并登录 `claude`。

> **v0.2.0 起与上游分道。** 上游原来有一组同构的 codex 行，v0.2.0 把它从
> `cordis.patch.yml` 里删了，改成让用户自己
> `dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex`，并加了一条
> 断言 patch 里不该出现任何 subagent 的测试。fork 保持内置组合——mcp-client
> 的实例要在运行时按配置动态挂载，走不了 plugin add 那条路，两者共用
> `productBundle.runtimePackages` 这一个机制，拆开反而更碎。代价是上游那条
> 断言被 fork 缩了作用域（只作用于围栏之外）。

### 皮肤（L1）

`resources/desktop-style-extension/` 在 Harness 页面上注入皮肤，
`desktop/renderer/skin.css` 管 Electron 启动窗口。

**加载点（v0.4.0 起由 fork 拥有）。** 上游已经不加载这个扩展了，是 fork 在
`desktop/main/main-window.ts` 的 `installSurfaceBootstrap()` 里把它挂到
`#surfaceSession` 上，由 `application.ts` 在 `installPermissionPolicy()` 之前调用，
打包靠 `forge.config.ts` 的 `extraResource`。四处缺一皮肤就整个失效，而且是静默的
——所以它们被 `tests/minke-skin.test.mjs` 锁住了。原委见第 4 节 v0.4.0 那条。

主题存在 `localStorage["minke.skin"]`，可选 `photo`（默认）、`aurora`、`paper`、
`mono`、`off`、`auto`（按日期在四个视觉主题间轮换）。**Alt+Shift+K 依次切换。**

配色全在 `skin.css`，`skin.js` 只负责解析选择并写到 `<html data-minke-skin>`。
没有属性时走 photo，所以脚本执行前的第一帧就已经是最终样式，不会闪。

`photo` / `aurora` / `mono` 各配一张图（`minke-background{,-aurora,-mono}.jpeg`），
`paper` 仍是纯渐变。图片必须走 `chrome.runtime.getURL()` 注入的
`--minke-background-image*` 变量——相对路径会解析到 Harness 的 HTTP origin——并且
每张都要在 `manifest.json` 的 `web_accessible_resources` 里放行。加图时三处一起改，
`tests/minke-skin.test.mjs` 会把「变量、文件、manifest 条目」三者的一一对应锁住。

图片档统一 `background-size: contain`，只在 `:root` 写一次，其余档继承。竖图在横窗口里
`cover` 会按宽度撑满、高度溢出一倍多，只剩一块大特写；`contain` 按高度缩，整张图完整
露出来，两侧留白由 `--minke-skin-color` 补。`desktop/renderer/skin.css` 管的启动窗口
是另一条分发路径（图片被 Vite 哈希后打进 `app.asar`），得单独跟着改。

皮肤用 `#root > main > div` 这类结构选择器代替往 `App.tsx` 加 className，换来上游文件
零 diff；代价是上游改结构会静默失效，所以 `tests/minke-skin.test.mjs` 把依赖的结构
锁住了。启动窗口暂时不跟随主题切换（那半边没有可用的 fork JS 钩子）。
