import assert from "node:assert/strict";
import test from "node:test";
import { mintUserJwt } from "../src/jwt.ts";

test("falls back to an empty JWT when the server disables JWT tokens", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("JWT tokens not enabled", { status: 501 }));
  const startedAt = Math.floor(Date.now() / 1000);
  const result = await mintUserJwt("test-key", "https://fed.example");
  assert.equal(result.jwt, "");
  assert.ok(result.expiresAt >= startedAt + 300 && result.expiresAt <= startedAt + 301);
});

test("does not apply the JWT fallback to unrelated 501 responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("service unavailable", { status: 501 }));
  await assert.rejects(mintUserJwt("test-key", "https://fed.example"), /GetUserJwt HTTP 501: service unavailable/);
});
