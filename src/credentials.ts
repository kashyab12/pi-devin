import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDevin } from "./cli.js";

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
  webappHost: string;
  apiUrl: string;
  path: string;
}

const CREDENTIALS_PATH = join(homedir(), ".local/share/devin/credentials.toml");

function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function readCredentials(): DevinCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  const raw = parseTomlStrings(readFileSync(CREDENTIALS_PATH, "utf8"));
  const apiKey = raw.windsurf_api_key || raw.api_key;
  if (!apiKey) return null;
  return {
    apiKey,
    apiServerUrl: (raw.api_server_url || "https://server.codeium.com").replace(/\/$/, ""),
    webappHost: raw.devin_webapp_host || "app.devin.ai",
    apiUrl: raw.devin_api_url || "https://api.devin.ai",
    path: CREDENTIALS_PATH,
  };
}

export async function authStatus(): Promise<{
  loggedIn: boolean;
  summary: string;
}> {
  const creds = readCredentials();
  try {
    const { stdout, stderr, code } = await runDevin(["auth", "status"], { timeoutMs: 15_000 });
    const text = `${stdout}\n${stderr}`.trim();
    const loggedIn = code === 0 && /logged in/i.test(text);
    return { loggedIn: loggedIn || Boolean(creds), summary: text || (creds ? "credentials.toml present" : "not signed in") };
  } catch (error) {
    if (creds) {
      return { loggedIn: true, summary: `Devin credentials present at ${CREDENTIALS_PATH}` };
    }
    return {
      loggedIn: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loginWithCli(): Promise<DevinCredentials> {
  const already = readCredentials();
  const status = await authStatus();
  if (already && status.loggedIn) return already;

  const { code } = await runDevin(["auth", "login"], { inheritStdio: true });
  const creds = readCredentials();
  if (!creds) {
    throw new Error(
      `\`devin auth login\` ${code === 0 ? "finished" : `exited ${code}`} but ${CREDENTIALS_PATH} is missing. Run \`devin auth login\` yourself, then /login devin again.`,
    );
  }
  return creds;
}
