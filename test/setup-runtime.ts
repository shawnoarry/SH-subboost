import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

function findGitBashBin(): string | null {
  let installedGitBin: string | undefined;
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
    installedGitBin = resolve(execPath, "../../../bin");
  } catch { /* Fall back to standard installer locations. */ }
  const candidates = [
    installedGitBin,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin"),
    process.env.USERPROFILE && join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "bin"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((directory) => existsSync(join(directory, "bash.exe"))) || null;
}

if (process.platform === "win32") {
  const gitBashBin = findGitBashBin();
  if (!gitBashBin) {
    throw new Error("Git for Windows Bash is required to run SubBoost shell-script tests on Windows.");
  }
  process.env.PATH = `${gitBashBin}${delimiter}${process.env.PATH || ""}`;
}
