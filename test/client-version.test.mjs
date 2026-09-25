import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as metadata from "../src/metadata.ts";

const MANIFEST_URL = "https://windsurf-stable.codeium.com/api/update/darwin-arm64-dmg/stable/latest";
const jsonResponse = (body, init = {}) => new Response(
  typeof body === "string" ? body : JSON.stringify(body),
  { ...init, headers: { "content-type": "application/json", ...init.headers } },
);

function deferredEndlessResponse({ status = 200, contentType = "application/json" } = {}) {
  let pulls = 0;
  let cancels = 0;
  let settled = false;
  let releaseCancel;
  let markCancelStarted;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const cancelStarted = new Promise((resolve) => { markCancelStarted = resolve; });
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(Uint8Array.of(123));
    },
    async cancel() {
      cancels++;
      markCancelStarted();
      await cancelGate;
      settled = true;
    },
  });
  return {
    response: new Response(body, { status, headers: { "content-type": contentType } }),
    cancelStarted,
    releaseCancel: () => releaseCancel(),
    get pulls() { return pulls; },
    get cancels() { return cancels; },
    get settled() { return settled; },
  };
}

test("resolves the current client version from the official manifest and caches it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-client-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "private-cache", "client-version.json");
  const requested = [];
  let requestInit;

  const version = await metadata.resolveClientVersion?.({
    productPaths: [],
    cachePath,
    offline: false,
    now: 1_234,
    fetchImpl: async (url, init) => {
      requested.push(String(url));
      requestInit = init;
      return jsonResponse({ windsurfVersion: "3.10.35" });
    },
  });

  assert.equal(version, "3.10.35");
  assert.deepEqual(requested, [MANIFEST_URL]);
  assert.equal(requestInit.redirect, "error");
  assert.equal(requestInit.headers, undefined, "manifest request sends no headers or credentials");
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), {
    version: "3.10.35",
    source: "official-manifest",
    fetchedAt: 1_234,
  });
  assert.equal(statSync(dirname(cachePath)).mode & 0o777, 0o700);
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(cachePath)), ["client-version.json"]);
});

test("prefers an installed Devin Desktop version without a network request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-product-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const productPath = join(dir, "product.json");
  writeFileSync(productPath, JSON.stringify({ windsurfVersion: "3.11.2" }));

  const version = await metadata.resolveClientVersion?.({
    productPaths: [productPath],
    cachePath: join(dir, "client-version.json"),
    offline: false,
    fetchImpl: async () => {
      throw new Error("network must not be used when Devin Desktop supplies a version");
    },
  });

  assert.equal(version, "3.11.2");
});

test("uses a validated cached version for six hours without a network request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cached-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  writeFileSync(cachePath, JSON.stringify({
    version: "3.10.35",
    source: "official-manifest",
    fetchedAt: 1_000,
  }), { mode: 0o600 });

  const version = await metadata.resolveClientVersion?.({
    productPaths: [],
    cachePath,
    offline: false,
    now: 5 * 60 * 60 * 1_000,
    fetchImpl: async () => {
      throw new Error("fresh cache resolution must not fetch");
    },
  });

  assert.equal(version, "3.10.35");
});

test("refreshes an expired cached version when network access is available", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-expired-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  writeFileSync(cachePath, JSON.stringify({
    version: "3.6.27",
    source: "official-manifest",
    fetchedAt: 1_000,
  }), { mode: 0o600 });

  const version = await metadata.resolveClientVersion?.({
    productPaths: [],
    cachePath,
    offline: false,
    now: 8 * 60 * 60 * 1_000,
    fetchImpl: async () => jsonResponse({ windsurfVersion: "3.10.35" }),
  });

  assert.equal(version, "3.10.35");
});

test("bounds an unresponsive official manifest request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-version-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    metadata.resolveClientVersion?.({
      productPaths: [],
      cachePath: join(dir, "client-version.json"),
      offline: false,
      timeoutMs: 5,
      fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    }),
    /timed out/i,
  );
});

