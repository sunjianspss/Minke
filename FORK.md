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
| ~~L1 注入层~~ | ~~preload 注入~~ | — | **已退役**，见下方 |
| L2 组合层 | `packages/harness-overlay/cordis.patch.yml` | 末尾追加块 | 打开 harness 里现成但没组合的插件 |
| L3 自研层 | `packages/harness-overlay/src/fork/**` | 无（入口已经接好） | 自己写的 host 插件、工具、服务 |

**L1 已经没有了。** 皮肤曾经是这一层唯一的住户：`resources/minke-skin/` 的资源由
`desktop/preload/minke-skin.ts` 用 `webFrame.insertCSS` / `executeJavaScript` 注进
页面，再自建一对 IPC 通道落盘选择，代价是上游 `desktop-preload.ts` 和 `main.ts`
各两行。v0.4.0 上游把主窗口搬进内存态 session 时，这条注入路径被连根拔掉过一次。

现在它整体搬进 L3（`src/fork/skin/**`），走上游自己声明的缝：
`webserver/index-inject` 推样式和脚本，`settings.register` 存选择，
`connection.fetch.register` 收写回。**fork 对 `desktop/**` 的 diff 归零。**
再有"页面级 CSS/JS"的需求，照这个路子写 host 插件，别再往 preload 里加行。

**能用 L0 就别用 L3，能用 L3 就别再往 L2 加行。** L2 已经 insert 了 fork 的唯一入口
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
- `package.json` — `test:fork` / `test:fork:boot` 脚本
- `config/source-assertion-baseline.json` — fork 两个测试文件的 source-text 断言配额
  （见下面那条「断言棘轮」）
- `tests/harness-overlay.test.mjs` — `runtimePackages` 的 deepEqual 换成 fork 自己的清单
  （上游 v0.2.0 起断言它是空的）
- `desktop/renderer/styles.css` — 一行 `@import "./skin.css"`（只是 Minke 自己的
  bootstrap 页，和 harness 页面上的皮肤是两回事）
- `package.json` — 还有 `test:skin:surface` 脚本
- `packages/harness-overlay/tsconfig.fork.json` — fork 自有文件，`references` 里
  多了 webserver / settings 两个工程（皮肤插件要它们的类型）

`desktop/preload/desktop-preload.ts` 和 `desktop/main/main.ts` **不再是被改的上游
文件**：皮肤搬进 host 插件后，那四行全部退役，两个文件现在和上游逐字一致。
- `.gitignore` — 忽略 `.claude/settings.local.json`；忽略 aurora / mono 两档的私人配图

`tests/web-search.test.mjs` 不再是被改的上游文件：上游 v0.4.0 把它从「boot 整棵
插件树」改回了纯单元测试，fork 那两处补丁没有了作用对象，同步时整个提交被 skip。
那份覆盖已经由 fork 自己的 `tests/minke-fork-boot.test.mjs` 接管（第 3 节第 1.5 层），
**不再寄生在上游测试上**——上游怎么改自己的测试都不会再把它带走。

`package.json` 的 fork 脚本现在有两条：`test:fork` 和 `test:fork:boot`。

**断言棘轮（v0.3.0 起）。** 上游加了 `tests/assertion-policy.test.mjs`：它扫全仓库
对「读进来的源码文本」做的 `assert.match`，和 `config/source-assertion-baseline.json`
**逐文件精确比对**——多了红，少了也红。fork 的两个测试文件本来就是靠读上游源码来锁缝的，
天然全是这种断言，所以必须在 baseline 里登记。**以后给 `tests/minke-*.test.mjs` 增删
一条 `assert.match`，同一次改动里就要改 baseline 的数字**，否则 `pnpm test:desktop` 红。
当前配额：`minke-fork` 13 条、`minke-skin` 23 条。

