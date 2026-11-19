import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function readSkillNames(executable, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const deadline = setTimeout(() => finish(new Error("读取 Skill 列表超时")), 12_000);
    let settled = false;

    function finish(error, names) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      lines.close();
      child.stdin.destroy();
      child.kill();
      if (error) {
        reject(error);
      } else {
        resolve(names);
      }
    }

    function send(message) {
      child.stdin.write(JSON.stringify(message) + "\n");
    }

    child.on("error", finish);
    child.on("exit", () => finish(new Error("Codex App Server 已退出")));
    child.stdin.on("error", finish);
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== 1 && message.id !== 2) {
        return;
      }
      if (message.error) {
        finish(new Error("Codex App Server 拒绝了 Skill 查询"));
        return;
      }
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "skills/list", params: { cwds: [cwd] } });
        return;
      }
      const list = message.result?.data?.[0]?.skills;
      if (!Array.isArray(list)) {
        finish(new Error("Codex App Server 未返回 Skill 清单"));
        return;
      }
      const names = list
        .filter((skill) => skill.enabled === true && typeof skill.name === "string" && skill.name)
        .map((skill) => skill.name);
      finish(null, [...new Set(names)].sort((left, right) => left.localeCompare(right)));
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "codex-quick-picker", version: "2.0.0" }
    } });
  });
}
