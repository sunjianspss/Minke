/*
 * 皮肤的运行时验证：编排 + 断言。`pnpm test:skin:surface`
 *
 * 为什么要有这条：皮肤的其余测试全是静态断言，它们能验"fork 自己写了什么"，
 * 验不了"写的东西还匹配得上上游"。两次真实回归都从静态断言底下溜过去了：
 *
 *   v0.2.0  上游给每列加了自带不透明底的面板，皮肤被整个盖住——
 *           计算样式全对，渲染出来一片白。
 *   v0.6.1  上游把 conversation/details 两个 slot 改了名，打透明的规则
 *           匹配 0 个元素。皮肤看着仍然正常，护栏却已经没了。
 *
 * 两者都只有真跑起来收帧才看得见。以前这一步靠人工逐帧看图，于是 v0.6.1
 * 漏了整整一轮同步。这条命令把那件事变成红绿。
 *
 * 流程：起一个隔离 harness（自己的 DSH_HOME，不碰 ~/.minke）→ 用
 * tests/minke-skin-surface-runtime.cjs 那个小宿主逐档收帧和量样式 → 在这里断言。
 */
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  signalCommandProcessTree,
  spawnCommand,
} from "../harness/command-invocation.mjs";

const projectRoot = new URL("../../", import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, projectRoot));

const RUNTIME_HOST = path("runtime/host");
const ELECTRON = path(
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const PRELOAD = path(".vite/build/desktop-preload.js");
const HOST_ENTRY = path("tests/minke-skin-surface-runtime.cjs");

/**
 * 图片档和它们的文件名。
 *
 * 只有 photo 那张随包分发；aurora / mono 是私人配图，住在 `$DSH_HOME/skins/`，
 * 干净 clone 和 CI 上根本没有。所以"哪几档该有图"是**跑的时候算出来的**，不能
 * 写死——写死的话，CI 上这条命令必红，而那只是因为图不在那台机器上。
 */
const IMAGE_FILES = {
  photo: "minke-background.jpeg",
  aurora: "minke-background-aurora.jpeg",
  mono: "minke-background-mono.jpeg",
};
/** 纯渐变档：没有图片，但 body 上必须有底色。 */
const FLAT_SKINS = ["paper"];
const ALL_SKINS = [...Object.keys(IMAGE_FILES), ...FLAT_SKINS, "off"];

/** 真实的 DSH_HOME，取上游 `explicit > DSH_HOME > ~/.dsh` 那套契约的后两档。 */
function realDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv !== undefined && fromEnv.length > 0
    ? fromEnv
    : join(homedir(), ".minke", "harness");
}

/**
 * 找齐这台机器上实际存在的背景图，并把私人配图播进隔离 home。
 *
 * 隔离 home 是每次现建的空目录，不播的话 aurora / mono 一定没图——那是测试
 * 环境的事实，不是回归。
 */
async function seedBackgrounds(home) {
  const skinsDir = join(home, "skins");
  await mkdir(skinsDir, { recursive: true });
  const available = [];
  for (const [skin, file] of Object.entries(IMAGE_FILES)) {
    // 随包分发的那张**故意不播**：让它走包内兜底那条分支，于是这一趟同时验到
    // 取图链的两头——photo 从包里来，私人档从 $DSH_HOME/skins/ 来。
    try {
      await readFile(path(`packages/harness-overlay/assets/minke-skin/${file}`));
      available.push(skin);
      continue;
    } catch {
      // 不随包分发，那就该在用户目录里。
    }
    try {
      await copyFile(join(realDshHome(), "skins", file), join(skinsDir, file));
      available.push(skin);
    } catch {
      // 这台机器上没有这张图，那一档就是纯底色，不算回归。
    }
  }
  return available;
}

/** 这条命令要跑一两分钟，全程无输出的话分不清"在跑"和"卡住"。 */
const progress = (message) => console.log(`· ${message}`);

/**
 * 从皮肤自己的 CSS 里取出打透明用到的 data-slot。
 *
 * 真相只能来自这里。探针那一侧一旦写死名字，验的就永远是"对的那几个"，
 * 皮肤实际锚了什么完全不影响结果——第一版正是如此，把锚点改回上游已经废弃的
 * `conversation`，整条命令照样全绿。
 *
 * 只取真正生效的规则：注释里也提到过 slot 名字，那些不该参与。
 */