顺带一条经验：**能用行为断言就别用源码文本断言**。「skin.js 不再依赖 `chrome`」
原本写成 `assert.doesNotMatch(skinScript, /chrome\.runtime\.getURL\(/)`，结果被
注释里那句历史说明打红了。改成让沙箱里根本不提供 `chrome` 全局、脚本照样跑通——
证明更强，还不占棘轮配额。

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

### 第 1.5 层：boot 整棵插件树（秒级，但要先构建）

```bash
pnpm test:fork:boot   # 先 build:product-packages，再 boot
```

`tests/minke-fork-boot.test.mjs` 把 fork 自己的 `cordis.patch.yml` 原样喂给 `boot()`，
断言 `subagent_claude_code` 真的注册到了 **host 层**。它补的正是第 1 层够不着、
第 3 层才暴露的那一格：**「插件已启用」不等于工具可见**。

单独成文件、单独一个 script，因为它有两个第 1 层没有的前置：
`packages/harness-overlay/lib/` 是 `.gitignore` 掉的构建产物（所以 script 里先
`build:product-packages`），而且 `boot()` 会留下活着的 handle，runner 不加
`--test-force-exit` 就挂着不退。

**上游新增一个依赖 `connection` 的插件时这条会红**——boot 要求每个 entry 都激活，
而我们为了不绑端口把 `connection` / `webserver` / `web-runtime` 关掉了。这不是 fork
坏了：把那个插件的 id 加进文件里的 `CONNECTION_DEPENDENTS` 即可，测试的失败信息
会直接告诉你该这么做。注意 id 取的是 `cordis.patch.yml` 里的 `id:`，不是包名
（`@deepseek-ai/dsh-session-log-export` 的 id 是 `session-log-download`）。

由来见第 4 节 v0.4.0 那条：这份覆盖原先是白蹭上游 `tests/web-search.test.mjs` 的，
上游把那条测试改回纯单元测试之后就没了，现在由 fork 自己拥有。

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

### 第 3.5 层：皮肤的运行时验证 —— `pnpm test:skin:surface`

皮肤是 fork 里唯一一处「静态断言全绿、东西其实已经坏了」的地方，所以它有自己的
一条运行时命令。约 25 秒，自己起隔离 harness 和一个 Electron 小宿主，逐档收真实帧。

```bash
pnpm test:skin:surface
```

它盯的是两类**真实发生过、且静态断言抓不到**的回归：

| 形态 | 什么时候发生的 | 断言 |
|---|---|---|
| 上游给每列加了自带不透明底的面板，皮肤被整个盖住 | v0.2.0 | 从视口中心往上钻，body 之上不许有铺满视口的不透明元素 |
| 上游把 slot 改了名，打透明的规则匹配 0 个元素 | v0.5.0 引入、v0.6.1 漏掉 | 皮肤 CSS 里锚的每个 data-slot 都必须在页面上存在 |

还顺带验：5 档的帧两两不同（抓「皮肤整个没生效」和「收帧偏移一位」）、三个图片档
的背景真的是内联 data URI、off 档把 body 完整还给上游、快捷键按一次页面档位和主进程
收到的写回一致。

**两条设计约束，改这个脚本时别破坏：**

1. **锚点必须从 `skin.css` 解析，不能写死在探针里。** 写死的话探针量的永远是「对的
   那几个名字」，皮肤实际锚了什么不影响结果——第一版就是这样，把锚点改回上游已经
   废弃的 `conversation`，整条命令照样全绿。**守卫写完必须种一次真故障验它会红。**
2. **判据是「锚元素在不在」，不是「有没有子元素」。** 右列默认折叠，元素在但没有
   子元素是正常状态；被改名的 slot 才是整个查不到。

两条负向对照都验过：把锚点改回 `conversation` → 红；把打透明改成不透明白底 → 红
（4 档报被盖住 + 1 条报面板没打透明）。

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
4. 碰过皮肤的话 → `pnpm test:skin:surface`
5. `pnpm start` 问一句 agent 确认工具可见

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
# 上游可能把 dsh-* 开发依赖改成 link: 到 submodule 源码，不重装就还是旧版本
pnpm install

