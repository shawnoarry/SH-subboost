// Windows local launcher: existing programs only; no downloads or PowerShell.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { parse } = require("dotenv");
const { findStandaloneServer } = require("../local/scripts/start-standalone.cjs");

const ROOT = path.resolve(__dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function options(args) {
  const value = { port: 3001, browser: true };
  for (const arg of args) {
    if (arg === "--no-browser") value.browser = false;
    else if (/^--port=\d+$/.test(arg)) value.port = Number(arg.slice(7));
    else throw new Error(`不支持的启动选项：${arg}`);
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("端口必须为 1–65535");
  return value;
}

function readJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
        if (text.length > 16384) response.destroy();
      });
      response.on("error", () => resolve(null));
      response.on("end", () => {
        if (response.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

async function probeApp(base, read = readJson) {
  const [health, auth] = await Promise.all([read(`${base}/api/health/ready`), read(`${base}/api/auth/me`)]);
  if (health?.ok !== true || health.database !== "ready" || typeof auth?.setupRequired !== "boolean" || typeof auth.authenticated !== "boolean") return null;
  return auth;
}

function openUrl(base, auth, env) {
  return auth.setupRequired && env.LOCAL_SETUP_TOKEN
    ? `${base}/login#setup-token=${encodeURIComponent(env.LOCAL_SETUP_TOKEN)}`
    : `${base}/`;
}

function openBrowser(url, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    // URL is exclusively a validated loopback address and an encoded local setup token.
    const child = spawnProcess(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法打开默认浏览器")));
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => resolve(error.code !== "ECONNREFUSED"));
  });
}

function execute(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

function acquireLock(filename, isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}) {
  const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, "wx");
      try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); }
      return () => {
        try { if (JSON.parse(fs.readFileSync(filename, "utf8")).token === owner.token) fs.unlinkSync(filename); }
        catch { /* Already removed. */ }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(filename, "utf8")); } catch {
        if (Date.now() - fs.statSync(filename).mtimeMs < 5000) return null;
      }
      // PIDs can be reused after a reboot; an old lock must not block the next startup.
      const beforeBoot = fs.statSync(filename).mtimeMs < Date.now() - os.uptime() * 1000 - 5000;
      if (!beforeBoot && previous && (!Number.isInteger(previous.pid) || previous.pid < 1 || isAlive(previous.pid))) return null;
      try { fs.unlinkSync(filename); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    }
  }
  return null;
}

async function waitReady(base, exited = () => false, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("网页服务提前停止，请查看上方运行日志。");
    const auth = await probeApp(base);
    if (auth) return auth;
    await pause(500);
  }
  throw new Error("等待网页服务超时。请查看上方日志；不要反复启动多个窗口。");
}

async function main(args = process.argv.slice(2)) {
  if (process.platform !== "win32") throw new Error("此启动入口适用于 Windows。");
  const config = options(args);
  const base = `http://127.0.0.1:${config.port}`;
  const envFile = path.join(ROOT, "local", ".env");
  if (!fs.existsSync(envFile)) throw new Error("缺少 local/.env。本入口只启动已安装好的本地实例，不会创建或覆盖数据库。");
  const env = { ...process.env, ...parse(fs.readFileSync(envFile)), SUBBOOST_PROJECT_ROOT: ROOT, HOSTNAME: "127.0.0.1", PORT: String(config.port), NEXT_TELEMETRY_DISABLED: "1" };
  const show = async (auth) => {
    console.log(`SubBoost 已就绪：${base}/`);
    if (config.browser) {
      try { await openBrowser(openUrl(base, auth, env)); }
      catch { console.log("未能自动打开浏览器，请手动打开上面的地址。"); }
    }
  };
  const existing = await probeApp(base);
  if (existing) { console.log("检测到服务已经运行，直接打开网页。"); await show(existing); return; }

  const runtime = path.join(ROOT, "data", "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const release = acquireLock(path.join(runtime, `subboost-launcher-${config.port}.json`));
  if (!release) { console.log("另一个窗口正在启动 SubBoost，等待服务就绪…"); await show(await waitReady(base)); return; }
  let child;
  let childExit;
  let childEnded = false;
  let stopping = false;
  let databaseStarted = false;
  const pgCtl = path.join(runtime, "pgsql", "bin", "pg_ctl.exe");
  const database = path.join(ROOT, "data", "postgres");
  const stop = () => { stopping = true; if (child && !childEnded) child.kill("SIGTERM"); };
  try {
    const server = findStandaloneServer(path.join(ROOT, "local"));
    if (!fs.existsSync(server)) throw new Error("缺少本地构建，请先在项目目录执行 npm.cmd run build。本机已准备好构建，无需每次重新构建。");
    if (!fs.existsSync(pgCtl) || !fs.existsSync(path.join(database, "PG_VERSION"))) throw new Error("未找到这台电脑的 PostgreSQL 程序或数据库，请先完成本机安装。");
    const status = await execute(pgCtl, ["-D", database, "status"], ROOT);
    if (status.code !== 0) {
      console.log("正在启动本机数据库…");
      const logs = path.join(ROOT, "data", "logs");
      fs.mkdirSync(logs, { recursive: true });
      const started = await execute(pgCtl, ["-D", database, "-l", path.join(logs, "postgres.log"), "-w", "-t", "30", "start"], ROOT);
      if (started.code !== 0) throw new Error(`数据库启动失败，请查看 data/logs/postgres.log。\n${started.output}`);
      databaseStarted = true;
    }
    if (await portInUse(config.port)) {
      const auth = await waitReady(base, () => false, 15000).catch(() => null);
      if (!auth) throw new Error(`端口 ${config.port} 已被占用，且不是可用的 SubBoost 服务。未停止或替换占用程序。`);
      // An existing web process now has a working database; leave both running.
      databaseStarted = false;
      await show(auth);
      return;
    }
    console.log("正在启动 SubBoost，请保留此窗口。退出时先按 Ctrl+C，再关闭窗口。");
    child = spawn(process.execPath, [path.join(ROOT, "local", "scripts", "start-standalone.cjs")], { cwd: path.join(ROOT, "local"), env, stdio: "inherit", windowsHide: true });
    childExit = new Promise((resolve, reject) => {
      child.once("error", (error) => { childEnded = true; reject(error); });
      child.once("exit", (code) => { childEnded = true; resolve(code); });
    });
    // Attach immediately, so a spawn failure cannot become an unhandled rejection while polling.
    childExit.catch(() => {});
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const auth = await waitReady(base, () => childEnded || stopping);
    await show(auth);
    const code = await childExit;
    if (!stopping && code !== 0) throw new Error(`网页服务停止，退出码 ${code}。请查看上方日志。`);
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    if (child && !childEnded) { child.kill("SIGTERM"); await childExit.catch(() => {}); }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (databaseStarted) {
      const stopped = await execute(pgCtl, ["-D", database, "-m", "fast", "-w", "-t", "20", "stop"], ROOT).catch(() => null);
      if (stopped?.code !== 0) console.log("数据库未完成正常关闭，请保留日志检查；下次启动不会重新创建数据库。");
    }
    release();
  }
}

if (require.main === module) main().catch((error) => { console.error(`\n[SubBoost] ${error.message}`); process.exitCode = 1; });
module.exports = { options, probeApp, openUrl, openBrowser, acquireLock, main };