async function skinAnchors() {
  const css = (await readFile(path("packages/harness-overlay/assets/minke-skin/skin.css"), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const rule = /html:not\(\[data-minke-skin="off"\]\)[^{]*\{[^}]*\}/u.exec(css);
  if (rule === null) throw new Error("skin.css 里找不到打透明的规则");
  const anchors = [
    ...new Set([...rule[0].matchAll(/\[data-slot="([^"]+)"\]/gu)].map((m) => m[1])),
  ];
  if (anchors.length === 0) throw new Error("打透明的规则里一个 data-slot 都没有");
  return anchors;
}

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** 起隔离 harness，返回它打印的那个带 token 的 URL。 */
async function startHarness(home) {
  const child = spawnCommand(ELECTRON, [
    "--expose-internals",
    join(RUNTIME_HOST, "index.mjs"),
    "web",
    "--patch",
    join(
      RUNTIME_HOST,
      "node_modules/@lencx/minke-harness-overlay/cordis.patch.yml",
    ),
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ], {
    env: {
      ...process.env,
      // MINKE_ 前缀是现在的名字；DSH_* 那套 harness 会主动从子进程环境里删掉。
      ELECTRON_RUN_AS_NODE: "1",
      DSH_HOME: home,
      MINKE_NODE_EXECUTABLE: ELECTRON,
      MINKE_PNPM_ENTRY: join(RUNTIME_HOST, "node_modules/pnpm/bin/pnpm.cjs"),
      PATH: `${join(RUNTIME_HOST, "bin")}:${process.env.PATH ?? ""}`,
    },
    // 必须自成进程组：收尾用的 signalCommandProcessTree 发的是 kill(-pid)，
    // 不 detached 的话那个进程组不存在，信号被当成 ESRCH 吞掉，harness 活到天荒地老
    // ——断言全跑完、结果也算出来了，命令却永远不退出。smoke.mjs 同样这么配。
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`隔离 harness 90 秒内没起来：\n${output}`)),
      90_000,
    );
    const scan = (chunk) => {
      output += chunk;
      const match = /dsh web: (http:\/\/\S+)/u.exec(output);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.setEncoding("utf8").on("data", scan);
    child.stderr.setEncoding("utf8").on("data", scan);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`隔离 harness 退出了（code ${code}）：\n${output}`));
    });
  });
  return { child, url };
}

/**
 * 收掉 harness，并**等它真的死透**。
 *
 * 只发一个 SIGTERM 就返回是不够的：子进程的 stdout/stderr 还挂在管道上，
 * 事件循环就一直空不下来——所有断言都跑完了、结果也打印了，命令却不退出。
 * 这一步不确认退出，整条命令在 CI 里就是一个永远不结束的任务。
 */