# fork 的 runtimePackages 在新版 harness 里是否还存在
node -e 'import("./scripts/harness/contract.mjs")
  .then(m => m.verifyHarnessContract(process.cwd()))
  .then(() => console.log("contract OK"))
  .catch(e => { console.error("contract FAILED:", e.message); process.exit(1) })'

# 重建 runtime/host。**必须排在 typecheck 前面**：submodule 的 node_modules 是
# 上一版留下的，装它的是 stage.mjs 里那句 `pnpm install --recursive`，根目录的
# pnpm install 管不着。顺序反了，typecheck 会在 vendor/ 里报一堆 TS2307，
# 看着像 fork 的签名对不上，其实只是 submodule 没装（2026-09-17 踩过）。
pnpm harness:stage

# fork 对 dsh-* 的调用签名是否还对得上（三个工程，含 src/fork）
pnpm --filter @lencx/minke-harness-overlay typecheck

# 皮肤在新版 harness 上还活着吗（逐帧，约 25 秒）
pnpm test:skin:surface
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
| 2026-09-10 | `39cf048 → 458980e`（v0.5.0，4 个提交） | `0.1.2-alpha.5 → 0.1.3-alpha.1` | rebase 零冲突，boot 名单补两项 |
| 2026-09-14 | `458980e → ffb0da8`（v0.6.1，23 个提交） | `0.1.3-alpha.1 → 0.1.5-rc.2` | 1 处冲突，boot 名单再补两项 |
| 2026-09-17 | `ffb0da8 → bdb6a7a`（v0.7.0，13 个提交） | `0.1.5-rc.2 → 0.1.6-alpha.1` | rebase 零冲突，修好早已失效的两个皮肤锚点 |

同步之后顺着做了两件事：皮肤的逐帧确认变成 `pnpm test:skin:surface`
（第 3 节第 3.5 层），以及**皮肤整体从 preload 搬进 host 插件**——
`webserver/index-inject` + `settings.register` + `connection.fetch.register`
三条上游自有的缝，`desktop/**` 对上游的 diff 归零，L1 那一层就此退役。
细节和四个踩过的坑见第 5 节「皮肤（L3）」。

#### 2026-09-17：v0.7.0 —— 顺序反了，以及皮肤锚点的无声失效

rebase 29 个提交零冲突。上游碰了 fork 改过的三个文件，但全在头部（版本号、
submodule commit、一句注释措辞），fork 在尾部，3-way 自动合——**末尾追加**这条
规则又一次兑现。`minke-skin.ts`、`forge.config.ts`、`runtime-prune.mjs`、
断言基线上游一行没动。

**第 4 节那四行加四行的顺序这次是错的，按它走会得出假结论。** 上游把
`@modelcontextprotocol/sdk@1.29` 换成了 `@modelcontextprotocol/client@2.0.0`
（`dsh-mcp-client` 的依赖改了名），而 submodule 的 `node_modules` 是上一版留下的。
照第 4 节的顺序先 typecheck，会在 `vendor/` 里报 6 条 `TS2307: Cannot find module
'@modelcontextprotocol/client'`——看起来像 fork 的调用签名对不上，其实只是
submodule 没装。装 submodule 依赖的是 `harness:stage`（`stage.mjs` 里那句
`pnpm install --recursive --frozen-lockfile`），根目录的 `pnpm install` 不管
submodule 那个 workspace。

→ **上游 bump harness 时，`harness:stage` 要排在 typecheck 前面。**
根目录 `pnpm install` 和 contract 仍在最前（contract 只读 JSON，不碰 node_modules）。

