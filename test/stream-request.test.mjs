import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clearCachedUserJwt } from "../src/jwt.ts";
import { streamDevin } from "../src/stream.ts";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields } from "../src/wire.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "devin-local",
  provider: "devin",
  baseUrl: "https://devin.invalid",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_000,
  maxTokens: 1_000,
};
const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const user = (content) => ({ role: "user", content, timestamp: 1 });
const fields = (buffer) => [...iterFields(buffer)];
const messages = (request) => request.filter((field) => field.num === 3).map((field) => fields(field.value));
const stringField = (fields, number) => fields.find((field) => field.num === number)?.value.toString("utf8");

function response(body) {
  // Connect's end-of-stream frame contains the JSON trailer {}.
  return new Response(Buffer.concat([frameConnectStream(body, false), Buffer.from([2, 0, 0, 0, 2, 123, 125])]));
}

function mockDevin(t, replies = [Buffer.concat([encodeString(3, "OK"), encodeVarintField(5, 0)])]) {
  const requests = [];
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    assert.equal(url, "https://devin.invalid/exa.api_server_pb.ApiServerService/GetChatMessage");
    const frame = Buffer.from(options.body);
    assert.equal(frame[0], 1, "request uses Connect gzip compression");
    assert.equal(frame.readUInt32BE(1), frame.length - 5);
    requests.push(fields(gunzipSync(frame.subarray(5))));
    const reply = replies[requests.length - 1];
    assert.ok(reply, "unexpected extra chat request");
    return response(reply);
  });
  return requests;
}

async function complete(context, extraOptions) {
  const stream = streamDevin(model, context, {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    ...extraOptions,
  });
  for await (const event of stream) {
    assert.notEqual(event.type, "error", event.error?.errorMessage);
  }
  return stream.result();
}

// #7: verify the normalized transcript survives the complete request-encoding path.
test("encodes the current system prompt once in field 2, with unchanged user text and images", async (t) => {
  const requests = mockDevin(t);
  const text = "  Inspect this: <system>literal user text</system>\nこんにちは  ";
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2UtZml4dHVyZQ==" };
  const context = normalizeContext({
    systemPrompt: "Initial instructions.",
    tools: [readTool],
    messages: [user([{ type: "text", text }, image])],
  });
  const tools = Array.from({ length: 90 }, (_, i) => ({ ...readTool, name: `read_${i}` }));
  context.messages.push({
    role: "system",
    content: "Updated instructions.",
    sections: { policy: "Do not edit." },
    toolsRemoved: [{ name: "read" }],
    toolsAdded: tools,
    timestamp: 2,
  });
  await complete(context);
  assert.equal(requests.length, 1);
  const request = requests[0];
  const promptFields = request.filter((field) => field.num === 2);
  assert.equal(promptFields.length, 1);
  assert.equal(promptFields[0].wire, 2);
  assert.equal(promptFields[0].value.toString(), "Initial instructions.\n\nUpdated instructions.\n\nDo not edit.");
  const history = messages(request);
  assert.equal(history.length, 1);
  assert.equal(history[0].find((field) => field.num === 2).value, 1n);
  assert.equal(stringField(history[0], 3), text);
  const images = history[0].filter((field) => field.num === 10);
  assert.equal(images.length, 1);
  assert.equal(stringField(fields(images[0].value), 1), image.data);
  assert.equal(stringField(fields(images[0].value), 2), image.mimeType);
  assert.deepEqual(request.filter((field) => field.num === 10).map((field) => {
    const definition = fields(field.value);
    return { name: stringField(definition, 1), description: stringField(definition, 2), parameters: JSON.parse(stringField(definition, 3)) };
  }), tools);
});

test("omits an empty system prompt while preserving tools and user content", async (t) => {
  const requests = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "", tools: [readTool], messages: [user("Read probe.txt")] }));
  assert.equal(requests[0].filter((field) => field.num === 2).length, 0);
  assert.equal(requests[0].filter((field) => field.num === 10).length, 1);
  assert.deepEqual(messages(requests[0]).map((message) => stringField(message, 3)), ["Read probe.txt"]);
});

