// Fork 扩展层的守卫测试，独立成文件，理由同 tests/minke-skin.test.mjs：
// 上游同步时它不该跟任何上游测试冲突，而它一红就说明缝被上游改动冲掉了。
// 手动运行：node --test tests/minke-fork.test.mjs
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, projectRoot), "utf8");

const contract = JSON.parse(read("config/harness-runtime.json"));
const patch = read("packages/harness-overlay/cordis.patch.yml");
const overlayManifest = JSON.parse(
  read("packages/harness-overlay/package.json"),
);
const forkTsconfig = read("packages/harness-overlay/tsconfig.fork.json");
const hostTsconfig = read("packages/harness-overlay/tsconfig.host.json");
const productBuild = read("scripts/harness/build-product-packages.mjs");
const runtimePrune = read("scripts/harness/runtime-prune.mjs");

/** fork 在上游文件里追加的所有内容都必须待在这对围栏之间。 */
const FENCE = /# >>> minke-fork\n([\s\S]*)# <<< minke-fork/u;

const {
  forwardedStdioEnv,
  MCP_CONFIG_FILE,
  resolveMcpServer,
  resolveMcpServers,
} = await import(
  `data:text/javascript;base64,${Buffer.from(
    transformSync(read("packages/harness-overlay/src/fork/mcp-config.ts"), {
      loader: "ts",
      format: "esm",
    }).code,
  ).toString("base64")}`
);

test("the fork composition block stays fenced at the end of the patch", () => {
  const fenced = FENCE.exec(patch);
  assert.ok(fenced, "cordis.patch.yml 里的 fork 块必须带围栏注释");
  assert.match(
    patch.slice(patch.indexOf("# <<< minke-fork")),
    /^# <<< minke-fork\s*$/u,
    "fork 块必须是文件最后一段，上游在中间加行才不会冲突",
  );
  assert.doesNotMatch(
    patch.slice(0, patch.indexOf("# >>> minke-fork")),
    /minke-fork/u,
    "围栏之外不该出现 fork 的改动",
  );
});

test("the fork mounts exactly one host plugin entry", () => {
  const [, fenced] = FENCE.exec(patch);
  assert.match(
    fenced,
    /- id: minke-fork\n\s+name: '@lencx\/minke-harness-overlay\/fork'/u,
  );
  assert.equal(
    overlayManifest.exports["./fork"],
    "./lib/fork.js",
    "入口没导出的话 cordis 解析不到这个插件名",
  );
  assert.match(
    productBuild,
    /entryPoints: \[join\(overlayPackageRoot, "src", "fork", "index\.ts"\)\]/u,
  );
  assert.match(forkTsconfig, /"src\/fork"/u, "fork 源码必须进 typecheck");
  // src/fork 单开工程的代价是它不在 tsconfig.host.json 里——那个文件必须保持
  // 和上游逐字一致，否则这条围栏就白立了。
  assert.doesNotMatch(hostTsconfig, /fork/u);
  assert.match(
    JSON.parse(read("packages/harness-overlay/package.json")).scripts.typecheck,
    /-b tsconfig\.fork\.json/u,
    "工程不接进 typecheck 脚本就等于没有",
  );
  assert.equal(
    (patch.match(/@lencx\/minke-harness-overlay\/fork/gu) ?? []).length,
    1,
    "加 fork 功能只该改 src/fork/**，不该再往组合层加行",
  );
});

test("the fork composes Claude Code delegation inside its own fence", () => {
  const [, fenced] = FENCE.exec(patch);
  assert.match(
    fenced,
    /id: subagent-claude-code[\s\S]*name: '@deepseek-ai\/dsh-subagent-claude-code'/u,
  );
  assert.match(
    fenced,
    /id: tool-subagent-claude-code[\s\S]*provider: claude-code[\s\S]*toolName: subagent_claude_code[\s\S]*backgroundMode: one-shot/u,
  );
  // 上游 v0.2.0 把原来同构的 codex 那组从 patch 里删了，改成用户自己
  // `dsh plugin --profile web add`。fork 这组是围栏内唯一一组内置 subagent，
  // 所以整个 patch 里 claude-code 的组合行只能来自围栏内。
  assert.doesNotMatch(patch, /id: subagent-codex/u);
  assert.doesNotMatch(
    patch.slice(0, patch.indexOf("# >>> minke-fork")),
    /claude-code/u,
  );
});