**查出一处既有缺陷：皮肤的打透明规则有三分之二锚在不存在的 slot 上。**
`skin.css` 的 `[data-slot="sidebar" | "conversation" | "details"] > *` 里，
后两个上游早就改名了——harness `581803bf`（`feat(client): add global sidebar
panels`，落在 `dsh-v0.1.5-alpha.2`）把 `conversation` 拆成 `main` /
`main.conversation`，`details` 换成 `rightbar` / `rightbar.session`。也就是说
**这是 v0.6.1 那次同步就该发现、却漏掉的**，不是 v0.7.0 引入的。

眼下皮肤看着仍然正常（5 档逐帧都对），因为新的中列面板当前不带不透明底——
**护栏没了，但还没撞上。** 上游哪天给 `main.conversation` 加回不透明底，
皮肤就会整片被盖住，而计算样式全部正常。

为什么测试没拦住：`tests/minke-skin.test.mjs` 的「punches through upstream's
per-column panels」只断言 **fork 自己的 CSS 里写了这三个选择器**，从不检查
**上游是否还在发这些 slot**。这条断言的注释写着「上游一改结构就会失败」，
但那只对同文件里 `#root > main > div` 那条成立。**验自己写了什么，不等于验它还
匹配得上**——这是这次的教训，和 v0.3.0 那条「寄生在上游测试上的覆盖会被无声收走」
是同一类病的两面。

**已修（同一次同步里跟着做了）：** 锚点换成 `main.conversation` / `rightbar`，
并给 `minke-skin.test.mjs` 补了一条**读上游 `slot-catalog.ts` 的断言**——
皮肤规则里用到的每个 data-slot 都必须在那份目录里存在，上游一改名立刻红。
（验过不是空断言：把锚点改回 `conversation` 立即失败，还原即绿。）

中列锚 `main.conversation` 而不是 `main`，是跑起来量出来的：`main` 的直接子元素
是个 0×0 空壳，真正铺满整列、带 CSS Module 底色的 `ConversationRoot`
（`-TPGmq_root`，正是原注释里记下的那个哈希）挂在 `main.conversation` 下。
`rightbar` 默认折叠、没有子元素，和当年 `details` 的情形一样。

验证：contract OK、三工程 typecheck `--force` 全量过、`test:fork` 24/24、
`test:assertions` 3/3、`test:fork:boot` 插件树起得来、`test:desktop` 224 条只剩
Homebrew node 那条恒失败的（见 `.claude/skills/verify`）、`harness:stage`
149.0 MiB/11653 文件、隔离 harness 干净启动、5 档皮肤逐帧确认、快捷键
`photo → aurora` 且主进程收到 save。

**顺带记一笔预算：** 运行时 149.0 MiB，darwin 预算 157286400 字节（150.0 MiB），
只剩 1 MiB 余量（上一版 127.4 MiB）。下次上游再长一点就会撞线。

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

   > **这条好消息只活了一个版本。** v0.4.0 上游把这条测试改回了纯单元测试，
   > 覆盖随之消失。现在它由 fork 自己的 `tests/minke-fork-boot.test.mjs` 拥有，
   > 见第 3 节第 1.5 层。**寄生在上游测试上的覆盖会被上游无声收走**——这是教训。

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

**第一版的选择是错的，而且是死路，记在这里免得再走一遍。** 当时想的是把
`loadExtension` 恢复回来、挂到上游新建的 `#surfaceSession` 上——静态断言、打包
核对、asar 反查三层全绿，真 app 一启动就崩：

```
Error: Extensions cannot be loaded in a temporary session
```

`session.fromPartition("minke-main-window")` 没有 `persist:` 前缀，是**内存态
session**，Electron 不允许往里加载扩展。而这个「内存态」恰恰就是上游那个修复本身
（注释原话：`The in-memory desktop surface never initializes Chromium's Keychain`）。
改成 `persist:` 能让扩展装上，但等于把上游修的 Keychain 提前初始化原样退回去。
**没有折中余地，这条路结构上就不通。**

最终方案是跟着上游走同一条路：皮肤改由 preload 注入。