test("applies the manifest timeout while streaming the response body", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-version-body-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    metadata.resolveClientVersion?.({
      productPaths: [],
      cachePath: join(dir, "client-version.json"),
      offline: false,
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
      }), { headers: { "content-type": "application/json" } }),
    }),
    /timed out/i,
  );
});

test("rejects an unsafe cache-file symlink on read without following it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-symlink-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "target.json");
  const cachePath = join(dir, "client-version.json");
  writeFileSync(target, JSON.stringify({
    version: "9.9.9",
    source: "official-manifest",
    fetchedAt: 1_000,
  }), { mode: 0o600 });
  symlinkSync(target, cachePath);

  await assert.rejects(
    metadata.resolveClientVersion?.({
      productPaths: [], cachePath, offline: true, now: 2_000,
    }),
    /unavailable in offline mode/i,
  );
  assert.equal(lstatSync(cachePath).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).version, "9.9.9");
});

test("atomically replaces a pre-existing cache symlink without following it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-symlink-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "target.json");
  const cachePath = join(dir, "client-version.json");
  writeFileSync(target, "do-not-overwrite", { mode: 0o600 });
  symlinkSync(target, cachePath);

  const version = await metadata.resolveClientVersion?.({
    productPaths: [], cachePath, offline: false, now: 2_000,
    fetchImpl: async () => jsonResponse({ windsurfVersion: "3.10.35" }),
  });

  assert.equal(version, "3.10.35");
  assert.equal(lstatSync(cachePath).isSymbolicLink(), false);
  assert.equal(readFileSync(target, "utf8"), "do-not-overwrite");
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["client-version.json", "target.json"]);
});

test("disables persistent caching when secure open flags are unavailable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-capabilities-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const available = {
    noFollow: true,
    directory: true,
    nonBlock: true,
  };

  for (const missing of Object.keys(available)) {
    const cachePath = join(dir, missing, "read", "client-version.json");
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, JSON.stringify({
      version: "9.9.9", source: "official-manifest", fetchedAt: 1_000,
    }), { mode: 0o600 });
    const cacheOptions = { capabilities: { ...available, [missing]: false } };
    const fetchImpl = async () => jsonResponse({ windsurfVersion: "3.10.35" });
    const version = await metadata.resolveClientVersion?.({
      productPaths: [], cachePath, offline: false, now: 2_000, cacheOptions, fetchImpl,
    });
    assert.equal(version, "3.10.35");
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, "9.9.9");

    const writePath = join(dir, missing, "write", "client-version.json");
    assert.equal(await metadata.resolveClientVersion?.({
      productPaths: [], cachePath: writePath, offline: false, cacheOptions, fetchImpl,
    }), "3.10.35");
    assert.equal(existsSync(writePath), false);
  }
});

test("does not block when a cache path is a FIFO", { timeout: 2_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("FIFO paths are not available on Windows");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-fifo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  const made = spawnSync("mkfifo", [cachePath]);
  if (made.status !== 0) {
    t.skip("mkfifo is unavailable");
    return;
  }

  const version = await metadata.resolveClientVersion?.({
    productPaths: [], cachePath, offline: false,
    fetchImpl: async () => jsonResponse({ windsurfVersion: "3.10.35" }),
  });
  assert.equal(version, "3.10.35");
  assert.equal(lstatSync(cachePath).isFile(), true);
});

test("fails cache read safely when the path swaps to a FIFO before open", { timeout: 2_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("FIFO paths are not available on Windows");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-path-swap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  writeFileSync(cachePath, JSON.stringify({
    version: "9.9.9", source: "official-manifest", fetchedAt: 1_000,
  }), { mode: 0o600 });
  let swapped = false;

  const version = await metadata.resolveClientVersion?.({
    productPaths: [], cachePath, offline: false, now: 2_000,
    cacheOptions: {
      beforeCacheReadOpen(path) {
        swapped = true;
        unlinkSync(path);
        const made = spawnSync("mkfifo", [path]);
        assert.equal(made.status, 0);
      },
    },
    fetchImpl: async () => jsonResponse({ windsurfVersion: "3.10.35" }),
  });

  assert.equal(swapped, true);
  assert.equal(version, "3.10.35");
  assert.equal(lstatSync(cachePath).isFile(), true);
});