test("every fork runtime package is installed and composed", () => {
  const forkPackages = [
    "@deepseek-ai/dsh-mcp-client",
    "@deepseek-ai/dsh-subagent-claude-code",
  ];
  for (const name of forkPackages) {
    assert.ok(
      contract.productBundle.runtimePackages.includes(name),
      `${name} 不在 runtimePackages 里就不会进 runtime closure`,
    );
    // contract.mjs 要求 runtimePackages 的每个包都在 patch 里被显式组合。
    assert.ok(
      patch.includes(`name: '${name}'`),
      `${name} 必须在 cordis.patch.yml 里出现，否则 harness:verify 会失败`,
    );
  }
  // 上游 v0.2.0 起 runtimePackages 自己是空的（codex 移出去当插件装了），
  // 所以这份清单整个归 fork 所有：多出来的项一定是上游又加回了什么。
  assert.deepEqual(
    [...contract.productBundle.runtimePackages].sort(),
    [...forkPackages].sort(),
  );
});

test("the disabled mcp-client row exists only to keep the package composed", () => {
  const [, fenced] = FENCE.exec(patch);
  assert.match(
    fenced,
    /id: mcp-client-template\n\s+name: '@deepseek-ai\/dsh-mcp-client'\n\s+disabled: true/u,
    "模板行必须保持 disabled：真正的实例由 minke-fork 在运行时按配置挂载",
  );
});

test("the bundled Claude Code CLI binary is pruned from the runtime", async () => {
  // subagent-claude-code 拖进来的 @anthropic-ai/claude-agent-sdk-<platform> 单包
  // 245 MiB，直接撞爆 darwin 的体积预算。provider 永远从 PATH 解析用户装的
  // claude，这份随包二进制从不被执行，所以裁掉。上游改动把这条规则冲掉时，
  // 症状是打包炸在体积预算上——这里先红，省得到那时才发现。
  // runtime-prune.mjs 是 JS，围栏用 // 而不是 #。
  assert.match(runtimePrune, /\/\/ >>> minke-fork[\s\S]*\/\/ <<< minke-fork/u);

  const { runtimeArtifactCategory } = await import(
    new URL("scripts/harness/runtime-prune.mjs", projectRoot)
  );
  for (const path of [
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/cli.js",
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/bin/claude",
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/x",
    "node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/x",
  ]) {
    assert.equal(runtimeArtifactCategory(path), "duplicateTooling", path);
  }
  for (const kept of [
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "node_modules/@anthropic-ai/sdk/index.js",
  ]) {
    assert.equal(
      runtimeArtifactCategory(kept),
      undefined,
      `${kept} 是 SDK 本体，裁掉就没法 import 了`,
    );
  }

  // 预算必须留在上游原值：裁剪的意义就是不用抬预算。
  assert.equal(
    contract.runtimeSizeBudgetBytes.darwin,
    157286400,
    "抬预算是诊断手段，不该被提交",
  );
});

test("the harness packages the fork depends on still exist upstream", () => {
  // submodule 一 bump，包被改名或移走，这里立刻红，而不是等打包时才炸。
  for (const path of [
    "vendor/deepseek-harness/packages/mcp/mcp-client/package.json",
    "vendor/deepseek-harness/packages/subagent/subagent-claude-code/package.json",
    "vendor/deepseek-harness/packages/util/home-paths/package.json",
  ]) {
    assert.ok(existsSync(new URL(path, projectRoot)), `${path} 不见了`);
  }
});

