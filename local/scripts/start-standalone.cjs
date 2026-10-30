const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const appRoot = path.resolve(__dirname, "..");

function getStandaloneContext(root = appRoot) {
  const appDirectoryName = path.basename(root);
  const standaloneBase = path.join(root, ".next", "standalone");
  return { appDirectoryName, appRoot: root, standaloneBase };
}

function findStandaloneServer(root = appRoot) {
  const { appDirectoryName, standaloneBase } = getStandaloneContext(root);
  const candidates = [
    path.join(standaloneBase, "apps", appDirectoryName, "server.js"),
    path.join(standaloneBase, appDirectoryName, "server.js"),
    path.join(standaloneBase, "server.js"),
  ];
  const directMatch = candidates.find((candidate) => fs.existsSync(candidate));
  if (directMatch) return directMatch;

  const matches = [];
  function visit(directory, depth) {
    if (depth > 3 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
      } else if (entry.name === "server.js") {
        matches.push(entryPath);
      }
    }
  }

  visit(standaloneBase, 0);
  return matches[0] ?? candidates[0];
}

function assertBuilt(serverPath, exit = process.exit) {
  if (!fs.existsSync(serverPath)) {
    console.error("[local] standalone build is missing. Run `npm run build` before `npm run start`.");
    exit(1);
  }
}

function syncDirectory(source, target) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

async function main() {
  process.env.SUBBOOST_PROJECT_ROOT ||= path.resolve(appRoot, "..");
  const serverPath = findStandaloneServer();
  const standaloneRoot = path.dirname(serverPath);
  assertBuilt(serverPath);
  syncDirectory(path.join(appRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
  syncDirectory(path.join(appRoot, "public"), path.join(standaloneRoot, "public"));
  process.chdir(standaloneRoot);
  await import(pathToFileURL(serverPath).href);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  assertBuilt,
  findStandaloneServer,
  getStandaloneContext,
  main,
  syncDirectory,
};
