import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as metadata from "../src/metadata.ts";

const MANIFEST_URL = "https://windsurf-stable.codeium.com/api/update/darwin-arm64-dmg/stable/latest";

test("resolves the current client version from the official manifest and caches it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-client-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  const requested = [];

  const version = await metadata.resolveClientVersion?.({
    productPaths: [],
    cachePath,
    offline: false,
    now: 1_234,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ windsurfVersion: "3.10.35" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(version, "3.10.35");
  assert.deepEqual(requested, [MANIFEST_URL]);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), {
    version: "3.10.35",
    source: "official-manifest",
    fetchedAt: 1_234,
  });
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
  }));

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
  }));

  const version = await metadata.resolveClientVersion?.({
    productPaths: [],
    cachePath,
    offline: false,
    now: 8 * 60 * 60 * 1_000,
    fetchImpl: async () => new Response(JSON.stringify({ windsurfVersion: "3.10.35" })),
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

test("fails closed with an expired cache in offline mode", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-expired-offline-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, "client-version.json");
  writeFileSync(cachePath, JSON.stringify({
    version: "3.10.35",
    source: "official-manifest",
    fetchedAt: 1_000,
  }));

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

test("rejects an invalid explicit runtime client version", async () => {
  await assert.rejects(
    metadata.resolveRuntimeClientVersion?.({ env: { DEVIN_CLIENT_VERSION: "latest" } }),
    /numeric major\.minor\.patch/i,
  );
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
