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
- `package.json` — `test:fork` 脚本
- `tests/harness-overlay.test.mjs` — `runtimePackages` 的 deepEqual 换成 fork 自己的清单
  （上游 v0.2.0 起断言它是空的）
- `tests/macos-window-css.test.mjs` — `content_scripts` 的 deepEqual 改成不变量断言
- `resources/desktop-style-extension/manifest.json` — 注入 `skin.css` / `skin.js`
- `desktop/renderer/styles.css` — 一行 `@import "./skin.css"`

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

主题存在 `localStorage["minke.skin"]`，可选 `photo`（默认）、`aurora`、`paper`、
`mono`、`off`、`auto`（按日期在四个视觉主题间轮换）。**Alt+Shift+K 依次切换。**

配色全在 `skin.css`，`skin.js` 只负责解析选择并写到 `<html data-minke-skin>`。
没有属性时走 photo，所以脚本执行前的第一帧就已经是最终样式，不会闪。

皮肤用 `#root > main > div` 这类结构选择器代替往 `App.tsx` 加 className，换来上游文件
零 diff；代价是上游改结构会静默失效，所以 `tests/minke-skin.test.mjs` 把依赖的结构
锁住了。启动窗口暂时不跟随主题切换（那半边没有可用的 fork JS 钩子）。
