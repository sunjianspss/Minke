// >>> minke-fork
/**
 * 皮肤选择的持久化（主进程侧）。
 *
 * **为什么不能存在页面里。** 主窗口跑在
 * `session.fromPartition("minke-main-window")` 上——没有 `persist:` 前缀，
 * 是内存态 session，上游 63861c2 正是靠这一点推迟 Keychain 初始化的
 * （main-window.ts 的注释原话：the in-memory desktop surface never
 * initializes Chromium's Keychain）。内存态 session 的 localStorage 关掉 app
 * 就没了；退一万步，harness 每次都用随机端口起 HTTP 服务，页面 origin
 * 跟着变，localStorage 按 origin 分区，照样读不回来。两条各自都足以让
 * 页面侧的存储活不过一次重启。
 *
 * 所以选择存在 `<userData>/desktop/minke-skin.json`：preload 注入 skin.js
 * 之前先取一次，切换时再写回来。
 *
 * **为什么不并进上游的 MinkeConfigStore。** 那要在 minke-config.ts 和
 * minke-config/document.ts 的**中间**各插一段（section、parse、read、write），
 * 正是 FORK.md 第 2 节要避开的改法。自己一个小文件、自己一个 JSON，
 * 上游怎么动 minke.config.json 都碰不到这里。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  MINKE_SKIN_READ_CHANNEL,
  MINKE_SKIN_WRITE_CHANNEL,
  parseMinkeSkinChoice,
  type MinkeSkinChoice,
} from "../minke-skin-channels.ts";

/** 路径要等 configureAppDataPaths() 钉好 userData 才算数，所以每次现算。 */
function storePath(): string {
  return join(app.getPath("userData"), "desktop", "minke-skin.json");
}

/**
 * 只认主窗口顶层框架发来的请求。
 *
 * 上游 MainWindowRuntime#authorize 还会核对 senderFrame 的 URL 是不是
 * harness，那要拿到窗口实例；这个文件刻意不依赖 application.ts，所以退一步：
 * 必须是某个 BrowserWindow 自己的 webContents，且必须是顶层框架
 * （iframe / webview 一律拒）。写进来的值再过一遍白名单——越权最多也只能
 * 换一档壁纸。
 */
function isTopLevelWindowFrame(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  return (
    window !== null &&
    window.webContents === event.sender &&
    event.senderFrame !== null &&
    event.senderFrame.parent === null
  );
}

/** 文件不在、内容坏了、读不动，一律当没选过——皮肤不该因此整个失效。 */
async function readStoredChoice(): Promise<MinkeSkinChoice | undefined> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(storePath(), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof document !== "object" || document === null) return undefined;
  return parseMinkeSkinChoice((document as { choice?: unknown }).choice);
}

/** 先写临时文件再 rename：崩在中间也不会留下半个 JSON。 */
async function writeStoredChoice(choice: MinkeSkinChoice): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ choice }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** 装上读写通道。main.ts 在正常启动那条分支里调一次。 */
export function installMinkeSkinStore(): void {
  ipcMain.handle(
    MINKE_SKIN_READ_CHANNEL,
    async (event: IpcMainInvokeEvent) =>
      isTopLevelWindowFrame(event) ? await readStoredChoice() : undefined,
  );
  ipcMain.handle(
    MINKE_SKIN_WRITE_CHANNEL,
    async (event: IpcMainInvokeEvent, value: unknown) => {
      if (!isTopLevelWindowFrame(event)) return;
      const choice = parseMinkeSkinChoice(value);
      if (choice === undefined) return;
      await writeStoredChoice(choice);
    },
  );
}
// <<< minke-fork
