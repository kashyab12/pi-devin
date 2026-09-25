import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from "./wire.js";

/**
 * Cognition gates Devin Local-only models (every GPT-5.6 variant: Sol, Terra,
 * Luna) by client ide name. With ide="windsurf" GetChatMessage rejects them
 * with "This model is only in Devin Local."; with ide="devin-desktop" the
 * server serves them and the response header echoes the exact model
 * (verified: "GPT-5.6 Sol High Thinking" for gpt-5-6-sol-high, 2026-08-29).
 */
const CLIENT_VERSION_MANIFEST_URL =
  "https://windsurf-stable.codeium.com/api/update/darwin-arm64-dmg/stable/latest";
const CLIENT_VERSION_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

function validClientVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

export async function resolveClientVersion(options: {
  productPaths?: string[];
  cachePath: string;
  offline: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}): Promise<string> {
  for (const path of options.productPaths ?? []) {
    try {
      const product = JSON.parse(readFileSync(path, "utf8")) as { windsurfVersion?: unknown };
      const version = validClientVersion(product.windsurfVersion);
      if (version) return version;
    } catch {
      // Continue to the next local product file or the cached/remote resolver.
    }
  }

  const now = options.now ?? Date.now();
  try {
    const cached = JSON.parse(readFileSync(options.cachePath, "utf8")) as {
      version?: unknown;
      fetchedAt?: unknown;
    };
    const version = validClientVersion(cached.version);
    const fetchedAt = typeof cached.fetchedAt === "number" && Number.isFinite(cached.fetchedAt)
      ? cached.fetchedAt
      : undefined;
    const fresh = fetchedAt !== undefined
      && now >= fetchedAt
      && now - fetchedAt <= CLIENT_VERSION_CACHE_MAX_AGE_MS;
    if (version && fresh) return version;
  } catch {
    // A missing or malformed cache does not override a valid remote manifest.
  }

  if (options.offline) throw new Error("Devin client version is unavailable in offline mode.");

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(CLIENT_VERSION_MANIFEST_URL, { signal: timeout });
  } catch (error) {
    if (timeout.aborted) throw new Error("Devin client version manifest request timed out.");
    throw new Error(`Devin client version manifest request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Devin client version manifest returned HTTP ${response.status}.`);

  const payload = await response.json() as { windsurfVersion?: unknown };
  const version = validClientVersion(payload.windsurfVersion);
  if (!version) throw new Error("Devin client version manifest did not contain a valid windsurfVersion.");

  mkdirSync(dirname(options.cachePath), { recursive: true });
  writeFileSync(
    options.cachePath,
    `${JSON.stringify({ version, source: "official-manifest", fetchedAt: now })}\n`,
    "utf8",
  );
  return version;
}

export async function resolveRuntimeClientVersion(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
  productPaths?: string[];
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = env.DEVIN_CLIENT_VERSION;
  if (explicit !== undefined) {
    const version = validClientVersion(explicit);
    if (!version) throw new Error("DEVIN_CLIENT_VERSION must use numeric major.minor.patch format.");
    return version;
  }

  const home = options.home ?? homedir();
  const cacheRoot = env.XDG_CACHE_HOME || join(home, ".cache");
  const offlineValue = env.PI_OFFLINE?.toLowerCase();
  return resolveClientVersion({
    productPaths: options.productPaths ?? ["/Applications/Devin.app/Contents/Resources/app/product.json"],
    cachePath: join(cacheRoot, "pi-devin", "client-version.json"),
    offline: offlineValue === "1" || offlineValue === "true" || offlineValue === "yes",
    fetchImpl: options.fetchImpl,
  });
}

export const CLIENT_IDE = "devin-desktop";

export interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  version: string;
  ide?: string;
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = validClientVersion(input.version);
  if (!version) throw new Error("A resolved Devin client version is required to build request metadata.");
  const ide = input.ide ?? CLIENT_IDE;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const parts: Buffer[] = [
    encodeString(1, ide),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeVarintField(9, input.requestId),
    encodeString(10, input.sessionId),
    encodeString(12, ide),
    encodeMessage(16, encodeTimestampBody()),
    encodeString(25, input.triggerId),
    encodeString(26, "Unset"),
    encodeString(28, ide),
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}