test("bounds cache FD reads when the file grows after open", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-growth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  writeFileSync(cachePath, JSON.stringify({
    version: "9.9.9", source: "official-manifest", fetchedAt: 1_000,
  }), { mode: 0o600 });
  let grew = false;

  const version = await metadata.resolveClientVersion?.({
    productPaths: [], cachePath, offline: false, now: 2_000,
    cacheOptions: {
      afterCacheReadOpen(path) {
        grew = true;
        appendFileSync(path, "x".repeat(20_000));
      },
    },
    fetchImpl: async () => jsonResponse({ windsurfVersion: "3.10.35" }),
  });

  assert.equal(grew, true);
  assert.equal(version, "3.10.35");
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, "3.10.35");
});

test("cleans a random temporary cache file when the atomic rename fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  mkdirSync(cachePath);

  await assert.rejects(metadata.resolveClientVersion?.({
    productPaths: [], cachePath, offline: false,
    fetchImpl: async () => jsonResponse({ windsurfVersion: "3.10.35" }),
  }));
  assert.deepEqual(readdirSync(dir), ["client-version.json"]);
});

test("rejects a symlink or non-directory cache directory", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-directory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realDirectory = join(dir, "real");
  mkdirSync(realDirectory, { mode: 0o700 });
  const linkedDirectory = join(dir, "linked");
  symlinkSync(realDirectory, linkedDirectory);
  const notDirectory = join(dir, "plain-file");
  writeFileSync(notDirectory, "not a directory");

  for (const cachePath of [join(linkedDirectory, "client-version.json"), join(notDirectory, "client-version.json")]) {
    let fetched = false;
    await assert.rejects(
      metadata.resolveClientVersion?.({
        productPaths: [], cachePath, offline: false,
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({ windsurfVersion: "3.10.35" });
        },
      }),
      /unsafe Devin client version cache directory/i,
    );
    assert.equal(fetched, false);
  }
});

test("rejects a cache directory not owned by the current user where ownership is supported", async (t) => {
  if (typeof process.getuid !== "function") {
    t.skip("ownership checks are not available on this platform");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cache-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const actualUid = process.getuid();
  t.mock.method(process, "getuid", () => actualUid + 1);

  await assert.rejects(
    metadata.resolveClientVersion?.({
      productPaths: [], cachePath: join(dir, "client-version.json"), offline: true,
    }),
    /unsafe Devin client version cache directory/i,
  );
});

test("ignores malformed JSON and rejects future cache timestamps", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-invalid-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");

  writeFileSync(cachePath, "{not-json", { mode: 0o600 });
  await assert.rejects(
    metadata.resolveClientVersion?.({ productPaths: [], cachePath, offline: true, now: 2_000 }),
    /unavailable in offline mode/i,
  );

  writeFileSync(cachePath, JSON.stringify({
    version: "3.10.35", source: "official-manifest", fetchedAt: 3_000,
  }), { mode: 0o600 });
  await assert.rejects(
    metadata.resolveClientVersion?.({ productPaths: [], cachePath, offline: true, now: 2_000 }),
    /unavailable in offline mode/i,
  );
});

test("rejects non-JSON, malformed, non-object, and oversized manifest bodies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-invalid-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    [new Response("plain text", { headers: { "content-type": "text/plain" } }), /JSON content type/i],
    [jsonResponse("{not-json"), /invalid JSON/i],
    [jsonResponse([]), /JSON object/i],
    [jsonResponse(`{"padding":"${"x".repeat(17_000)}"}`), /exceeded 16384 bytes/i],
  ];

  for (const [index, [response, expected]] of cases.entries()) {
    await assert.rejects(
      metadata.resolveClientVersion?.({
        productPaths: [],
        cachePath: join(dir, `${index}.json`),
        offline: false,
        fetchImpl: async () => response,
      }),
      expected,
    );
  }
});

