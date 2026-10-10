import { spawn } from "node:child_process";
export function redact(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[密钥已隐藏]")
    .replace(
      /((?:access_token|experimental_bearer_token|OPENAI_API_KEY|authorization)\s*[=:]\s*)[^\s,]+/gi,
      "$1[已隐藏]",
    );
}
export function run(
  command,
  args,
  { cwd, input, signal, timeout = 600000, log = () => {} } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已取消"));
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let output = "",
      error = "",
      killTimer;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 2000);
        killTimer.unref();
      } catch {}
    };
    const timer = setTimeout(() => {
      stop();
    }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 3000000) output = output.slice(-3000000);
      log(redact(b));
    });
    child.stderr.on("data", (b) => {
      error += b;
      if (error.length > 50000) error = error.slice(-50000);
      log(redact(b));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(new Error(redact(e.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("任务已取消"));
      else if (code !== 0)
        reject(new Error(redact(error || output || `命令执行失败 ${code}`)));
      else resolve(output);
    });
    child.stdin.end(input || "");
  });
}