async function stopHarness(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalCommandProcessTree(child, "SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000));
  if (await Promise.race([exited, timeout]) === "timeout") {
    signalCommandProcessTree(child, "SIGKILL");
    await exited;
  }
}

/** 跑小宿主，拿回它写的观测报告。 */
async function collectReport(url, reportPath, anchors) {
  const child = spawnCommand(ELECTRON, [HOST_ENTRY], {
    env: {
      ...process.env,
      MINKE_SKIN_URL: url,
      MINKE_SKIN_PRELOAD: PRELOAD,
      MINKE_SKIN_REPORT: reportPath,
      MINKE_SKIN_ANCHORS: JSON.stringify(anchors),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 宿主没注册上游那一堆 minke:* handler，控制台会刷 "No handler registered"。
  // 那是宿主简陋，不是皮肤坏了，所以这里只在真的失败时才把输出打出来。
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));

  const code = await new Promise((resolve) => child.once("exit", resolve));
  try {
    return JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error(`皮肤宿主没写出报告（exit ${code}）：\n${output}`);
  }
}

function assertReport(report, imageSkins) {
  const skins = report.skins ?? {};

  for (const choice of ALL_SKINS) {
    const observed = skins[choice];
    if (observed === undefined) {
      check(false, `${choice} 这一档根本没收到帧`);
      continue;
    }

    // 写回路由：204 以外都说明那条 HTTP 缝断了（401/403 是鉴权，503 是
    // settings 没组合进来，404 是路由没注册上）。不单独报的话，表现只是
    // "所有档位都停在 photo"，查起来完全没有方向。
    check(
      report.writeStatus?.[choice] === 204,
      `${choice}：POST /api/minke-skin 回了 ${report.writeStatus?.[choice]}，不是 204`,
    );
    // host 插件经 index-inject 写进来的初值。它不对说明注入缝断了。
    check(
      observed.injectedChoice === choice,
      `${choice}：host 注入的初值是 ${observed.injectedChoice}`,
    );

    check(
      observed.skin === choice,
      `${choice}：页面上的档位是 ${observed.skin}——`
      + "主进程那条 read 通道没接上的话，所有档会一起回落成默认值",
    );

    if (imageSkins.includes(choice)) {
      check(
        observed.hasDataUri,
        `${choice}：body 背景里没有内联的 data: URI，图片没进页面`,
      );
    }
    if (FLAT_SKINS.includes(choice)) {
      check(
        observed.backgroundImage !== "none",
        `${choice}：body 上没有渐变，这一档等于没生效`,
      );
    }

    // 皮肤画在 body 上，上面任何一层铺满视口的不透明元素都会把它整个盖掉，
    // 而计算样式看起来完全正常。这正是 v0.2.0 那次的形态。
    if (choice !== "off") {
      check(
        observed.opaqueCovers.length === 1
        && observed.opaqueCovers[0].startsWith("BODY"),
        `${choice}：body 之上还有不透明元素盖着皮肤 → `
        + `${JSON.stringify(observed.opaqueCovers)}`,
      );
    }
  }

  // off 档要把界面完整还给上游，而不是留一层 fork 的底色。
  const off = skins.off;
  if (off !== undefined) {
    check(
      off.backgroundImage === "none" && off.backgroundColor === "rgba(0, 0, 0, 0)",
      `off：body 背景没让位给上游 → ${off.backgroundColor} / ${off.backgroundImage}`,
    );
  }

  /*
   * 皮肤锚的每个 slot 都必须真的在页面上。锚到一个不存在的 slot，和锚对了，
   * 在计算样式上完全没有区别——v0.6.1 那次就是这么静默失效的。
   *
   * 判据是"锚元素在不在"，不是"有没有子元素"：右列默认折叠，元素在但没有
   * 子元素，那是正常状态；被改了名的 slot 则是整个查不到。
   */
  const anchors = skins.photo?.punchThrough ?? {};
  for (const [key, observed] of Object.entries(anchors)) {
    check(
      observed.present,
      `皮肤锚的 [data-slot="${key}"] 在页面上根本不存在——`
      + "上游多半把这个 slot 改名了，去 slot-catalog.ts 找新名字",
    );
    // 锚对了还不够：这一列的面板得真的被打透明，否则皮肤仍然会被盖住。
    for (const background of observed.children) {
      check(
        background === "rgba(0, 0, 0, 0)",
        `[data-slot="${key}"] 下的面板没被打透明：${background}`,
      );
    }
  }

  /*
   * 五档的帧必须两两不同。这一条同时抓两种毛病：皮肤整个没生效（五张一样），
   * 以及收帧偏移一位（capturePage 返回了上一次样式变更之前的那张，
   * 于是整批图集体错位，而报告里的数据全部正确）。
   */
  const byBytes = new Map();
  for (const choice of ALL_SKINS) {
    const bytes = skins[choice]?.frameBytes;
    if (bytes === undefined) continue;
    byBytes.set(bytes, [...(byBytes.get(bytes) ?? []), choice]);
  }
  for (const [bytes, choices] of byBytes) {
    check(
      choices.length === 1,
      `这几档渲染出了字节数完全相同的帧（${bytes}）：${choices.join(" / ")}`,
    );
  }

  // 快捷键：页面上的档位推进了，而且那次推进要真的落到 host 上——重载一次，
  // 注入回来的初值必须已经是新档位。这一条整体走完 POST → 设置文档 →
  // 下次 index-inject 的链路，是"选择活得过重启"的直接证据。
  const shortcut = report.shortcut ?? {};
  check(
    shortcut.before === "photo" && shortcut.after === "aurora",
    `快捷键没把档位从 photo 推到 aurora：${shortcut.before} → ${shortcut.after}`,
  );
  check(
    shortcut.persisted === "aurora",
    `快捷键那次切换没落到 host 上：重载后注入回来的初值是 ${shortcut.persisted}`,
  );
}

async function main() {
  if (process.platform !== "darwin") {
    // 皮肤和 early.css 一样只在 macOS 生效，别在其他平台上报假失败。
    console.log("皮肤只在 macOS 生效，跳过。");
    return;
  }
  for (const [label, target] of [
    ["runtime/host（先跑 pnpm harness:stage）", join(RUNTIME_HOST, "index.mjs")],
    ["preload 构建产物（先跑 pnpm build:preload）", PRELOAD],
    [
      "staged 的皮肤素材（先跑 pnpm build:product-packages && pnpm harness:stage）",
      join(
        RUNTIME_HOST,
        "node_modules/@lencx/minke-harness-overlay/assets/minke-skin/skin.css",
      ),
    ],
  ]) {
    try {
      await readFile(target);
    } catch {
      throw new Error(`缺少 ${label}：${target}`);
    }
  }

  const workspace = await mkdtemp(join(tmpdir(), "minke-skin-surface-"));
  let harness;
  try {
    // 隔离的 DSH_HOME：真 app 那份 ~/.minke 里有用户的会话和配置，不碰。
    progress("起隔离 harness…");
    const available = await seedBackgrounds(join(workspace, "home"));
    progress(`这台机器上有图的档：${available.join(" / ") || "（一张都没有）"}`);
    harness = await startHarness(join(workspace, "home"));
    progress(`harness 已就绪：${harness.url.replace(/token=[^&]*/u, "token=…")}`);
    const anchors = await skinAnchors();
    progress(`逐档收帧（${ALL_SKINS.join(" / ")}），皮肤锚点：${anchors.join(" / ")}`);
    const report = await collectReport(
      harness.url,
      join(workspace, "report.json"),
      anchors,
    );
    progress("收帧完成，开始断言");
    assertReport(report, available);
  } finally {
    if (harness !== undefined) await stopHarness(harness.child);
    await rm(workspace, { force: true, recursive: true });
  }

  if (failures.length > 0) {
    console.error(`皮肤运行时验证失败（${failures.length} 条）：`);
    for (const failure of failures) console.error(`  ✖ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`皮肤运行时验证通过：${ALL_SKINS.length} 档逐帧确认，快捷键写回正常。`);
}

await main();
