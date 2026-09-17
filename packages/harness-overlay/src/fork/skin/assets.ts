/*
 * 皮肤的静态素材：样式、页面脚本、背景图。
 *
 * 素材放在 overlay 包的 `assets/minke-skin/` 下，跟着 package.json 的
 * `files: ["lib", "assets", …]` 一起进 `runtime/host`，所以 host 插件在运行时
 * 读得到。以前它们由 preload 在**构建期**内联进 bundle，那条路随 preload
 * 一起退役了。
 *
 * 背景图在这里读成 data: URI 再发给页面。不走 HTTP 路由是有意的：皮肤要在
 * 首帧就是最终样式，多一次网络往返就会闪一下白底。
 */
import { readFile } from "node:fs/promises";

/** 从 `lib/fork.js` 回到包根的 `assets/minke-skin/`。 */
const assetUrl = (name: string) =>
  new URL(`../assets/minke-skin/${name}`, import.meta.url);

/**
 * 三张背景图和它们对应的 CSS 变量。
 *
 * aurora / mono 是私人配图，在 .gitignore 里，clone 下来根本不存在——
 * 读不到就跳过，那两档退化成纯底色，而不是让整个插件起不来。
 */
const BACKGROUNDS = Object.freeze({
  "--minke-background-image": "minke-background.jpeg",
  "--minke-background-image-aurora": "minke-background-aurora.jpeg",
  "--minke-background-image-mono": "minke-background-mono.jpeg",
});

/** 页面需要的全部素材，读一次即可——进程生命周期内不会变。 */
export interface SkinAssets {
  readonly css: string;
  readonly script: string;
  readonly backgrounds: Readonly<Record<string, string>>;
}

async function readBackground(file: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(assetUrl(file));
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** 读齐皮肤素材。样式和脚本缺一不可，缺了就该响亮地失败。 */
export async function loadSkinAssets(): Promise<SkinAssets> {
  const [css, script] = await Promise.all([
    readFile(assetUrl("skin.css"), "utf8"),
    readFile(assetUrl("skin.js"), "utf8"),
  ]);

  const backgrounds: Record<string, string> = {};
  await Promise.all(
    Object.entries(BACKGROUNDS).map(async ([variable, file]) => {
      const uri = await readBackground(file);
      if (uri !== undefined) backgrounds[variable] = uri;
    }),
  );

  return { css, script, backgrounds };
}