test("sends a system-only transcript without inventing a user message", async (t) => {
  const requests = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "System-only instructions.", messages: [] }));
  assert.equal(stringField(requests[0], 2), "System-only instructions.");
  assert.deepEqual(messages(requests[0]), []);
});

test("encodes an empty transcript without a prompt or history", async (t) => {
  const requests = mockDevin(t);
  await complete(normalizeContext({ messages: [] }));
  assert.equal(stringField(requests[0], 2), undefined);
  assert.deepEqual(messages(requests[0]), []);
});

test("retains the system prompt and replays assistant tool calls and results on the next request", async (t) => {
  const callId = "call-read";
  const args = { path: "probe.txt" };
  const requests = mockDevin(t, [
    Buffer.concat([
      encodeMessage(6, Buffer.concat([encodeString(1, callId), encodeString(2, "read"), encodeString(3, JSON.stringify(args))])),
      encodeVarintField(5, 10),
    ]),
    Buffer.concat([encodeString(3, "file-value"), encodeVarintField(5, 0)]),
  ]);
  const context = normalizeContext({ systemPrompt: "Use tools; never guess.", tools: [readTool], messages: [user("Read probe.txt")] });
  const first = await complete(context);
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual(first.content, [{ type: "toolCall", id: callId, name: "read", arguments: args }]);
  context.messages.push(first, {
    role: "toolResult", toolCallId: callId, toolName: "read",
    content: [{ type: "text", text: "file-value" }], isError: false, timestamp: 3,
  });
  const second = await complete(context);
  assert.equal(second.stopReason, "stop");
  assert.equal(second.content[0].text, "file-value");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.filter((field) => field.num === 2).length, 1);
    assert.equal(stringField(request, 2), "Use tools; never guess.");
  }
  const history = messages(requests[1]);
  assert.deepEqual(history.map((message) => message.find((field) => field.num === 2).value), [1n, 2n, 4n]);
  assert.equal(stringField(history[0], 3), "Read probe.txt");
  const call = fields(history[1].find((field) => field.num === 6).value);
  assert.equal(stringField(call, 1), callId);
  assert.equal(stringField(call, 2), "read");
  assert.deepEqual(JSON.parse(stringField(call, 3)), args);
  assert.equal(stringField(history[2], 7), callId);
  assert.equal(stringField(history[2], 3), "file-value");
});

// #599: the provider must honor the SDK's admission hooks. An onPayload that
// throws must produce NO protected send (no GetChatMessage fetch). onResponse
// must observe the HTTP response. A non-undefined onPayload return is a
// mutation we cannot apply to a binary body — it must refuse, not send anyway.
test("a denied onPayload produces no protected send", async (t) => {
  let fetchCalls = 0;
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url) => {
    // The JWT/auth fetch is allowed; only the chat send must be denied.
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    fetchCalls += 1;
    return response(Buffer.concat([encodeString(3, "SHOULD-NOT-SEND"), encodeVarintField(5, 0)]));
  });
  const context = normalizeContext({ systemPrompt: "s", messages: [user("deny me")] });
  const stream = streamDevin(model, context, {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    onPayload: () => { throw new Error("denied by admission"); },
  });
  for await (const _ of stream) { /* drain */ }
  const result = await stream.result();
  assert.equal(fetchCalls, 0, "denied request must not reach the transport");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /denied by admission/);
});

test("onPayload returning a replacement refuses (binary body cannot be rewritten)", async (t) => {
  let fetchCalls = 0;
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    fetchCalls += 1;
    return response(Buffer.concat([encodeString(3, "X"), encodeVarintField(5, 0)]));
  });
  const context = normalizeContext({ systemPrompt: "s", messages: [user("mutate me")] });
  const stream = streamDevin(model, context, {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    onPayload: () => ({ tampered: true }),
  });
  for await (const _ of stream) { /* drain */ }
  const result = await stream.result();
  assert.equal(fetchCalls, 0);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /cannot apply|refuse/i);
});

