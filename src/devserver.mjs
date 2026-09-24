import { spawn } from "node:child_process";
import net from "node:net";
import { PATHS, SERVER } from "./config.mjs";
import { sleep, c, log } from "./util.mjs";

/**
 * Owns the local Next server for the duration of a run.
 *
 * HARD RULE 3.1 — the target is always local. Nothing in this file may point at
 * a deployed origin.
 */

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status < 500) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(1000);
  }
  throw new Error(`Server not ready after ${timeoutMs}ms (${lastErr})`);
}

export async function startServer({ mode = "dev", port = SERVER.port, quiet = true } = {}) {
  if (!(await portFree(port))) {
    // Something is already serving here. Use it rather than fighting over the
    // port, but say so — a stale server from a previous run would silently
    // serve stale code.
    log(c.yellow(`  ! port ${port} already in use — reusing whatever is serving it`));
    await waitForHttp(`http://127.0.0.1:${port}/`, 15_000);
    return { origin: `http://127.0.0.1:${port}`, stop: async () => {}, reused: true };
  }

  const args = mode === "prod"
    ? ["start", "-p", String(port)]
    : ["dev", "-p", String(port)];

  log(c.dim(`  starting next ${args[0]} on :${port} ...`));

  const child = spawn("npx", ["next", ...args], {
    cwd: PATHS.site,
    env: { ...process.env, NODE_ENV: mode === "prod" ? "production" : "development", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logLines = [];
  const capture = (buf) => {
    const s = buf.toString();
    logLines.push(s);
    if (!quiet) process.stdout.write(c.dim(s));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let exited = false;
  child.on("exit", (code) => { exited = true; if (code) logLines.push(`\n[server exited code ${code}]`); });

  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${origin}/`, SERVER.bootTimeoutMs);
  } catch (e) {
    child.kill("SIGTERM");
    throw new Error(`${e.message}\n--- server output ---\n${logLines.join("").slice(-4000)}`);
  }
  if (exited) throw new Error(`Server exited during boot:\n${logLines.join("").slice(-4000)}`);

  log(c.green(`  server ready at ${origin}`));

  return {
    origin,
    reused: false,
    serverLog: () => logLines.join(""),
    stop: async () => {
      if (child.killed) return;
      child.kill("SIGTERM");
      await sleep(600);
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}
