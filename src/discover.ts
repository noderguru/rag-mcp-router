import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { ServerSpecSchema, type ServerSpec } from "./config.js";

/** One host config file that yielded servers, for reporting back to the user. */
export interface DiscoveredSource {
  client: string;
  path: string;
  names: string[];
}

export interface Discovery {
  servers: Record<string, ServerSpec>;
  sources: DiscoveredSource[];
}

/** Candidate host MCP config locations across the clients listed in the README's
 *  "Compatible clients" table. Project-scoped paths (resolved against `cwd`) come
 *  first so the closest config wins; user- and app-data-scoped paths follow.
 *  Missing files are silently skipped, so an over-broad list costs nothing. */
function candidateSources(cwd: string): Array<{ client: string; path: string }> {
  const home = homedir();
  const list: Array<{ client: string; path: string }> = [];
  const add = (client: string, ...segs: string[]) => list.push({ client, path: join(...segs) });

  // ── project-scoped (current working directory) ──
  add("Claude Code", cwd, ".mcp.json");
  add("Cursor", cwd, ".cursor", "mcp.json");
  add("VS Code", cwd, ".vscode", "mcp.json");
  add("OpenCode", cwd, "opencode.json");
  add("OpenCode", cwd, "opencode.jsonc");

  // ── user-scoped (home) ──
  add("Claude Code", home, ".claude.json");
  add("Cursor", home, ".cursor", "mcp.json");
  add("Windsurf", home, ".codeium", "windsurf", "mcp_config.json");
  add("OpenCode", home, ".config", "opencode", "opencode.json");
  add("Qwen Code", home, ".qwen", "settings.json");
  add("Kimi", home, ".kimi", "settings.json");
  add("Xiaomi MiMo", home, ".mimo", "settings.json");

  // ── app-data (OS-specific): Cline, Cherry Studio, Claude Desktop ──
  const plat = platform();
  const appData =
    plat === "win32"
      ? join(home, "AppData", "Roaming")
      : plat === "darwin"
        ? join(home, "Library", "Application Support")
        : join(home, ".config");
  add(
    "Cline",
    appData,
    "Code",
    "User",
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );
  add("Cherry Studio", appData, "CherryStudio", "config.json");
  add("Claude Desktop", appData, "Claude", "claude_desktop_config.json");

  return list;
}

/** Strip `//` and `/* *\/` comments and trailing commas so we can parse the
 *  JSONC some clients (VS Code, OpenCode) allow. String contents are preserved,
 *  so `https://…` inside a value is never mistaken for a comment. */
function stripJsonc(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++; // skip the closing '/'
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

type RawMap = Record<string, unknown>;

/** Pull every `{ name: serverEntry }` map a host config might hold:
 *  the standard `mcpServers`, VS Code's `servers` / `mcp.servers`, and the
 *  per-project `projects[cwd].mcpServers` block inside `~/.claude.json`. */
function extractServerMaps(json: unknown, cwd: string): RawMap[] {
  const maps: RawMap[] = [];
  const push = (m: unknown) => {
    if (m && typeof m === "object" && !Array.isArray(m)) maps.push(m as RawMap);
  };
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    push(o.mcpServers);
    push(o.servers);
    push((o.mcp as Record<string, unknown> | undefined)?.servers);
    const projects = o.projects as Record<string, unknown> | undefined;
    if (projects && typeof projects === "object") {
      const here = projects[cwd] as Record<string, unknown> | undefined;
      push(here?.mcpServers);
    }
  }
  return maps;
}

/** Normalize a single host server entry into our `{command,args,env}|{url}` shape,
 *  tolerating the variations clients use: array-form `command` (OpenCode),
 *  `environment` instead of `env`, and a `disabled` flag. Returns `null` for
 *  anything that can't be mapped to exactly one transport. */
function normalize(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.disabled === true) return null;

  const out: Record<string, unknown> = {};
  if (Array.isArray(r.command) && r.command.length > 0) {
    out.command = r.command[0];
    const rest = r.command.slice(1);
    const extra = Array.isArray(r.args) ? r.args : [];
    const args = [...rest, ...extra];
    if (args.length) out.args = args;
  } else if (typeof r.command === "string") {
    out.command = r.command;
    if (Array.isArray(r.args)) out.args = r.args;
  } else if (typeof r.url === "string") {
    out.url = r.url;
  } else {
    return null;
  }

  const env = (r.env ?? r.environment) as Record<string, unknown> | undefined;
  if (env && typeof env === "object") {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") e[k] = v;
    if (Object.keys(e).length) out.env = e;
  }
  return out;
}

/** A server entry that points back at the router itself — never route to it,
 *  or the facade would recurse into its own tools. */
function isSelf(name: string, spec: ServerSpec): boolean {
  if (name === "rag-mcp-router") return true;
  const hay = [spec.command, ...(spec.args ?? [])].filter(Boolean).join(" ");
  return /rag-mcp-router/.test(hay);
}

/** Scan host MCP configs and collect the downstream servers to route to.
 *  Pass `sources` to pin discovery to explicit files (the `--from` flag);
 *  otherwise every known client location is scanned. The first source to
 *  define a given server name wins, so project configs override user ones. */
export function discoverHostServers(opts: { cwd?: string; sources?: string[] } = {}): Discovery {
  const cwd = opts.cwd ?? process.cwd();
  const candidates = opts.sources
    ? opts.sources.map((path) => ({ client: "custom", path }))
    : candidateSources(cwd);

  const servers: Record<string, ServerSpec> = {};
  const sources: DiscoveredSource[] = [];

  for (const { client, path } of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // file absent or unreadable — skip
    }
    let json: unknown;
    try {
      json = JSON.parse(stripJsonc(text));
    } catch {
      continue; // unparseable — skip rather than abort discovery
    }

    const taken: string[] = [];
    for (const map of extractServerMaps(json, cwd)) {
      for (const [name, raw] of Object.entries(map)) {
        if (name in servers) continue; // earlier (more specific) source wins
        const norm = normalize(raw);
        if (!norm) continue;
        const parsed = ServerSpecSchema.safeParse(norm);
        if (!parsed.success) continue;
        if (isSelf(name, parsed.data)) continue;
        servers[name] = parsed.data;
        taken.push(name);
      }
    }
    if (taken.length) sources.push({ client, path, names: taken });
  }

  return { servers, sources };
}