- CSS：`webFrame.insertCSS(skinCss)`，紧跟上游的 `early.css` 之后（排序决定覆盖）。
- JS：`webFrame.executeJavaScript()` 送进页面的 **main world**。不能留在 preload
  的 isolated world——`skin.js` 要读写 `localStorage["minke.skin"]`，而那一侧的
  storage 未必是 Harness origin 的那一份。
- 图片：**构建期内联成 `data:` URI**。没有 `chrome.runtime` 了，相对路径会解析到
  Harness 的 HTTP origin（这正是当初改用扩展 URL 的原因），`file://` 又会被
  Chromium 按跨协议拦掉，只有 `data:` 不依赖任何 origin。代价是 preload 从 ~50 KB
  涨到 1.33 MB。
- 用 `import.meta.glob(..., { eager: true, query: "?inline" })` 而不是三条静态
  `import`：aurora / mono 是 `.gitignore` 掉的私人配图，clone 下来根本不存在，
  静态 import 会让**构建直接失败**；glob 匹配不到就没有这一项，`var()` 自己回落到
  `none`——缺图只该少一档，不该炸构建。

顺带把 fork 的皮肤资产从 `resources/desktop-style-extension/` 挪到了
`resources/minke-skin/`：扩展已经不存在，继续放在那个目录里是误导，而且挪走之后
**上游那个目录恢复成和上游逐字一致**（只剩 `early.css`）。被改的上游文件也从
一开始设想的 4 个减到 1 个（`desktop-preload.ts`，两行）。

> **这一整段后来整个作废。** 皮肤在 v0.7.0 那次搬进了 host 插件，
> `resources/minke-skin/` 也跟着挪进
> `packages/harness-overlay/assets/minke-skin/`（要跟着包进 `runtime/host`），
> preload 那两行退役，`desktop-preload.ts` 恢复成和上游逐字一致。
> 留着这段是因为「为什么不是扩展」那个结论仍然有效。

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

#### 2026-09-10：v0.5.0

上游只有 4 个提交（About 弹窗的层级修正、harness 同步到 alpha.1、发版、
agent-browser smoke 遵循 reduced motion），改动全在 fork 碰不到的地方：
`patches/deepseek-harness/`（新增上游自己的 `win32-directory-picker.patch`，
重写进程边界与后台进程两个 patch）、`scripts/harness/runtime-process-policy.mjs`、
各 package 版本号。`cordis.patch.yml`、`skin.*`、`runtime-prune.mjs`
一行没动，rebase 24 个提交零冲突。

**新踩到一步：`pnpm install` 现在是同步流程的一部分。** 上游把
`dsh-invariants` / `dsh-llm` / `dsh-typert-protocol` 三个开发依赖从 registry
版本改成 `link:vendor/deepseek-harness/...`（`pnpm-workspace.yaml` 的
`overrides`），不重装的话 typecheck 解析到的还是上一版 harness 的那份声明。
已经补进上面「上游 bump 了 harness」那段流程的第一步。

**真正要改的只有一处**：新 harness 的 `client/file-upload` 直接
`inject connection`，而它是 `fileUploads` 服务的唯一提供者，于是只依赖
`fileUploads` 的 `api/session-controller` 被连锁挂住，
`tests/minke-fork-boot.test.mjs` 两个 entry 停在 pending。往
`CONNECTION_DEPENDENTS` 补 `file-upload` / `session-controller` 即可——
**注意那个名单吃的是 `cordis.patch.yml` 里的 `id`，不是包名后缀**：
失败信息打印的是 `@deepseek-ai/dsh-client-file-upload`，照抄成
`client-file-upload` 是无效的，那样只会多出两行谁也匹配不上的 disabled 行，
测试照旧红。

