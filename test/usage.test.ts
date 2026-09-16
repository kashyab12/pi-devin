import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { clearCachedUserJwt } from "../src/jwt.js";
import { streamDevin } from "../src/stream.js";
import { encodeMessage, encodeString, encodeTag, encodeVarintField, frameConnectStream } from "../src/wire.js";
import { calculateUsageTotal } from "../src/usage.js";

function encodeFixed32Field(fieldNum: number, value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value, 0);
  return Buffer.concat([encodeTag(fieldNum, 5), bytes]);
}

function encodeUsageMetric(name: string, value: number): Buffer {
  const metric = Buffer.concat([
    encodeString(5, name),
    encodeMessage(4, encodeFixed32Field(2, value)),
  ]);
  return encodeMessage(2, metric);
}

function encodeEndOfStreamFrame(): Buffer {
  const payload = Buffer.from("{}");
  const header = Buffer.alloc(5);
  header[0] = 0x02;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function createUsageResponse(): Response {
  const usage = Buffer.concat([
    encodeUsageMetric("input_tokens", 461),
    encodeUsageMetric("output_tokens", 262),
    encodeUsageMetric("cached_input_tokens", 228_162),
    encodeUsageMetric("cache_creation_input_tokens", 17),
  ]);
  const chatFrame = Buffer.concat([encodeMessage(28, usage), encodeVarintField(5, 0)]);
  const body = Buffer.concat([frameConnectStream(chatFrame, false), encodeEndOfStreamFrame()]);
  return new Response(new Uint8Array(body), { status: 200 });
}

test("includes cached input and cache creation tokens in the context total", () => {
  assert.equal(
    calculateUsageTotal({
      promptTokens: 461,
      completionTokens: 262,
      cachedInputTokens: 228_162,
      cacheCreationInputTokens: 17,
    }),
    228_902,
  );
});

test("treats missing usage components as zero", () => {
  assert.equal(calculateUsageTotal({ promptTokens: 12 }), 12);
});

test("carries all Devin usage components into the final assistant message", async () => {
  const originalFetch = globalThis.fetch;
  const model: Model<"devin-local"> = {
    id: "test-model",
    name: "Test model",
    api: "devin-local",
    provider: "devin",
    baseUrl: "https://server.codeium.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };

  clearCachedUserJwt();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/exa.auth_pb.AuthService/GetUserJwt")) {
      return new Response(new Uint8Array(encodeMessage(1, Buffer.from("eyJtest.jwt"))), { status: 200 });
    }
    if (url.endsWith("/exa.api_server_pb.ApiServerService/GetChatMessage")) {
      return createUsageResponse();
    }
    throw new Error(`Unexpected test request: ${url}`);
  };

  try {
    const stream = streamDevin(model, { messages: [] }, { apiKey: "test-api-key" });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();
    assert.equal(result.stopReason, "stop");
    assert.equal(result.usage.input, 461);
    assert.equal(result.usage.output, 262);
    assert.equal(result.usage.cacheRead, 228_162);
    assert.equal(result.usage.cacheWrite, 17);
    assert.equal(result.usage.totalTokens, 228_902);
  } finally {
    globalThis.fetch = originalFetch;
    clearCachedUserJwt();
  }
});