test("MCP entries translate into mcp-client configs", () => {
  assert.equal(MCP_CONFIG_FILE, "minke-mcp.json");

  const stdio = resolveMcpServer(
    { name: "files", command: "npx", args: ["-y", "server"], env: { A: "1" } },
    new Set(),
  );
  assert.deepEqual(stdio, {
    ok: true,
    name: "files",
    config: {
      serverName: "files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { A: "1" },
    },
  });

  const http = resolveMcpServer(
    { name: "web", transport: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
    new Set(),
  );
  assert.deepEqual(http, {
    ok: true,
    name: "web",
    config: {
      serverName: "web",
      transport: "streamable-http",
      url: "http://127.0.0.1:3000/mcp",
    },
  });
});

test("stdio servers inherit the runtime env their node shim needs", () => {
  // runtime/host/bin/node 是个 shim，缺 DSH_ELECTRON_EXECUTABLE 就直接退出；
  // harness 给子进程的是清洗过的环境，不带这个变量。不补的话任何走 node/npx
  // 的 MCP server 都起不来（实测：无限重连，PATH 上的 shim 每次都死）。
  const inherited = forwardedStdioEnv({
    DSH_ELECTRON_EXECUTABLE: "/path/to/Electron",
    SECRET_TOKEN: "nope",
  });
  assert.deepEqual(inherited, {
    DSH_ELECTRON_EXECUTABLE: "/path/to/Electron",
  });
  assert.deepEqual(forwardedStdioEnv({}), {}, "变量缺失时不该塞空值");

  const stdio = resolveMcpServer({ name: "a", command: "npx" }, new Set(), inherited);
  assert.deepEqual(stdio.config.env, {
    DSH_ELECTRON_EXECUTABLE: "/path/to/Electron",
  });

  // 用户显式写的 env 优先，补进来的只是兜底。
  const overridden = resolveMcpServer(
    { name: "b", command: "npx", env: { DSH_ELECTRON_EXECUTABLE: "/mine" } },
    new Set(),
    inherited,
  );
  assert.deepEqual(overridden.config.env, { DSH_ELECTRON_EXECUTABLE: "/mine" });

  // http transport 没有子进程，不该被塞 env。
  const http = resolveMcpServer(
    { name: "c", transport: "streamable-http", url: "http://x/mcp" },
    new Set(),
    inherited,
  );
  assert.equal(http.config.env, undefined);
});

test("bad MCP entries are rejected with a reason instead of crashing boot", () => {
  const reject = (entry, seen = new Set()) => resolveMcpServer(entry, seen);
  assert.equal(reject("nope").ok, false);
  assert.equal(reject({ name: "has space", command: "x" }).ok, false);
  assert.equal(reject({ name: "a".repeat(33), command: "x" }).ok, false);
  assert.equal(reject({ name: "files" }).ok, false, "stdio 少了 command");
  assert.equal(
    reject({ name: "web", transport: "streamable-http" }).ok,
    false,
    "http 少了 url",
  );
  assert.equal(
    reject({ name: "files", command: "x" }, new Set(["files"])).ok,
    false,
    "重名会让 mcp-client 的后一个实例整个挂掉，必须提前挡住",
  );
});

test("the server list skips disabled entries and keeps order", () => {
  const { mounted, skipped } = resolveMcpServers({
    servers: [
      { name: "one", command: "a" },
      { name: "two", command: "b", enabled: false },
      { name: "three", command: "c" },
      { name: "one", command: "d" },
    ],
  });
  assert.equal(skipped, 1);
  assert.deepEqual(
    mounted.map((entry) => [entry.name, entry.ok]),
    [
      ["one", true],
      ["three", true],
      ["one", false],
    ],
  );
  assert.deepEqual(resolveMcpServers({}), { mounted: [], skipped: 0 });
  assert.deepEqual(resolveMcpServers(null), { mounted: [], skipped: 0 });
});
