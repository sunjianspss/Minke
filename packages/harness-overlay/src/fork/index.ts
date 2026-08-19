/*
 * Fork 唯一的 host 插件入口。
 *
 * 上游组合层（cordis.patch.yml）只 insert 这一个名字，之后所有 fork 功能
 * 都在这个目录里用 ctx.plugin() 自己挂。加功能 = 新增文件 + 这里一行，
 * 上游文件永远零 diff。约定见仓库根的 FORK.md。
 */
import type { Context } from "@deepseek-ai/cordis";
import { applyMcpServers } from "./mcp-servers";

export const name = "minke-fork";
export const inject = ["tools"];

export async function apply(ctx: Context): Promise<void> {
  await applyMcpServers(ctx);
}
