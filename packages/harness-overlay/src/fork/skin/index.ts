/*
 * 皮肤的 host 插件。
 *
 * 以前皮肤走 Electron preload：`webFrame.insertCSS` 注样式、
 * `webFrame.executeJavaScript` 注脚本、自建一对 IPC 通道落盘选择。那条路要在
 * 上游的 `desktop-preload.ts` 和 `main.ts` 里各占两行，而且 v0.4.0 上游把主窗口
 * 搬进内存态 session 时，整条注入路径被连根拔掉过一次。
 *
 * 现在改走上游自己声明的两条缝，fork 对 `desktop/**` 零改动：
 *
 *   - `webserver/index-inject`：往 index.html 里推结构化的注入行。
 *     这是上游发布在 API 目录里的公开事件，`ui-theme` / `connection` /
 *     `modules` / `experimental/inspector` 都在用；2026-08-19 引入后一行没改过。
 *   - `settings.register`：选择存进 Host 的用户设置文档，和 `ui-theme` 存
 *     light/dark 是同一套机制、同一份文件。
 *
 * 写回走 `ctx.connection.fetch.register`——上游给 host 插件准备的 `/api` 精确路由
 * 注册器（`file-upload`、`session-log-export`、`session-controller` 都在用）。
 * 信任与鉴权由载体统一施加，请求体直接以标准 `Request` 交到手上。
 *
 * 别退回去用 `ctx.webServer.register` 自己拼一条裸路由：那样既要自己调
 * `connection.requestRejection`，又要自己读请求流——实测 handler 能进到，
 * 但 `for await (const chunk of req)` 永远不结束，请求就挂在那里。
 */
import type { Context } from "@deepseek-ai/cordis";
// 只为把这两个包对 Context 的扩充带进来：`ctx.webServer` /
// `webserver/index-inject` 事件、`ctx.settings`。ui-theme 也是这么写的。
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

import { loadSkinAssets } from "./assets";

/** 设置命名空间。必须是小写连字符标识符，否则 register 直接 throw。 */
export const SKIN_SETTINGS_NAMESPACE = "minke-skin";
/**
 * 页面写回选择的路由。
 *
 * **要写完整路径，连 `/api` 一起。** 契约上那句「Absolute path below `/api`」
 * 容易读成只填下半截，但注册表用 `route.path` 原样做键，而查表用的是请求的完整
 * pathname——只填 `/minke-skin` 的话注册得下去、查不出来，表现是稳定的 404。
 * 上游自己的路由也都是全路径（`/api/session/uploadFileBinary`）。
 */
export const SKIN_WRITE_ROUTE = "/api/minke-skin";
/** 可选档位。`auto` 按日期在四个视觉档之间轮换，解析在页面侧做。 */
export const SKIN_CHOICES = [
  "photo",
  "aurora",
  "paper",
  "mono",
  "off",
  "auto",
] as const;
export const DEFAULT_SKIN_CHOICE = "photo";

export type SkinChoice = (typeof SKIN_CHOICES)[number];
export interface SkinSettings {
  /** 当前选择；未知值由 schema 挡在外面，落不到盘上。 */
  choice: SkinChoice;
}

export const SkinSettingsSchema: z<SkinSettings> = z.object({
  choice: z.union([...SKIN_CHOICES]).default(DEFAULT_SKIN_CHOICE),
});

/*
 * connection 那一侧只用到这个注册器。完整类型归浏览器侧的 connection 包所有，
 * 而那个包不是 composite 工程，引用不进本工程——`open-in-app` 碰到的是同一件事，
 * 也是本地声明一小块自己用（它注释里写着「typed locally: its package is
 * browser-side」）。上游改了这个注册器的签名，下面的 register 调用会在编译期红。
 */
interface SkinFetchRoute {
  readonly path: string;
  readonly methods: readonly "POST"[];
  readonly requestBody: "buffered";
  readonly fetch: (request: Request) => Promise<Response>;
}

interface SkinConnection {
  readonly fetch: { register(route: SkinFetchRoute): () => Promise<void> };
}

function connectionOf(ctx: Context): SkinConnection {
  return Reflect.get(ctx, "connection") as SkinConnection;
}

/** 落盘前的最后一道闸：未知档位不进设置文档。 */
function isSkinChoice(value: unknown): value is SkinChoice {
  return SKIN_CHOICES.some((choice) => choice === value);
}

/**
 * 装上皮肤。
 * @param ctx - fork 插件的 host 上下文。
 */
export async function applySkin(ctx: Context): Promise<void> {
  // 素材在进程生命周期内不会变，读一次。读不到样式或脚本要响亮地失败——
  // 静默降级的话，页面看起来就只是"皮肤没生效"，查起来毫无线索。
  const assets = await loadSkinAssets();

  // register 返回的 scope 是唯一能写的把手；settings 服务没组合进来时它就是
  // undefined，写回路由据此回 503，而不是假装写成功了。
  let scope:
    { get(): SkinSettings; update(patch: object): Promise<void> } | undefined;

  ctx.inject(["settings"], (settingsCtx) => {
    scope = settingsCtx.settings.register(
      SKIN_SETTINGS_NAMESPACE,
      SkinSettingsSchema,
    );
  });

  /*
   * 每次渲染 index 都现读一次，取和 ui-theme 一样的姿势：注入表是按需收集的，
   * 订阅者在 emit 时读活状态，所以切换完刷新一下就是新档位。
   */
  const currentChoice = (): SkinChoice =>
    scope?.get().choice ?? DEFAULT_SKIN_CHOICE;

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.on("webserver/index-inject", (table) => {
      // 顺序有讲究：global 行先落，后面的 script 行才读得到。皮肤的初值必须在
      // 脚本执行前就位，否则第一帧是默认档、之后再跳一下，肉眼可见地闪。
      table.push({
        kind: "global",
        name: "__minkeSkinChoice",
        value: currentChoice(),
      });
      table.push({
        kind: "global",
        name: "__minkeSkinBackgrounds",
        value: assets.backgrounds,
      });
      table.push({ kind: "style", text: assets.css });
      table.push({ kind: "script", placement: "body", text: assets.script });
    });
  });

  /*
   * 写回单独 inject，**不和绘制挤在一个 inject 里**。
   * 两件事绑在一起时，connection 没组合进来会让整块回调都不执行——表现是
   * 皮肤整个消失（注入行一条都没推），而不是"切换存不下来"。踩过一次。
   */
  ctx.inject(["connection"], (connCtx) => {
    connCtx.effect(
      () =>
        connectionOf(connCtx).fetch.register({
          path: SKIN_WRITE_ROUTE,
          methods: ["POST"],
          // 请求体就是 `{"choice":"photo"}`，走 buffered 让载体套用它配置好的
          // JSON 上限，fork 这边不必自己防大包。
          requestBody: "buffered",
          fetch: async (request) => {
            if (scope === undefined) {
              return new Response("settings service is not composed", {
                status: 503,
              });
            }
            // 400 一律带原因：这条路由断了的表现是"所有档位都停在 photo"，
            // 光一个状态码完全指不出方向。
            let choice: unknown;
            try {
              choice = ((await request.json()) as { choice?: unknown }).choice;
            } catch (error) {
              return new Response(`malformed body: ${String(error)}`, {
                status: 400,
              });
            }
            if (!isSkinChoice(choice)) {
              return new Response(`unknown choice: ${JSON.stringify(choice)}`, {
                status: 400,
              });
            }
            await scope.update({ choice });
            return new Response(null, { status: 204 });
          },
        }),
      `minke-fork skin: POST ${SKIN_WRITE_ROUTE}`,
    );
  });
}
