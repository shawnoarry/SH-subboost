// Initializes a NEW Windows instance using bundled PostgreSQL; never copies another PC's database or keys.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { acquireLock } = require("./windows-local.cjs");

function run(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-12000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-12000); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`程序执行失败（退出码 ${code}），请检查本机安装环境。`)));
  });
}

function isAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function chooseDatabasePort() {
  for (let port = 55432; port < 55442; port++) if (await isAvailable(port)) return port;
  throw new Error("本机数据库候选端口均被占用，未停止任何现有程序。");
}

function schemaSql(migrationsRoot) {
  const names = fs.readdirSync(migrationsRoot).filter(name => /^\d{14}_[a-z0-9_]+$/.test(name)).sort();
  if (!names.length) throw new Error("缺少数据库迁移文件。");
  const statements = ["BEGIN;"];
  const migrations = names.map(name => {
    const sql = fs.readFileSync(path.join(migrationsRoot, name, "migration.sql"), "utf8");
    statements.push(`-- ${name}\n${sql}`);
    return { name, checksum: createHash("sha256").update(sql).digest("hex") };
  });
  statements.push(`CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  );`);
  for (const { name, checksum } of migrations) statements.push(`INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count") VALUES ('${randomUUID()}', '${checksum}', now(), '${name}', 1);`);
  statements.push("COMMIT;");
  return { sql: statements.join("\n"), migrationCount: migrations.length };
}

async function initializeNew(root) {
  if (process.platform !== "win32") throw new Error("此入口适用于 Windows。");
  const envFile = path.join(root, "local", ".env");
  const database = path.join(root, "data", "postgres");
  const hasEnv = fs.existsSync(envFile), hasDatabase = fs.existsSync(path.join(database, "PG_VERSION"));
  if (hasEnv && hasDatabase) { console.log("此目录已经初始化，保留现有账号、配置和数据库。"); return { existing: true }; }
  if (hasEnv || (fs.existsSync(database) && fs.readdirSync(database).length)) throw new Error("检测到已有或未完成的安装。为保护数据，不会覆盖；请交给 Codex 检查。");
  const runtime = path.join(root, "data", "runtime");
  const bin = path.join(runtime, "pgsql", "bin");
  for (const name of ["initdb.exe", "pg_ctl.exe", "createdb.exe", "psql.exe"]) if (!fs.existsSync(path.join(bin, name))) throw new Error("缺少便携 PostgreSQL。请先完整解压本机迁移包；此入口不会下载程序。");
  const schema = schemaSql(path.join(root, "local", "prisma", "migrations"));
  const port = await chooseDatabasePort();
  const databasePassword = randomBytes(32).toString("base64url");
  const randomKey = () => randomBytes(32).toString("hex");
  const envText = `POSTGRES_DB=subboost\nPOSTGRES_USER=subboost\nPOSTGRES_PASSWORD=${databasePassword}\nDATABASE_URL=postgresql://subboost:${databasePassword}@127.0.0.1:${port}/subboost?schema=public\nENCRYPTION_KEY=${randomKey()}\nJWT_SECRET=${randomKey()}\nCRON_SECRET=${randomKey()}\nLOCAL_SETUP_TOKEN=${randomKey()}\nAPP_URL=http://127.0.0.1:3001\nSUBBOOST_PORT=3001\nALLOW_UNAUTHENTICATED_CRON=false\nTRUST_PROXY_HEADERS=false\n`;
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const passwordFile = path.join(runtime, `setup-${randomUUID()}.pw`);
  const sqlFile = path.join(runtime, `setup-${randomUUID()}.sql`);
  const dbEnv = { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "subboost", PGPASSWORD: databasePassword };
  let databaseStarted = false;
  try {
    fs.writeFileSync(passwordFile, databasePassword + "\n", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(sqlFile, schema.sql, { flag: "wx", mode: 0o600 });
    console.log("正在创建本机独立数据库和密钥；不会导入其他电脑的账号。");
    await run(path.join(bin, "initdb.exe"), ["-D", database, "--username=subboost", "--encoding=UTF8", "--locale=C", "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", `--pwfile=${passwordFile}`], dbEnv);
    fs.appendFileSync(path.join(database, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`);
    const logs = path.join(root, "data", "logs"); fs.mkdirSync(logs, { recursive: true });
    await run(path.join(bin, "pg_ctl.exe"), ["-D", database, "-l", path.join(logs, "postgres.log"), "-w", "-t", "30", "start"], dbEnv);
    databaseStarted = true;
    await run(path.join(bin, "createdb.exe"), ["--no-password", "subboost"], dbEnv);
    await run(path.join(bin, "psql.exe"), ["-X", "--no-password", "--dbname=subboost", "--set=ON_ERROR_STOP=1", "--file", sqlFile], dbEnv);
    fs.writeFileSync(envFile, envText, { flag: "wx", mode: 0o600 });
    console.log("初始化完成。双击“启动SubBoost.cmd”，在网页创建这台电脑自己的本机账号。");
    return { existing: false, port, migrationCount: schema.migrationCount };
  } catch (error) {
    // Preserve the generated local key when an initialization failed after initdb; do not destroy data.
    if (fs.existsSync(path.join(database, "PG_VERSION")) && !fs.existsSync(envFile)) {
      const recovery = path.join(runtime, "setup-recovery.env");
      if (!fs.existsSync(recovery)) fs.writeFileSync(recovery, envText, { flag: "wx", mode: 0o600 });
    }
    throw error;
  } finally {
    if (databaseStarted) await run(path.join(bin, "pg_ctl.exe"), ["-D", database, "-m", "fast", "-w", "-t", "20", "stop"], dbEnv).catch(() => console.error("新数据库未正常停止，请检查 data/logs/postgres.log。"));
    for (const file of [passwordFile, sqlFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function initialize(root = path.resolve(__dirname, "..")) {
  const runtime = path.join(root, "data", "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const release = acquireLock(path.join(runtime, "subboost-setup.json"));
  if (!release) throw new Error("另一个窗口正在初始化此目录，请等待完成，不要重复安装。");
  try { return await initializeNew(root); }
  finally { release(); }
}

if (require.main === module) initialize().catch(error => { console.error(`[SubBoost] ${error.message}`); process.exitCode = 1; });
module.exports = { initialize, schemaSql, isAvailable };
