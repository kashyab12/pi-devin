import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ZED_DEVIN =
  join(
    homedir(),
    "Library/Application Support/Zed/external_agents/registry/devin",
  );

const KNOWN_BINS = [
  process.env.DEVIN_CLI,
  join(homedir(), ".local/bin/devin"),
  join(homedir(), ".devin/bin/devin"),
  "/opt/homebrew/bin/devin",
  "/usr/local/bin/devin",
  "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
].filter((p): p is string => Boolean(p));

let cachedBin: string | null | undefined;

function newestZedDevin(): string | null {
  try {
    if (!existsSync(ZED_DEVIN)) return null;
    const versions = readdirSync(ZED_DEVIN)
      .map((name) => {
        const bin = join(ZED_DEVIN, name, "bin/devin");
        try {
          return { bin, mtime: statSync(bin).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((row): row is { bin: string; mtime: number } => Boolean(row))
      .sort((a, b) => b.mtime - a.mtime);
    return versions[0]?.bin ?? null;
  } catch {
    return null;
  }
}

export function findDevinBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  for (const bin of KNOWN_BINS) {
    if (existsSync(bin)) {
      cachedBin = bin;
      return bin;
    }
  }
  const zed = newestZedDevin();
  if (zed) {
    cachedBin = zed;
    return zed;
  }
  cachedBin = null;
  return null;
}

export function clearDevinBinCache(): void {
  cachedBin = undefined;
}

export async function whichDevin(): Promise<string | null> {
  const known = findDevinBin();
  if (known) return known;
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["devin"], { timeout: 5_000 });
    const path = stdout.trim();
    if (path && existsSync(path)) {
      cachedBin = path;
      return path;
    }
  } catch {
    // not on PATH
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
      "Devin CLI not found. Install Devin, or set DEVIN_CLI to the `devin` binary (Zed ACP registry and Devin.app are also checked).",
    );
  }

  if (opts.inheritStdio) {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: "inherit" });
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
