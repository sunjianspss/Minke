// Fork 的 boot 测试，独立成文件，跑 `pnpm test:fork:boot`。
//
// 和 minke-fork / minke-skin 那两个纯静态文件不同：这条**真的把插件树 boot 起来**，
// 用的是 fork 自己的 packages/harness-overlay/cordis.patch.yml。它验的是静态断言
// 够不着的那一层——fork 的 host 插件能不能在当前这版 harness 上加载、组合出来的
// 工具有没有真的注册到 host 层。
//
// 由来：上游 v0.3.0～v0.4.0 之间，tests/web-search.test.mjs 恰好会 boot 整棵树，
// fork 在它身上打了两处补丁白蹭到这份覆盖。v0.4.0 上游把它改回纯单元测试，覆盖
// 就没了（见 FORK.md 第 4 节 v0.4.0 那条）。这个文件是把它拿回来，且不再寄生在
// 上游测试上。
//
// 前置：packages/harness-overlay/lib/ 是构建产物且被 .gitignore 忽略，所以
// test:fork:boot 会先 build 再跑。这也是它不并进秒级的 test:fork 的原因。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const harnessRoot = join(projectRoot, "vendor", "deepseek-harness");
const harnessUrl = pathToFileURL(`${harnessRoot}/`).href;
const harnessModulesAnchor = pathToFileURL(
  join(
    harnessRoot,
    "node_modules",
    ".pnpm",
    "node_modules",
    "_minke_fork_boot.mjs",
  ),
).href;

// Harness 用的是隔离的 pnpm linker，裸 import 要重新锚到 workspace 这一份，
// 所有插件才共用同一个 Cordis 单例。overlay 的子路径入口直接短路到 lib 产物：
// web-search 是上游在 cordis.patch.yml 里组合的，fork 是我们自己那行，缺一
// 整棵树都起不来。
const OVERLAY_ENTRIES = new Map([
  ["@lencx/minke-harness-overlay/fork", "fork.js"],
  ["@lencx/minke-harness-overlay/web-search", "web-search.js"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = OVERLAY_ENTRIES.get(specifier);
    if (entry !== undefined) {
      return {
        shortCircuit: true,
        url: pathToFileURL(
          join(projectRoot, "packages", "harness-overlay", "lib", entry),
        ).href,
      };
    }
    const fromHarness = context.parentURL?.startsWith(harnessUrl) ?? false;
    const isBare =
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:");
    if (specifier.startsWith("@deepseek-ai/") || (fromHarness && isBare)) {
      return nextResolve(specifier, {
        ...context,
        parentURL: harnessModulesAnchor,
      });
    }
    return nextResolve(specifier, context);
  },
});

// 留住真实的 host 层和 Agent Preset，只摘掉会绑端口、起 watcher 的那些行。
// `connection` 一开就连锁要 webServer + webRuntime，所以三个一起关；凡是
// 依赖 connection 的上游插件也得跟着关（下面 CONNECTION_DEPENDENTS）。
const CONNECTION_DEPENDENTS = ["session-log-download"];

function testOverlay(settingsPath, storageRoot) {
  return [
    { id: "settings", config: { path: settingsPath, watch: false } },
    { id: "storage-json", config: { root: storageRoot } },
    { id: "webserver", disabled: true },
    { id: "web-runtime", disabled: true },
    { id: "connection", disabled: true },
    ...CONNECTION_DEPENDENTS.map((id) => ({ id, disabled: true })),
    { id: "session-telemetry-otel", disabled: true },
    { id: "modules", disabled: true },
    { id: "client-hmr", disabled: true },
    { id: "directory-picker", disabled: true },
    { id: "model-runtime", disabled: true },
    { id: "minke-overlay", disabled: true },
    // Shipped presets 打包在 dsh-agent-presets 里，自动作为 system root 带上，
    // 不需要也不该在这里写 roots 路径。
    //
    // **这条 boot 验不到 preset 层**：preset 的行引用的 dsh-tool-* 包只装在
    // runtime/host 的闭包里，vendor/deepseek-harness 下解析不到，
    // compositionInventory() 会报 standard 有 23 行 broken。所以这个文件只断言
    // host 层。要看 preset 组合后的样子，用
    // `dsh web --patch <fork patch> --dump-config`（走 runtime/host）。
    { id: "agent-presets", config: { default: "standard" } },
  ];
}

test(
  "the fork's host plugins load on the pinned harness",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "minke-fork-boot-"));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;

    let ctx;
    try {
      const settingsPath = join(home, "settings.yaml");
      const profileDir = join(home, "profiles", "fork-boot");
      const rootConfig = join(profileDir, "cordis.yml");
      await mkdir(profileDir, { recursive: true });
      await writeFile(settingsPath, "{}\n");
      await writeFile(rootConfig, "[]\n");

      const [
        { boot, healProfilesModuleFallback, loadOverlayPatches },
        { provideCmdline },
      ] = await Promise.all([
        import("@deepseek-ai/dsh-app-boot"),
        import("@deepseek-ai/dsh-cmdline"),
      ]);
      await healProfilesModuleFallback({
        installAnchor: join(harnessRoot, "apps", "cli", "package.json"),
        home,
      });

      const patches = [
        ...loadOverlayPatches(
          "minke-fork-boot",
          join(harnessRoot, "packages", "bundle", "base", "cordis.patch.yml"),
        ),
        ...loadOverlayPatches(
          "minke-fork-boot",
          join(harnessRoot, "packages", "bundle", "web-app", "cordis.patch.yml"),
        ),
        // fork 自己的组合层，原样喂进去——minke-fork 那行会跟着一起加载。
        ...loadOverlayPatches(
          "minke-fork-boot",
          join(projectRoot, "packages", "harness-overlay", "cordis.patch.yml"),
        ),
        ...testOverlay(settingsPath, join(home, "storages")),
      ];

      try {
        ctx = await boot("minke-fork-boot", rootConfig, patches, (hostCtx) => {
          provideCmdline(hostCtx, { args: [], exit: () => {} });
        });
      } catch (error) {
        // 上游新增一个依赖 connection 的插件时会撞这里。这不是 fork 坏了，
        // 但报错本身看不出该做什么，所以把处方写进失败信息。
        const detail = String(error?.cause?.message ?? error?.message ?? error);
        assert.doesNotMatch(
          detail,
          /waiting for service[s]?: connection/u,
          `上游新增了依赖 connection 的插件，把它的 id 加进 CONNECTION_DEPENDENTS：\n${detail}`,
        );
        throw error;
      }

      // boot 成功本身就证明了 minke-fork 那行加载成功——任何一个 entry 没激活，
      // 上面的 boot() 都会整个抛错。这里再断言组合出来的工具真的到了 host 层：
      // 「插件已启用」不等于工具可见（见 FORK.md 第 3 节第 4 层）。
      assert.ok(
        ctx.tools.schemas().map(({ name }) => name).includes(
          "subagent_claude_code",
        ),
        "fork 组合的 dsh-tool-subagent 没有把 subagent_claude_code 注册到 host 层",
      );
    } finally {
      await ctx?.stop?.();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  },
);