验证：contract OK、typecheck 三工程 `--force` 全量过、`harness:stage` 141.2 MiB
/11606 文件、`test:fork` 24/24、`test:fork:boot` 1/1、`test:assertions` 3/3
（这次没增删 `assert.match`，baseline 配额不变）、`test:desktop` 的
core / ui / host 209 / 282 / 325 全绿，harness 组 203/204——红的那条是
Homebrew node 上恒失败的 prune 用例（见 `.claude/skills/verify`），
和本次同步无关：该测试与 `runtime-prune.mjs` 都与 rebase 前逐字节相同。

#### 2026-09-14：v0.6.1

上游 23 个提交、连发 v0.6.0 和 v0.6.1，主线是 sidebar 改造
（`19f7193` 把 Minke 的 tab 塞进 DSH 原生容器）、files 渲染预览、
models 的运行时状态，外加两次 harness 同步
（`0.1.3-alpha.1 → 0.1.5-alpha.2 → 0.1.5-rc.2`）。

rebase 26 个提交**只冲突一处**：`package.json` 的脚本区，上游加
`test:desktop:harness-navigation`、fork 加 `test:fork`，落在同一行位置。
两条都留，上游那条在前。`cordis.patch.yml`、`skin.*`、`runtime-prune.mjs`、
`build-product-packages.mjs` 上游一行没动；`config/harness-runtime.json` 还是
老样子——上游随两次 harness 同步改头部，fork 改尾部的 `runtimePackages`，
不同 hunk 自动合。

**又是 `CONNECTION_DEPENDENTS`，同一个位置第二次。** 新 harness 的
`open-in-app`（inject `webServer` / `connection` / `subprocess`）和
`ui-deliverables`（inject `connection` / `sessionController`）都直连 connection，
隔离 boot 里两个 entry 停在 pending。补进名单即可（id 取自
`cordis.patch.yml`，不是包名后缀——这条坑上一版记过）。**上游每加一个依赖
connection 的插件，这里就要补一次**，失败信息里已经写好了处方，照做就行。

**sidebar 被重做，但 `data-slot` 契约扛住了。** 这次最该担心的是皮肤：
上游把 tab 换成原生容器，理论上足以让 `[data-slot="sidebar"]` 那圈穿透规则落空。
实测没有——从视口里侧边栏位置往上钻完整祖先链，`sidebar.workspaces` /
`sidebar` / `sidebarCol` / `frame` 逐层 `rgba(0, 0, 0, 0)`，皮肤照旧透到底。
**锚 `data-slot`、取直接子元素、不猜层数**这条选择第二次兑现了。

验证：contract OK、typecheck 三工程过、`harness:stage` 145.8 MiB/11566 文件、
`test:fork` 24/24、`test:fork:boot` 1/1、`test:desktop` 223/224（红的那条是
Homebrew node 上恒失败的 prune 用例，见 `.claude/skills/verify`）、隔离 harness
干净启动且 `--dump-config` 里 fork 四行齐全、MCP fixture 的
`initialize → notifications/initialized → tools/list` 握手跑通且子进程活着、
5 档皮肤逐帧确认、快捷键从 `off` 推进到 `auto`（当天解析成 `paper`）再到 `photo`，
主进程侧收到的 save 是 `["auto", "photo"]`——**持久化走的是主进程那一份，不是页面**。

**打包体积要盯一眼了**：145.8 MiB / 11566 文件，预算是 150 MiB / 15000。
文件数还很宽裕，字节数只剩 4 MiB 余量（v0.3.0 时是 127.4 MiB）。
下次 harness bump 如果再涨，得先看 `runtime-prune.mjs` 还能多剪什么。

