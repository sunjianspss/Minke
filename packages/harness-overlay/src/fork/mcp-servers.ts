/*
 * 从 $DSH_HOME/minke-mcp.json 读 MCP server 列表，每条 enabled 的记录挂一个
 * @deepseek-ai/dsh-mcp-client 实例。
 *
 * 为什么不直接写在 cordis.patch.yml 里：YAML 是静态的，一个 server 一个实例，
 * 加一个 server 就要改一次上游文件并重新构建。桌面端要的是用户自己编辑配置、
 * 重启即生效，所以列表放到 DSH_HOME 下的 JSON 里，由这个插件在运行时展开。
 *
 * 配置改动需要重启 Minke 才生效（暂不 watch）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { readFile } from "node:fs/promises";
import {
  forwardedStdioEnv,
  MCP_CONFIG_FILE,
  resolveMcpServers,
} from "./mcp-config";

export async function applyMcpServers(ctx: Context): Promise<void> {
  const configPath = dshHomePath(MCP_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    // 没有配置文件是正常状态：绝大多数用户不用 MCP。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.logger.warn(`minke-fork: 读取 ${MCP_CONFIG_FILE} 失败：${String(error)}`);
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    ctx.logger.warn(`minke-fork: ${MCP_CONFIG_FILE} 不是合法 JSON：${String(error)}`);
    return;
  }

  const { mounted, skipped } = resolveMcpServers(
    parsed,
    forwardedStdioEnv(process.env),
  );
  let live = 0;
  for (const resolution of mounted) {
    if (!resolution.ok) {
      ctx.logger.warn(
        `minke-fork: 跳过 MCP server ${resolution.name}（${resolution.reason}）`,
      );
      continue;
    }
    // schemastery 在 ctx.plugin 里补齐 args/env/reconnect 等默认值，
    // 所以这里只提供用户显式给出的字段。
    ctx.plugin(McpClient, resolution.config as unknown as McpClient.Config);
    live += 1;
  }
  if (live > 0 || skipped > 0) {
    ctx.logger.info(
      `minke-fork: 挂载 ${String(live)} 个 MCP server（禁用 ${String(skipped)} 个）`,
    );
  }
}
