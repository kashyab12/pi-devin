import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
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

interface ClientVersionCacheCapabilities {
  noFollow: number;
  directory: number;
  nonBlock: number;
}

interface ClientVersionCacheOptions {
  capabilities?: Partial<Record<keyof ClientVersionCacheCapabilities, boolean>>;
  beforeCacheReadOpen?: (path: string) => void;
  afterCacheReadOpen?: (path: string, fd: number) => void;
}

interface SafeCacheDirectory {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

function cacheCapabilities(options?: ClientVersionCacheOptions): ClientVersionCacheCapabilities {
  const available = (flag: number | undefined, enabled: boolean | undefined): number =>
    enabled === false || typeof flag !== "number" ? 0 : flag;
  return {
    noFollow: available(constants.O_NOFOLLOW, options?.capabilities?.noFollow),
    directory: available(constants.O_DIRECTORY, options?.capabilities?.directory),
    nonBlock: available(constants.O_NONBLOCK, options?.capabilities?.nonBlock),
  };
}

function persistentCacheIsSafe(capabilities: ClientVersionCacheCapabilities): boolean {
  return capabilities.noFollow !== 0 && capabilities.directory !== 0 && capabilities.nonBlock !== 0;
}

function sameNode(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateCacheDirectory(directory: SafeCacheDirectory): void {
  try {
    const openedStat = fstatSync(directory.fd);
    const pathStat = lstatSync(directory.path);
    if (
      !openedStat.isDirectory()
      || !pathStat.isDirectory()
      || pathStat.isSymbolicLink()
      || !ownedByCurrentUser(openedStat.uid)
      || !ownedByCurrentUser(pathStat.uid)
      || !sameNode(openedStat, directory)
      || !sameNode(pathStat, directory)
    ) throw new Error("cache directory changed while in use");
  } catch {
    throw new UnsafeClientVersionCacheDirectoryError(
      `Unsafe Devin client version cache directory: ${directory.path}`,
    );
  }
}

function openSafeCacheDirectory(
  path: string,
  create: boolean,
  capabilities: ClientVersionCacheCapabilities,
): SafeCacheDirectory | null {
  let pathStat;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
    }
    if (!create) return null;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      pathStat = lstatSync(path);
    } catch {
      throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
    }
  }
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || !ownedByCurrentUser(pathStat.uid)) {
    throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | capabilities.noFollow | capabilities.directory | capabilities.nonBlock,
    );
    const openedStat = fstatSync(fd);
    if (
      !openedStat.isDirectory()
      || !ownedByCurrentUser(openedStat.uid)
      || !sameNode(pathStat, openedStat)
    ) throw new Error("cache directory changed while opening it");
    fchmodSync(fd, 0o700);
    const directory = { fd, path, dev: openedStat.dev, ino: openedStat.ino };
    validateCacheDirectory(directory);
    fd = undefined;
    return directory;
  } catch {
    throw new UnsafeClientVersionCacheDirectoryError(`Unsafe Devin client version cache directory: ${path}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readClientVersionCache(
  path: string,
  capabilities: ClientVersionCacheCapabilities,
  options?: ClientVersionCacheOptions,
): { version: string; fetchedAt: number } | null {
  if (!persistentCacheIsSafe(capabilities)) return null;
  const directory = openSafeCacheDirectory(dirname(path), false, capabilities);
  if (!directory) return null;
  let fd: number | undefined;
  try {
    validateCacheDirectory(directory);
    let pathStat;
    try {
      pathStat = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
    // Never follow a cache-file symlink or open a non-regular path.
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !ownedByCurrentUser(pathStat.uid)) return null;
    if (pathStat.size > CLIENT_VERSION_CACHE_MAX_BYTES) return null;

    options?.beforeCacheReadOpen?.(path);
    fd = openSync(
      path,
      constants.O_RDONLY | capabilities.noFollow | capabilities.nonBlock,
    );
    options?.afterCacheReadOpen?.(path, fd);
    const openedStat = fstatSync(fd);
    if (
      !openedStat.isFile()
      || !ownedByCurrentUser(openedStat.uid)
      || openedStat.size > CLIENT_VERSION_CACHE_MAX_BYTES
      || !sameNode(pathStat, openedStat)
    ) return null;
    fchmodSync(fd, 0o600);

    const body = Buffer.alloc(CLIENT_VERSION_CACHE_MAX_BYTES + 1);
    let size = 0;
    while (size < body.length) {
      const bytesRead = readSync(fd, body, size, body.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > CLIENT_VERSION_CACHE_MAX_BYTES) return null;

    const afterReadStat = fstatSync(fd);
    let afterReadPathStat;
    try {
      afterReadPathStat = lstatSync(path);
    } catch {
      return null;
    }
    if (
      !afterReadStat.isFile()
      || !afterReadPathStat.isFile()
      || afterReadPathStat.isSymbolicLink()
      || !ownedByCurrentUser(afterReadStat.uid)
      || !ownedByCurrentUser(afterReadPathStat.uid)
      || afterReadStat.size > CLIENT_VERSION_CACHE_MAX_BYTES
      || !sameNode(openedStat, afterReadStat)
      || !sameNode(openedStat, afterReadPathStat)
    ) return null;
    validateCacheDirectory(directory);

    const parsed: unknown = JSON.parse(body.subarray(0, size).toString("utf8"));
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
    try {
      if (fd !== undefined) closeSync(fd);
      validateCacheDirectory(directory);
    } finally {
      closeSync(directory.fd);
    }
  }
}

function writeClientVersionCache(
  path: string,
  version: string,
  fetchedAt: number,
  capabilities: ClientVersionCacheCapabilities,
): void {
  if (!persistentCacheIsSafe(capabilities)) return;
  const directory = openSafeCacheDirectory(dirname(path), true, capabilities);
  if (!directory) return;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    validateCacheDirectory(directory);
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | capabilities.noFollow
        | capabilities.nonBlock,
      0o600,
    );
    let openedStat = fstatSync(fd);
    let temporaryPathStat = lstatSync(temporaryPath);
    if (
      !openedStat.isFile()
      || !temporaryPathStat.isFile()
      || temporaryPathStat.isSymbolicLink()
      || !ownedByCurrentUser(openedStat.uid)
      || !ownedByCurrentUser(temporaryPathStat.uid)
      || !sameNode(openedStat, temporaryPathStat)
    ) throw new Error("Unsafe Devin client version temporary cache file.");

    writeFileSync(
      fd,
      `${JSON.stringify({ version, source: "official-manifest", fetchedAt })}\n`,
      "utf8",
    );
    fchmodSync(fd, 0o600);
    openedStat = fstatSync(fd);
    temporaryPathStat = lstatSync(temporaryPath);
    if (
      !openedStat.isFile()
      || !temporaryPathStat.isFile()
      || temporaryPathStat.isSymbolicLink()
      || !ownedByCurrentUser(openedStat.uid)
      || !ownedByCurrentUser(temporaryPathStat.uid)
      || !sameNode(openedStat, temporaryPathStat)
      || (openedStat.mode & 0o777) !== 0o600
    ) throw new Error("Unsafe Devin client version temporary cache file.");

    validateCacheDirectory(directory);
    try {
      const finalPathStat = lstatSync(path);
      if (!ownedByCurrentUser(finalPathStat.uid) || finalPathStat.isDirectory()) {
        throw new Error("Unsafe Devin client version cache destination.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    renameSync(temporaryPath, path);

    const finalPathStat = lstatSync(path);
    const finalOpenedStat = fstatSync(fd);
    if (
      !finalPathStat.isFile()
      || finalPathStat.isSymbolicLink()
      || !finalOpenedStat.isFile()
      || !ownedByCurrentUser(finalPathStat.uid)
      || !ownedByCurrentUser(finalOpenedStat.uid)
      || !sameNode(finalPathStat, finalOpenedStat)
      || (finalPathStat.mode & 0o777) !== 0o600
    ) throw new Error("Unsafe Devin client version cache file after rename.");
    validateCacheDirectory(directory);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        validateCacheDirectory(directory);
      } finally {
        closeSync(directory.fd);
      }
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
        throw new ClientVersionManifestError(
          `Devin client version manifest exceeded ${CLIENT_VERSION_MANIFEST_MAX_BYTES} bytes.`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await waitForSignal(reader.cancel(error), signal);
    } catch {
      // Preserve the primary read, timeout, or caller-abort error.
    }
    throw error;
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

async function shutdownResponseBody(response: Response, signal: AbortSignal, reason: unknown): Promise<void> {
  if (!response.body) return;
  try {
    await waitForSignal(response.body.cancel(reason), signal);
  } catch {
    // Null, locked, already-cancelled, or abort-bounded bodies must not mask
    // the primary controlled manifest error.
  }
}

export async function resolveClientVersion(options: {
  productPaths?: string[];
  cachePath: string;
  offline: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  cacheOptions?: ClientVersionCacheOptions;
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
  const capabilities = cacheCapabilities(options.cacheOptions);
  const cached = readClientVersionCache(options.cachePath, capabilities, options.cacheOptions);
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
  let payload: Record<string, unknown>;
  try {
    if (!response.ok) {
      const error = new Error(`Devin client version manifest returned HTTP ${response.status}.`);
      await shutdownResponseBody(response, combined.signal, error);
      throw error;
    }
    try {
      payload = await readBoundedManifest(response, combined.signal);
    } catch (error) {
      await shutdownResponseBody(response, combined.signal, error);
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (timeout.aborted) throw new Error("Devin client version manifest request timed out.");
      if (error instanceof ClientVersionManifestError) throw error;
      throw new Error("Devin client version manifest body could not be read.");
    }
  } finally {
    combined.cleanup();
  }
  const version = validClientVersion(payload.windsurfVersion);
  if (!version) throw new Error("Devin client version manifest did not contain a valid windsurfVersion.");

  throwIfAborted(options.signal);
  writeClientVersionCache(options.cachePath, version, now, capabilities);
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
