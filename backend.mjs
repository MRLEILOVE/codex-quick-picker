import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { readSkillNames } from "./skill-list.mjs";

const run = promisify(execFile);
const listArgs = ["mcp", "list", "--json"];
const cliOptions = { encoding: "utf8", timeout: 8_000, windowsHide: true };
const revalidateAfterMs = 5 * 60_000;

async function configSignature(cwd) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const policyRoot = process.platform === "win32"
    ? join(process.env.ProgramData || "C:\\ProgramData", "OpenAI", "Codex")
    : "/etc/codex";
  const paths = new Set([
    join(codexHome, "config.toml"),
    join(policyRoot, "config.toml"),
    join(policyRoot, "requirements.toml")
  ]);
  for (let dir = cwd; ; dir = dirname(dir)) {
    paths.add(join(dir, ".codex", "config.toml"));
    if (dir === dirname(dir)) {
      break;
    }
  }

  // 只比较元数据，服务名仍以 Codex 实际解析的配置为准。
  const entries = await Promise.all([...paths].map(async (path) => {
    try {
      const file = await stat(path);
      return [path, file.mtimeMs, file.ctimeMs, file.size, file.ino];
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
        throw error;
      }
      return null;
    }
  }));
  return JSON.stringify(entries.filter(Boolean));
}

export default ({ sessionQuery } = {}) => {
  let codexExecutable = process.platform === "win32" ? "codex.exe" : "codex";
  const catalogs = new Map();

  async function withCodex(cwd, query) {
    try {
      return await query(codexExecutable, cwd);
    } catch (error) {
      if (error.code !== "ENOENT" || process.platform !== "win32") {
        throw error;
      }
      // Windows 商店版不会在所有启动环境中把 CLI 加进 PATH。
      const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32",
        "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout: installPath } = await run(powershell, [
        "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); "
          + "Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation"
      ], cliOptions);
      const packagePath = installPath.trim();
      if (!isAbsolute(packagePath)) {
        throw new Error("Codex package unavailable");
      }
      codexExecutable = join(packagePath, "app", "resources", "codex.exe");
      return query(codexExecutable, cwd);
    }
  }

  async function readEnabled(cwd) {
    const result = await withCodex(cwd, (executable) => run(executable, listArgs, { ...cliOptions, cwd }));
    const servers = JSON.parse(result.stdout);
    // CLI 输出可能含启动参数或凭据，只把启用服务的名称送到界面。
    return [...new Set(servers
      .filter((server) => server?.enabled === true && typeof server.name === "string" && server.name)
      .map((server) => server.name))].sort((left, right) => left.localeCompare(right));
  }

  function refresh(cwd, catalog, kind) {
    const skills = kind === "skill";
    catalog.refreshAfter = Date.now() + (skills ? 30_000 : revalidateAfterMs);
    const request = skills ? withCodex(cwd, readSkillNames) : readEnabled(cwd);
    catalog.pending = request.then((names) => {
      catalog.names = names;
      return names;
    }).finally(() => {
      catalog.pending = null;
    });
    return catalog.pending;
  }

  async function listCatalog({ sessionId, kind = "mcp" } = {}) {
    let cwd = homedir();
    // 在已存在的对话中，让 CLI 读取对应工作目录的配置层。
    if (sessionQuery && typeof sessionId === "string" && /^[\da-f-]{36}$/i.test(sessionId)) {
      try {
        const [session] = await sessionQuery.filterSessions({ id: sessionId, limit: 1 });
        if (session?.id === sessionId && typeof session.cwd === "string"
            && isAbsolute(session.cwd) && (await stat(session.cwd)).isDirectory()) {
          cwd = session.cwd;
        }
      } catch {
        // 对话索引暂不可用时仍可读取用户级配置。
      }
    }

    try {
      const signature = await configSignature(cwd).catch(() => null);
      if (signature === null) {
        return kind === "skill" ? await withCodex(cwd, readSkillNames) : await readEnabled(cwd);
      }
      const key = kind === "skill" ? JSON.stringify([kind, cwd, signature]) : signature;
      let catalog = catalogs.get(key);
      if (!catalog) {
        if (catalogs.size >= 32) {
          catalogs.delete(catalogs.keys().next().value);
        }
        catalog = {};
        catalogs.set(key, catalog);
      }
      if (!catalog.names) {
        return await (catalog.pending || refresh(cwd, catalog, kind));
      }
      // 同一配置的目录复用结果，周期性在后台核对外部变化。
      if (!catalog.pending && Date.now() >= catalog.refreshAfter) {
        void refresh(cwd, catalog, kind).catch(() => {});
      }
      return catalog.names;
    } catch {
      const label = kind === "skill" ? "Skill" : "MCP";
      throw new Error(`无法读取 Codex ${label} 列表。请检查 Codex CLI 和配置。`);
    }
  }

  return { listEnabled: listCatalog };
};
