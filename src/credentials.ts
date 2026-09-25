import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findDevinBin, isFedCli, runDevin } from "./cli.ts";

export const DEVIN_CLI_AUTH_MARKER = "devin-cli";

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
  webappHost: string;
  apiUrl: string;
  path: string;
}

export function resolveStreamAuth(
  apiKey: string | undefined,
  apiServerUrl: string | undefined,
  credentials: DevinCredentials | null,
): { apiKey: string | undefined; host: string } {
  const useCredentials = Boolean(credentials) &&
    (!apiKey || apiKey === DEVIN_CLI_AUTH_MARKER || apiKey === credentials?.apiKey);
  return {
    apiKey: useCredentials ? credentials?.apiKey : apiKey === DEVIN_CLI_AUTH_MARKER ? undefined : apiKey,
    host: (apiServerUrl || (useCredentials ? credentials?.apiServerUrl : undefined) || "https://server.codeium.com").replace(/\/$/, ""),
  };
}

const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".local/share/devin/credentials.toml");
const FED_CREDENTIALS_PATH = join(
  process.env.APPDATA || join(homedir(), "AppData/Roaming"),
  "devin/devin-fed/credentials.toml",
);

export function credentialsPathForCli(bin: string | null): string {
  return isFedCli(bin) ? FED_CREDENTIALS_PATH : DEFAULT_CREDENTIALS_PATH;
}

function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function credentialsPath(): string {
  return credentialsPathForCli(findDevinBin());
}

export function readCredentials(path = credentialsPath()): DevinCredentials | null {
  if (!existsSync(path)) return null;
  const raw = parseTomlStrings(readFileSync(path, "utf8"));
  const apiKey = raw.windsurf_api_key || raw.api_key;
  if (!apiKey) return null;
  return {
    apiKey,
    apiServerUrl: (raw.api_server_url || "https://server.codeium.com").replace(/\/$/, ""),
    webappHost: raw.devin_webapp_host || "app.devin.ai",
    apiUrl: raw.devin_api_url || "https://api.devin.ai",
    path,
  };
}

export function readActiveCredentials(): DevinCredentials | null {
  return readCredentials(credentialsPath());
}

export async function authStatus(): Promise<{
  loggedIn: boolean;
  summary: string;
}> {
  const creds = readActiveCredentials();
  try {
    const { stdout, stderr, code } = await runDevin(["auth", "status"], { timeoutMs: 15_000 });
    const text = `${stdout}\n${stderr}`.trim();
    const loggedIn = code === 0 && /logged in/i.test(text);
    return { loggedIn: loggedIn || Boolean(creds), summary: text || (creds ? "credentials.toml present" : "not signed in") };
  } catch (error) {
    if (creds) {
      return { loggedIn: true, summary: `Devin credentials present at ${creds.path}` };
    }
    return {
      loggedIn: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loginWithCli(): Promise<DevinCredentials> {
  const already = readActiveCredentials();
  const status = await authStatus();
  if (already && status.loggedIn) return already;

  const { code } = await runDevin(["auth", "login"], { inheritStdio: true });
  const creds = readActiveCredentials();
  if (!creds) {
    throw new Error(
      `\`devin auth login\` ${code === 0 ? "finished" : `exited ${code}`} but ${credentialsPath()} is missing. Run \`devin auth login\` yourself, then /login devin again.`,
    );
  }
  return creds;
}
