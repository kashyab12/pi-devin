import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
const CLIENT_VERSION_MAX_LENGTH = 32;
// The official manifest is currently tiny. 16 KiB leaves ample format headroom
// while bounding memory use and preventing an unbounded response.json() read.
const CLIENT_VERSION_MANIFEST_MAX_BYTES = 16 * 1024;
const CLIENT_VERSION_CACHE_MAX_BYTES = 16 * 1024;

class UnsafeClientVersionCacheDirectoryError extends Error {}
class ClientVersionManifestError extends Error {}

function validClientVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  if (version.length === 0 || version.length > CLIENT_VERSION_MAX_LENGTH) return undefined;
  return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function combinedSignal(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const cleanup = (): void => {
    for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener);
    listeners.length = 0;
  };
  for (const signal of signals) {
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(abortReason(signal));
      cleanup();
    };
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return { signal: controller.signal, cleanup };
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function ensureSafeCacheDirectory(path: string, create: boolean): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
    }
    if (!create) return false;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      stat = lstatSync(path);
    } catch {
      throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
    }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat.uid)) {
    throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
  }
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const directoryOnly = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
    if (noFollow && directoryOnly) {
      const fd = openSync(path, constants.O_RDONLY | noFollow | directoryOnly);
      try {
        const openedStat = fstatSync(fd);
        if (
          !openedStat.isDirectory()
          || !ownedByCurrentUser(openedStat.uid)
          || stat.dev !== openedStat.dev
          || stat.ino !== openedStat.ino
        ) {
          throw new Error("cache directory changed while validating it");
        }
        fchmodSync(fd, 0o700);
      } finally {
        closeSync(fd);
      }
    } else {
      chmodSync(path, 0o700);
    }
  } catch {
    throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
  }
  return true;
}

function readClientVersionCache(path: string): { version: string; fetchedAt: number } | null {
  if (!ensureSafeCacheDirectory(dirname(path), false)) return null;
  let pathStat;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
  // Never follow a cache-file symlink. It remains in place until a verified
  // manifest result atomically replaces the directory entry.
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || !ownedByCurrentUser(pathStat.uid)) return null;
  if (pathStat.size > CLIENT_VERSION_CACHE_MAX_BYTES) return null;

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const openedStat = fstatSync(fd);
    if (
      !openedStat.isFile()
      || !ownedByCurrentUser(openedStat.uid)
      || openedStat.size > CLIENT_VERSION_CACHE_MAX_BYTES
      || (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino)
    ) return null;
    fchmodSync(fd, 0o600);
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const cache = parsed as { version?: unknown; source?: unknown; fetchedAt?: unknown };
    const version = validClientVersion(cache.version);
    if (
      !version
      || cache.source !== "official-manifest"
      || typeof cache.fetchedAt !== "number"
      || !Number.isFinite(cache.fetchedAt)
    ) return null;
    return { version, fetchedAt: cache.fetchedAt };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeClientVersionCache(path: string, version: string, fetchedAt: number): void {
  const directory = dirname(path);
  ensureSafeCacheDirectory(directory, true);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(
      fd,
      `${JSON.stringify({ version, source: "official-manifest", fetchedAt })}\n`,
      "utf8",
    );
    fchmodSync(fd, 0o600);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}

async function readBoundedManifest(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new ClientVersionManifestError("Devin client version manifest did not return a JSON content type.");
  }
  if (!response.body) {
    throw new ClientVersionManifestError("Devin client version manifest returned an empty body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await waitForSignal(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > CLIENT_VERSION_MANIFEST_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ClientVersionManifestError(
          `Devin client version manifest exceeded ${CLIENT_VERSION_MANIFEST_MAX_BYTES} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock until the combined signal settles it.
    }
  }

  let parsed: unknown;
  try {
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
    parsed = JSON.parse(body);
  } catch {
    throw new ClientVersionManifestError("Devin client version manifest contained invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ClientVersionManifestError("Devin client version manifest must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export async function resolveClientVersion(options: {
  productPaths?: string[];
  cachePath: string;
  offline: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  throwIfAborted(options.signal);
  for (const path of options.productPaths ?? []) {
    try {
      const product = JSON.parse(readFileSync(path, "utf8")) as { windsurfVersion?: unknown };
      const version = validClientVersion(product.windsurfVersion);
      if (version) {
        throwIfAborted(options.signal);
        return version;
      }
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      // Continue to the next local product file or the cached/remote resolver.
    }
  }

  const now = options.now ?? Date.now();
  const cached = readClientVersionCache(options.cachePath);
  if (
    cached
    && now >= cached.fetchedAt
    && now - cached.fetchedAt <= CLIENT_VERSION_CACHE_MAX_AGE_MS
  ) {
    throwIfAborted(options.signal);
    return cached.version;
  }

  throwIfAborted(options.signal);
  if (options.offline) throw new Error("Devin client version is unavailable in offline mode.");

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const combined = combinedSignal(options.signal ? [options.signal, timeout] : [timeout]);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(CLIENT_VERSION_MANIFEST_URL, {
      signal: combined.signal,
      redirect: "error",
    });
  } catch (error) {
    combined.cleanup();
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (timeout.aborted) throw new Error("Devin client version manifest request timed out.");
    throw new Error(`Devin client version manifest request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    combined.cleanup();
    throw new Error(`Devin client version manifest returned HTTP ${response.status}.`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readBoundedManifest(response, combined.signal);
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (timeout.aborted) throw new Error("Devin client version manifest request timed out.");
    if (error instanceof ClientVersionManifestError) throw error;
    throw new Error("Devin client version manifest body could not be read.");
  } finally {
    combined.cleanup();
  }
  const version = validClientVersion(payload.windsurfVersion);
  if (!version) throw new Error("Devin client version manifest did not contain a valid windsurfVersion.");

  throwIfAborted(options.signal);
  writeClientVersionCache(options.cachePath, version, now);
  return version;
}

export async function resolveRuntimeClientVersion(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
  productPaths?: string[];
  signal?: AbortSignal;
} = {}): Promise<string> {
  throwIfAborted(options.signal);
  const env = options.env ?? process.env;
  const explicit = env.DEVIN_CLIENT_VERSION;
  if (explicit !== undefined) {
    const version = validClientVersion(explicit);
    if (!version) throw new Error("DEVIN_CLIENT_VERSION must use numeric major.minor.patch format.");
    throwIfAborted(options.signal);
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
    signal: options.signal,
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