**verify skill 里的 skin-surface 小宿主过期了一整个版本**——那份 recipe 还写着
`loadExtension` + `resources/desktop-style-extension`，是 v0.4.0 之前的路。
这次一并改掉了，宿主现在要提供两样东西：`pnpm build:preload` 产出的
`.vite/build/desktop-preload.js` 当 `webPreferences.preload`（`sandbox: true`
/ `contextIsolation: true`，和 `main-window.ts` 对齐），以及主进程里接住
`minke-fork:skin:read` / `minke-fork:skin:write` 两个 channel。**第二样最容易
漏**：不接的话 preload 那次 invoke 直接 reject，皮肤一律回落默认档，四个档
看起来全是 photo——像极了"皮肤坏了"。逐档验证时改 read 返回的值再 `loadURL`
一次，别去写页面的 `localStorage`（那只是桥不在时的兜底）。顺带：harness 现在
的 URL 带 `?token=`，宿主 `loadURL` 必须原样带上。

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

### 皮肤（L3）

素材在 `packages/harness-overlay/assets/minke-skin/`（`skin.css` / `skin.js` /
三张图），实现在 `packages/harness-overlay/src/fork/skin/`，
`desktop/renderer/skin.css` 另管 Electron 自己的启动窗口（那是另一个面）。

**它对上游 `desktop/**` 零改动。** 三条缝都是上游自己声明、自己也在用的：

| 干什么 | 走哪条缝 | 上游谁在用 |
|---|---|---|
| 把样式、脚本、初值、背景图送进页面 | `ctx.on("webserver/index-inject")` | `ui-theme`、`connection`、`modules`、`inspector` |
| 存选择 | `ctx.settings.register("minke-skin", schema)` | `ui-theme` 存 light/dark 用的同一份文档 |
| 收页面的写回 | `ctx.connection.fetch.register` → `POST /api/minke-skin` | `file-upload`、`session-log-export`、`session-controller` |

素材跟着 overlay 包的 `files: ["lib", "assets", …]` 进 `runtime/host`，host 插件在
运行时读；背景图读成 data: URI 直接塞进注入行，不走 HTTP——多一次往返首帧就会闪。

**取图按 `$DSH_HOME/skins/<文件名>` → 包内 `assets/minke-skin/<文件名>`，先命中的
算数。** 只有 photo 那张随包分发；aurora / mono 是私人配图，住在
`~/.minke/harness/skins/`，**不在仓库树里**。这不只是"公开仓库不能放私图"：

- 它们曾经放在包里，于是跟着 `files` 进 `runtime/host`——**"这台机器上有没有
  私图"决定了运行时体积**，而 darwin 预算只剩不到 1 MiB 余量（`stage.mjs:180`
  那道硬闸）。表现会是 CI 全绿、有私图的机器先撞墙，最难查的那一种。
- `~/.minke` 不受 `git clean -xdf` 影响，私图不会在清仓库时被误删。
- 同名文件丢进 `$DSH_HOME/skins/` 也能盖掉随包的默认图。

读不到就跳过，那一档退化成纯底色，而不是让插件起不来。新机器上把私图拷进
`~/.minke/harness/skins/` 即可——次数和以前拷进仓库目录一样，就一次。

可选 `photo`（默认）、`aurora`、`paper`、`mono`、`off`、`auto`（按日期在四个视觉
主题间轮换）。**Alt+Shift+K 依次切换。**

**四个踩过的坑，改这块前先看：**

1. **`connection.fetch.register` 的 `path` 要写全路径，连 `/api` 一起。** 契约里
   那句「Absolute path below `/api`」容易读成只填下半截；注册表用 `route.path`
   原样做键，查表却用请求的完整 pathname——只写 `/minke-skin` 能注册成功、永远
   查不到，表现是稳定的 404。
2. **绘制和写回要分成两个 `ctx.inject`。** 合在
   `ctx.inject(["webServer", "connection"])` 里时，connection 缺席会让整块回调都不
   执行，表现是**皮肤整个消失**（一条注入行都没推），而不是"切换存不下来"。
3. **别退回 `ctx.webServer.register` 自己拼裸路由。** 那样既要自己调
   `connection.requestRejection`，又要自己读请求流；实测 handler 进得到，但
   `for await (const chunk of req)` 永远不结束，请求就挂在那儿。
