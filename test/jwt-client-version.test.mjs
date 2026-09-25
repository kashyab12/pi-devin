import assert from "node:assert/strict";
import test from "node:test";
import { clearCachedUserJwt, getCachedUserJwt, mintUserJwt } from "../src/jwt.ts";
import { encodeMessage, iterFields } from "../src/wire.ts";

const fields = (buffer) => [...iterFields(buffer)];

test("mints the user JWT with the resolved Devin client version", async (t) => {
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  let advertisedVersion;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const envelope = fields(Buffer.from(options.body));
    const metadataField = envelope.find((field) => field.num === 1);
    const metadata = fields(metadataField.value);
    advertisedVersion = metadata.find((field) => field.num === 2)?.value.toString("utf8");
    return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
  });

  const minted = await mintUserJwt(
    "synthetic-key",
    "https://devin.invalid",
    undefined,
    "3.10.35",
  );

  assert.equal(minted.jwt, "eyJtest.jwt");
  assert.equal(advertisedVersion, "3.10.35");
});

test("keys cached user JWTs by the resolved client version", async (t) => {
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  const advertisedVersions = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const envelope = fields(Buffer.from(options.body));
    const metadata = fields(envelope.find((field) => field.num === 1).value);
    advertisedVersions.push(metadata.find((field) => field.num === 2)?.value.toString("utf8"));
    return new Response(encodeMessage(1, Buffer.from(`eyJtest.jwt.${advertisedVersions.length}`)));
  });

  const first = await getCachedUserJwt("synthetic-key", "https://devin.invalid", undefined, "3.10.35");
  const cached = await getCachedUserJwt("synthetic-key", "https://devin.invalid", undefined, "3.10.35");
  const refreshed = await getCachedUserJwt("synthetic-key", "https://devin.invalid", undefined, "3.10.36");

  assert.equal(first, cached);
  assert.notEqual(first, refreshed);
  assert.deepEqual(advertisedVersions, ["3.10.35", "3.10.36"]);
});

test("does not coalesce in-flight user JWT requests across client versions", async (t) => {
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  const pending = [];
  const advertisedVersions = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const envelope = fields(Buffer.from(options.body));
    const metadata = fields(envelope.find((field) => field.num === 1).value);
    advertisedVersions.push(metadata.find((field) => field.num === 2)?.value.toString("utf8"));
    return await new Promise((resolve) => pending.push(resolve));
  });

  const first = getCachedUserJwt("synthetic-key", "https://devin.invalid", undefined, "3.10.35");
  const duplicate = getCachedUserJwt("synthetic-key", "https://devin.invalid", undefined, "3.10.35");
  const otherVersion = getCachedUserJwt("synthetic-key", "https://devin.invalid", undefined, "3.10.36");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pending.length, 2);
  assert.deepEqual(advertisedVersions, ["3.10.35", "3.10.36"]);
  pending[0](new Response(encodeMessage(1, Buffer.from("eyJtest.jwt.first"))));
  pending[1](new Response(encodeMessage(1, Buffer.from("eyJtest.jwt.other"))));
  assert.deepEqual(await Promise.all([first, duplicate, otherVersion]), [
    "eyJtest.jwt.first",
    "eyJtest.jwt.first",
    "eyJtest.jwt.other",
  ]);
});
