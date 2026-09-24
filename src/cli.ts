import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_FED_BIN = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"),
  "devin/devin-fed/bin/devin-fed.exe",
);
const WINDOWS_DEVIN_WRAPPERS = [
  join(homedir(), ".local/bin/devin.cmd"),
  join(homedir(), ".devin/bin/devin.cmd"),
  join(homedir(), ".local/bin/devin.bat"),
  join(homedir(), ".devin/bin/devin.bat"),
];

const KNOWN_BINS = [
  process.env.DEVIN_CLI,
  ...(process.platform === "win32" ? [WINDOWS_FED_BIN, ...WINDOWS_DEVIN_WRAPPERS] : []),
  join(homedir(), ".local/bin/devin"),
  join(homedir(), ".devin/bin/devin"),
  "/opt/homebrew/bin/devin",
  "/usr/local/bin/devin",
  "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
].filter((p): p is string => Boolean(p));

export function isFedCli(bin: string | null): boolean {
  if (process.platform === "win32" && /(?:^|[\\/])devin-fed(?:\.exe)?$/i.test(bin ?? "")) return true;
  if (process.platform !== "win32" || !bin || !/\.(?:cmd|bat)$/i.test(bin)) return false;
  try {
    return /devin-fed(?:\.exe)?/i.test(readFileSync(bin, "utf8"));
  } catch {
    return false;
  }
}

let cachedBin: string | null | undefined;

export function findDevinBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  for (const bin of KNOWN_BINS) {
    if (existsSync(bin)) {
      cachedBin = bin;
      return bin;
    }
  }
  cachedBin = null;
  return null;
}

export function clearDevinBinCache(): void {
  cachedBin = undefined;
}

function needsWindowsShell(bin: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
}

export async function whichDevin(): Promise<string | null> {
  const known = findDevinBin();
  if (known) return known;
  const locator = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
  for (const name of process.platform === "win32" ? ["devin-fed.exe", "devin", "devin.exe"] : ["devin"]) {
    try {
      const { stdout } = await execFileAsync(locator, [name], { timeout: 5_000 });
      const path = stdout.split(/\r?\n/).find((candidate) => candidate.trim())?.trim();
      if (path && existsSync(path)) {
        cachedBin = path;
        return path;
      }
    } catch {
      // not on PATH
    }
  }
  return null;
}

export async function runDevin(
  args: string[],
  opts: { timeoutMs?: number; inheritStdio?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = await whichDevin();
  if (!bin) {
    throw new Error(
      "Devin CLI not found. Install the Devin CLI, or set DEVIN_CLI to the `devin` binary.",
    );
  }

  if (opts.inheritStdio) {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: "inherit", shell: needsWindowsShell(bin) });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout: "", stderr: "", code: code ?? 1 });
      });
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: needsWindowsShell(bin),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (typeof err.code === "number") {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
    }
    throw error;
  }
}

export async function devinVersion(): Promise<string | null> {
  try {
    const { stdout, code } = await runDevin(["version"], { timeoutMs: 8_000 });
    if (code !== 0) return null;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
