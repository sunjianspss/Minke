# Fork 公约

这个仓库是 [lencx/Minke](https://github.com/lencx/Minke) 的 fork，要长期跟着上游走。
所有本地扩展都必须做到一件事：**`git rebase origin/main` 时冲突面接近零**。

下面是达成这一点的全部约定。加任何新功能前先读完。

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

## 3. 守卫测试

```bash
pnpm test:fork      # fork 自己的缝，必须绿
pnpm test:desktop   # 上游全量，fork 改动不该让它变红
pnpm harness:verify # 组合层与 runtime closure 的契约
```

`tests/minke-fork.test.mjs` 和 `tests/minke-skin.test.mjs` 是 fork 独有的，刻意不混进
上游测试文件。它们锁住了每一处缝：围栏在不在、入口有没有被挤掉、依赖的上游包还在不在。
**上游一改缝，这两个文件立刻红，而不是等打包或运行时才炸。**

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

**stdio server 的环境变量转发**：Minke 把 `runtime/host/bin` 放在 PATH 最前面，那里的
`node` 是个 shim，缺 `DSH_ELECTRON_EXECUTABLE` 就直接退出；而 harness 给子进程的是清洗过
的环境，不带这个变量。结果是任何走 `node`/`npx` 的 MCP server 一启动就死在 shim 上，然后
按重连策略反复重试。`src/fork/mcp-config.ts` 的 `FORWARDED_STDIO_ENV` 会把它补进每个 stdio
server 的 env（用户显式写的 env 优先）。这条被 `pnpm test:fork` 锁住了——真机上验证过，
不补就起不来，补上就正常。

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