async function assertRejectedBodyShutdown(t, fixture, expected) {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-rejected-body-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const resolution = metadata.resolveClientVersion?.({
    productPaths: [],
    cachePath: join(dir, "client-version.json"),
    offline: false,
    timeoutMs: 1_000,
    signal: controller.signal,
    fetchImpl: async () => fixture.response,
  });
  const rejection = assert.rejects(resolution, expected);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.cancels, 1);
  await fixture.cancelStarted;
  assert.ok(getEventListeners(controller.signal, "abort").length > 0, "caller abort remains attached during body shutdown");
  const pullsAtCancel = fixture.pulls;
  fixture.releaseCancel();
  await rejection;
  assert.equal(fixture.settled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.pulls, pullsAtCancel, "body stops pulling after cancellation");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "caller abort listener is cleaned after shutdown");
}

test("awaits shutdown of an endless non-OK manifest body before rejecting", async (t) => {
  const fixture = deferredEndlessResponse({ status: 503 });
  await assertRejectedBodyShutdown(t, fixture, /HTTP 503/i);
});

test("awaits shutdown of an endless non-JSON manifest body before rejecting", async (t) => {
  const fixture = deferredEndlessResponse({ contentType: "text/plain" });
  await assertRejectedBodyShutdown(t, fixture, /JSON content type/i);
});

test("preserves the primary manifest error for null or already-locked rejected bodies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-rejected-locked-body-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const locked = deferredEndlessResponse({ status: 503 });
  const reader = locked.response.body.getReader();
  t.after(() => { reader.releaseLock(); });

  for (const [index, response] of [new Response(null, { status: 503 }), locked.response].entries()) {
    await assert.rejects(
      metadata.resolveClientVersion?.({
        productPaths: [],
        cachePath: join(dir, `${index}.json`),
        offline: false,
        fetchImpl: async () => response,
      }),
      /HTTP 503/i,
    );
  }
});

test("propagates a pre-aborted runtime version-resolution signal without fetching", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel before version resolution");
  controller.abort(reason);
  let fetched = false;

  await assert.rejects(
    metadata.resolveRuntimeClientVersion?.({
      env: { DEVIN_CLIENT_VERSION: "3.12.1" },
      signal: controller.signal,
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse({ windsurfVersion: "3.10.35" });
      },
    }),
    (error) => error === reason,
  );
  assert.equal(fetched, false);
});

test("cancels an in-progress runtime manifest request independently of its timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-cancel-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = new Error("cancel manifest request");
  let requestSignal;
  const resolution = metadata.resolveRuntimeClientVersion?.({
    env: { XDG_CACHE_HOME: dir },
    productPaths: [],
    signal: controller.signal,
    fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(resolution, (error) => error === reason);
  assert.equal(requestSignal.aborted, true);
});

test("fails closed with an expired cache in offline mode", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-expired-offline-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  writeFileSync(cachePath, JSON.stringify({
    version: "3.10.35",
    source: "official-manifest",
    fetchedAt: 1_000,
  }), { mode: 0o600 });

  await assert.rejects(
    metadata.resolveClientVersion?.({
      productPaths: [],
      cachePath,
      offline: true,
      now: 8 * 60 * 60 * 1_000,
      fetchImpl: async () => {
        throw new Error("offline resolution must not fetch");
      },
    }),
    /unavailable in offline mode/i,
  );
});

test("uses an explicit runtime client version without reading local or remote state", async () => {
  const version = await metadata.resolveRuntimeClientVersion?.({
    env: { DEVIN_CLIENT_VERSION: "3.12.1", PI_OFFLINE: "1" },
    home: "/unreachable-home",
    fetchImpl: async () => {
      throw new Error("explicit version must not fetch");
    },
  });

  assert.equal(version, "3.12.1");
});

test("rejects invalid or unreasonably long explicit runtime client versions", async () => {
  for (const version of ["latest", `${"1".repeat(40)}.2.3`]) {
    await assert.rejects(
      metadata.resolveRuntimeClientVersion?.({ env: { DEVIN_CLIENT_VERSION: version } }),
      /numeric major\.minor\.patch/i,
    );
  }
});

test("metadata fails closed when no resolved client version is supplied", () => {
  assert.throws(
    () => metadata.buildMetadata({
      apiKey: "synthetic-key",
      sessionId: "session",
      requestId: 1n,
      triggerId: "trigger",
    }),
    /resolved Devin client version/i,
  );
});
