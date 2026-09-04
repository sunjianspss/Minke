// >>> minke-fork
/**
 * 皮肤选择的跨进程契约：主进程、preload、skin.js 三方共用这一份。
 *
 * 单独成文件是为了让 preload 不必 import 主进程模块——那边有 node:fs 和
 * BrowserWindow，被 vite 打进 preload 包就直接炸（主窗口是 sandbox: true）。
 * 上游同类常量放在 @minke/harness-overlay/*-contract.ts，这里照同一个思路，
 * 只是归 fork 自己所有。
 */

/** preload → 主进程：取上次存的选择。没存过或坏了返回 undefined。 */
export const MINKE_SKIN_READ_CHANNEL = "minke-fork:skin:read";

/** preload → 主进程：存下新的选择。白名单外的值直接丢弃。 */
export const MINKE_SKIN_WRITE_CHANNEL = "minke-fork:skin:write";

/**
 * 合法的选择，顺序和 resources/minke-skin/skin.js 的 CHOICES 一致
 * （前四个是视觉主题，auto 在它们之间按天轮换）。
 * tests/minke-skin.test.mjs 会拿 skin.js 跑出来的那份和这里逐项比对。
 */
export const MINKE_SKIN_CHOICES = [
  "photo",
  "aurora",
  "paper",
  "mono",
  "off",
  "auto",
] as const;

export type MinkeSkinChoice = (typeof MINKE_SKIN_CHOICES)[number];

/** 把任意输入收敛成合法选择，收不了就 undefined。两侧都用它把关。 */
export function parseMinkeSkinChoice(
  value: unknown,
): MinkeSkinChoice | undefined {
  return typeof value === "string" &&
      (MINKE_SKIN_CHOICES as readonly string[]).includes(value)
    ? value as MinkeSkinChoice
    : undefined;
}
// <<< minke-fork
