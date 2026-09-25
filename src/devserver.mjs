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

/**
 * True while the server still answers. Runs and triages call this between
 * tools: a server that dies mid-run turns every later check into a navigation
 * failure, which triage would otherwise record as "not reproduced".
 */
export async function serverAlive(origin, timeoutMs = 15_000) {
  try {
    const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function firstFreePort(from, tries = 50) {
  for (let p = from; p < from + tries; p++) if (await portFree(p)) return p;
  throw new Error(`No free port in ${from}-${from + tries - 1}`);
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

/**
 * Signal the whole process group. `child.kill()` reaches only npx; the
 * `next dev` and `next-server` processes it forks live in the same group, so
 * the negative pid is what actually stops them.
 */
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH — already gone, or never got its own group. Fall back to the
    // direct child so a non-detached spawn still gets signalled.
    try { child.kill(signal); } catch { /* already reaped */ }
  }
}

async function stopTree(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killGroup(child, "SIGTERM");
  // child.killed only records that a signal was *sent*, so it can never be the
  // condition for escalating. Wait for the real exit instead.
  const timedOut = Symbol("timeout");
  const raced = await Promise.race([exited, sleep(4000).then(() => timedOut)]);
  if (raced === timedOut) {
    killGroup(child, "SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
}

export async function startServer({ mode = "dev", port = SERVER.port, quiet = true, reuse = false } = {}) {
  if (!(await portFree(port))) {
    if (reuse) {
      // Explicit --reuse-server: the caller vouches for whatever is serving.
      log(c.yellow(`  ! port ${port} already in use — reusing it (--reuse-server)`));
      await waitForHttp(`http://127.0.0.1:${port}/`, 15_000);
      return { origin: `http://127.0.0.1:${port}`, stop: async () => {}, reused: true };
    }
    // Usually an orphan from an interrupted run. Reusing it silently served
    // stale code, or died halfway through a triage; start a fresh server of
    // our own next to it instead.
    const free = await firstFreePort(port + 1);
    log(c.yellow(`  ! port ${port} is held by another process — starting a fresh server on :${free} (pass --reuse-server to use the existing one)`));
    port = free;
  }

  const args = mode === "prod"
    ? ["start", "-p", String(port)]
    : ["dev", "-p", String(port)];

  log(c.dim(`  starting next ${args[0]} on :${port} ...`));

  // detached:true puts next in its own process group. `npx next dev` forks
  // again into next-server, and a signal sent to npx alone leaves those
  // grandchildren holding the port and the stdio pipes — which keeps this
  // process's event loop alive forever. Killing the whole group is the only
  // reliable shutdown.
  const child = spawn("npx", ["next", ...args], {
    cwd: PATHS.site,
    env: { ...process.env, NODE_ENV: mode === "prod" ? "production" : "development", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
  const exitedPromise = new Promise((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      if (code) logLines.push(`\n[server exited code ${code}]`);
      resolve();
    });
  });

  // The group is detached, so a Ctrl-C in the terminal no longer reaches next
  // on its own. Without this the server would be orphaned and keep serving
  // :4333 for the next run to silently reuse. Ordinary and failed runs are
  // already covered by the caller's finally block.
  const reap = () => { killGroup(child, "SIGKILL"); };
  process.once("SIGINT", () => { reap(); process.exit(130); });
  process.once("SIGTERM", () => { reap(); process.exit(143); });

  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${origin}/`, SERVER.bootTimeoutMs);
  } catch (e) {
    await stopTree(child, exitedPromise);
    throw new Error(`${e.message}\n--- server output ---\n${logLines.join("").slice(-4000)}`);
  }
  if (exited) throw new Error(`Server exited during boot:\n${logLines.join("").slice(-4000)}`);

  log(c.green(`  server ready at ${origin}`));

  return {
    origin,
    reused: false,
    serverLog: () => logLines.join(""),
    stop: async () => stopTree(child, exitedPromise),
    // --keep-server: let this process exit while next keeps running. The piped
    // stdio and the child handle are what hold the event loop open, so both
    // have to be released.
    detach: () => {
      child.stdout?.removeListener("data", capture);
      child.stderr?.removeListener("data", capture);
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.unref();
      log(c.dim(`  server left running on ${origin} (pid ${child.pid})`));
    },
  };
}