test("onResponse observes the HTTP response and onPayload sees the descriptor", async (t) => {
  const requests = mockDevin(t);
  const seen = { payload: null, status: null };
  const context = normalizeContext({ systemPrompt: "sys", tools: [readTool], messages: [user("hi")] });
  await complete(context, {
    onPayload: (payload) => { seen.payload = payload; return undefined; },
    onResponse: (resp) => { seen.status = resp.status; },
  });
  assert.equal(requests.length, 1);
  assert.equal(seen.status, 200);
  assert.ok(seen.payload && seen.payload.endpoint.includes("GetChatMessage"));
  assert.equal(seen.payload.provider, "devin");
  assert.equal(seen.payload.messageCount, 1);
  assert.equal(seen.payload.toolCount, 1);
  // Content rules need the semantic request, not just counts — the
  // descriptor carries the mapped messages/tools but no wire secrets.
  assert.equal(seen.payload.messages.length, 1);
  assert.equal(seen.payload.tools.length, 1);
  assert.equal(seen.payload.tools[0].name, "read");
  assert.deepEqual(
    Object.keys(seen.payload).filter((k) => /apikey|jwt|secret|proto/i.test(k)),
    [],
  );
});

test("an onResponse denial cancels the response body and propagates", async (t) => {
  let canceled = 0;
  const requests = [];
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    requests.push(url);
    return new Response(
      new ReadableStream({ cancel() { canceled += 1; } }),
      { status: 200 },
    );
  });
  const context = normalizeContext({ systemPrompt: "s", messages: [user("hi")] });
  const stream = streamDevin(model, context, {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    onResponse: () => { throw new Error("response denied"); },
  });
  for await (const _ of stream) { /* drain */ }
  const result = await stream.result();
  assert.equal(requests.length, 1);
  assert.equal(canceled, 1, "denied response body must be canceled");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /response denied/);
});

test("options.fetch is used for BOTH auth and chat sends", async (t) => {
  const calls = [];
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  const injected = async (url, opts) => {
    calls.push(url);
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    return response(Buffer.concat([encodeString(3, "OK"), encodeVarintField(5, 0)]));
  };
  // Do NOT mock globalThis.fetch — prove the injected fetch is used even when
  // the global would fail.
  const context = normalizeContext({ systemPrompt: "s", messages: [user("hi")] });
  await complete(context, { fetch: injected });
  assert.ok(calls.some((u) => u.includes("GetUserJwt")), "auth must use injected fetch");
  assert.ok(calls.some((u) => u.includes("GetChatMessage")), "chat must use injected fetch");
});

test("caller headers cannot override required Connect framing (any casing)", async (t) => {
  const seenHeaders = [];
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    const h = opts?.headers || {};
    seenHeaders.push(Array.isArray(h) ? Object.fromEntries(h) : h);
    return response(Buffer.concat([encodeString(3, "OK"), encodeVarintField(5, 0)]));
  });
  const context = normalizeContext({ systemPrompt: "s", messages: [user("hi")] });
  await complete(context, {
    headers: { "content-type": "text/evil", "x-custom": "ok", "connect-protocol-version": "99" },
  });
  const sent = seenHeaders[0];
  const REQUIRED = new Set([
    "content-type", "connect-protocol-version",
    "connect-content-encoding", "connect-accept-encoding",
  ]);
  const CANONICAL = new Set([
    "Content-Type", "Connect-Protocol-Version",
    "Connect-Content-Encoding", "Connect-Accept-Encoding",
  ]);
  // Assert on raw entries: lowercasing into a map would collapse a smuggled
  // duplicate (e.g. "content-type" + "Content-Type") into one winner.
  const entries = Object.entries(sent);
  const forbidden = entries.filter(
    ([k]) => REQUIRED.has(k.toLowerCase()) && !CANONICAL.has(k),
  );
  assert.deepEqual(forbidden, [], "caller-cased variants of required names must not reach the wire");
  for (const [name, want] of [
    ["Content-Type", "application/connect+proto"],
    ["Connect-Protocol-Version", "1"],
    ["Connect-Content-Encoding", "gzip"],
    ["Connect-Accept-Encoding", "gzip"],
  ]) {
    assert.equal(sent[name], want, `${name} must be the required value`);
    assert.equal(entries.filter(([k]) => k === name).length, 1, `${name} must appear exactly once`);
  }
  assert.equal(sent["x-custom"], "ok");
});
