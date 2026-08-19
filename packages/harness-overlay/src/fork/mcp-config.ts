/*
 * MCP 配置的纯解析逻辑：没有任何 runtime import，只有 import type。
 * 单独成文件是为了让 tests/minke-fork.test.mjs 能直接转译并跑断言，
 * 不必先构建 lib，也不必在测试里假装一个 cordis Context。
 */
/** 配置文件名，落在 DSH_HOME（Minke 里是 ~/.minke/harness）下。 */
export const MCP_CONFIG_FILE = "minke-mcp.json";

/** mcp-client 对 serverName 的约束，提前挡掉才能给出可读的报错。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

export interface McpServerEntry {
  name: string;
  enabled?: boolean;
  transport?: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
}

export interface McpServersFile {
  servers?: McpServerEntry[];
}

/**
 * 挂载 stdio server 时必须补进子进程环境的变量。
 *
 * Minke 把 runtime/host/bin 放在 PATH 最前面，那里的 `node` 是个 shim：
 *   : "${DSH_ELECTRON_EXECUTABLE:?...}"; exec env ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON_EXECUTABLE" "$@"
 * 而 harness 的 subprocess 服务给子进程的是清洗过的环境，不带 DSH_ELECTRON_EXECUTABLE。
 * 于是任何走 node/npx 的 MCP server 一启动就死在 shim 上，然后按重连策略反复重试。
 * 这里把它补回去，用户不必知道这个 Minke 特有的细节。
 */
export const FORWARDED_STDIO_ENV = ["DSH_ELECTRON_EXECUTABLE"] as const;

/** 一条配置的解析结果：要么是可挂载的 mcp-client 配置，要么是拒绝原因。 */
export type McpServerResolution =
  | { ok: true; name: string; config: Record<string, unknown> }
  | { ok: false; name: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringDict(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * 把一条用户配置翻译成 mcp-client 的 config。
 * 纯函数，方便测试；schemastery 会补齐这里省略的默认值。
 */
export function resolveMcpServer(
  entry: unknown,
  seen: ReadonlySet<string>,
  inheritedEnv: Record<string, string> = {},
): McpServerResolution {
  if (!isRecord(entry)) {
    return { ok: false, name: "<unnamed>", reason: "条目不是对象" };
  }
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!SERVER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      name: name === "" ? "<unnamed>" : name,
      reason: "name 必须匹配 [A-Za-z0-9_-]{1,32}",
    };
  }
  if (seen.has(name)) {
    return { ok: false, name, reason: "name 重复" };
  }
  const transport = entry.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "streamable-http") {
    return { ok: false, name, reason: "transport 只能是 stdio 或 streamable-http" };
  }

  const config: Record<string, unknown> = { serverName: name, transport };
  if (typeof entry.toolCallTimeoutMs === "number") {
    config.toolCallTimeoutMs = entry.toolCallTimeoutMs;
  }

  if (transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command === "") {
      return { ok: false, name, reason: "stdio 缺少 command" };
    }
    config.command = entry.command;
    if (Array.isArray(entry.args)) {
      config.args = entry.args.filter(
        (argument): argument is string => typeof argument === "string",
      );
    }
    // 用户显式写的 env 优先，补进来的只是兜底。
    const env = { ...inheritedEnv, ...(stringDict(entry.env) ?? {}) };
    if (Object.keys(env).length > 0) config.env = env;
    if (typeof entry.cwd === "string" && entry.cwd !== "") {
      config.cwd = entry.cwd;
    }
    return { ok: true, name, config };
  }

  if (typeof entry.url !== "string" || entry.url === "") {
    return { ok: false, name, reason: "streamable-http 缺少 url" };
  }
  config.url = entry.url;
  const headers = stringDict(entry.headers);
  if (headers !== undefined) config.headers = headers;
  return { ok: true, name, config };
}

/** 展开整份配置文件，保留顺序，跳过 enabled: false 的条目。 */
export function resolveMcpServers(
  source: unknown,
  inheritedEnv: Record<string, string> = {},
): { mounted: McpServerResolution[]; skipped: number } {
  if (!isRecord(source) || !Array.isArray(source.servers)) {
    return { mounted: [], skipped: 0 };
  }
  const seen = new Set<string>();
  const mounted: McpServerResolution[] = [];
  let skipped = 0;
  for (const entry of source.servers) {
    if (isRecord(entry) && entry.enabled === false) {
      skipped += 1;
      continue;
    }
    const resolution = resolveMcpServer(entry, seen, inheritedEnv);
    if (resolution.ok) seen.add(resolution.name);
    mounted.push(resolution);
  }
  return { mounted, skipped };
}


/** 从当前进程环境里挑出要转发给 stdio 子进程的变量。 */
export function forwardedStdioEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of FORWARDED_STDIO_ENV) {
    const value = source[key];
    if (typeof value === "string" && value !== "") forwarded[key] = value;
  }
  return forwarded;
}