4. **皮肤压过 `early.css` 靠的是特异性，不是注入顺序。** early.css 由 preload 的
   `webFrame.insertCSS` 注入，皮肤是 index.html 里的 `<style>`，谁先谁后不由我们
   决定；同级 `!important` 比顺序，所以皮肤写 `html body`（0,0,2）稳赢
   `html, body, #root`（0,0,1）。

**选择存在 host，不存在页面里。** 两条独立原因各自都足以让页面侧的存储活不过一次
重启：

1. 主窗口跑在 `session.fromPartition("minke-main-window")` 上，**没有 `persist:`
   前缀就是内存态 session**，localStorage 关掉 app 就没了。这个内存态正是上游
   63861c2 推迟 Keychain 初始化的手段，动不得。
2. harness 每次都 `--port 0` 随机端口，页面 origin 跟着变，而 localStorage 按
   origin 分区。`~/.minke/Local Storage/leveldb` 里能看到十几个
   `_http://127.0.0.1:<不同端口>` 各存一份。

`localStorage` 降级成兜底：写回失败时（没鉴权、别的宿主）本次会话仍然记得住。

**整条链路由 `pnpm test:skin:surface` 覆盖**（第 3 节第 3.5 层）：它逐档走
POST → 设置文档 → 下次 index 注入，所以"选择活不活得过重启"这件事不再只能靠
第 4 层手验。

配色全在 `skin.css`，`skin.js` 只负责解析选择并写到 `<html data-minke-skin>`。
没有属性时走 photo，所以脚本执行前的第一帧就已经是最终样式，不会闪。

`photo` / `aurora` / `mono` 各配一张图（`minke-background{,-aurora,-mono}.jpeg`），
`paper` 仍是纯渐变。图片由 host 插件在**运行时读成 `data:` URI**
（`src/fork/skin/assets.ts` 的 `BACKGROUNDS` 表），经 index-inject 的 global 行
送进页面；`skin.js` 只负责把拿到的 URI 写进 `documentElement.style`——它自己不认识
文件名。相对路径和 `file://` 都不行（前者解析到 Harness 的 HTTP origin，后者被跨
协议拦掉）。不走 HTTP 路由取图也是有意的：多一次往返，首帧就会闪一下白底。

**加图要改两处**：把文件放进 `~/.minke/harness/skins/`（私人图）或
`packages/harness-overlay/assets/minke-skin/`（愿意随包分发的），并在 `assets.ts`
的 `BACKGROUNDS` 里加一行。

**随包分发的图先压到显示尺寸再提交。** 窗口高 855px、`contain` 按高度缩，Retina
2x 也就 1710px，超出的像素纯属白占预算。`sips --resampleHeight 1710 -s format jpeg
-s formatOptions 55` 是验过的档位——图上还压着一层 0.42 透明度的白罩，看不出损失。
注意别用高 quality 重编码已经压好的 JPEG：quality 82 那次反而把三张图整体撑大了。
`tests/minke-skin.test.mjs` 把「变量、文件、映射」三者的一一对应锁住了。
私人配图记得同时进 `.gitignore`。

图片档统一 `background-size: contain`，只在 `:root` 写一次，其余档继承。竖图在横窗口里
`cover` 会按宽度撑满、高度溢出一倍多，只剩一块大特写；`contain` 按高度缩，整张图完整
露出来，两侧留白由 `--minke-skin-color` 补。`desktop/renderer/skin.css` 管的启动窗口
是另一条分发路径（图片被 Vite 哈希后打进 `app.asar`），得单独跟着改。

皮肤用 `#root > main > div` 这类结构选择器代替往 `App.tsx` 加 className，换来上游文件
零 diff；代价是上游改结构会静默失效，所以 `tests/minke-skin.test.mjs` 把依赖的结构
锁住了。启动窗口暂时不跟随主题切换（那半边没有可用的 fork JS 钩子）。
