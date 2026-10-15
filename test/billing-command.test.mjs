import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import extension from "../extensions/index.ts";

async function setup(t, { credentials = true } = {}) {
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const read = fs.readFileSync;
  const exists = fs.existsSync;
  const isCredentials = (path) => String(path).replaceAll("\\", "/").endsWith("devin/credentials.toml");
  t.mock.method(fs, "readFileSync", (path, ...args) => isCredentials(path)
    ? 'api_key = "synthetic-test-key"\n' : read(path, ...args));
  t.mock.method(fs, "existsSync", (path) => isCredentials(path) ? credentials : exists(path));
  syncBuiltinESMExports();
  const commands = {};
  const hooks = {};
  const notifications = [];
  const pi = {
    registerProvider() {},
    registerCommand(name, command) { commands[name] = command; },
    on(name, handler) { hooks[name] = handler; },
  };
  await extension(pi);
  const ctx = { ui: { notify(text, level) { notifications.push({ text, level }); } } };
  t.after(async () => {
    await hooks.session_shutdown?.();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  });
  assert.ok(commands["devin-usage"]);
  return { run: () => commands["devin-usage"].handler("", ctx), notifications };
}

function mockBilling(t) {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-test-key");
    if (url.endsWith("users/current-membership")) {
      return Response.json({ org: { org_id: "org-0123456789abcdef" } });
    }
    if (url.endsWith("billing/quota/usage")) {
      return Response.json({ is_quota_plan: true, has_quota_allocation: true, daily_percentage: 0, weekly_percentage: 11 });
    }
    if (url.endsWith("billing/status")) return Response.json({ plan_slug: "pro" });
    if (url.endsWith("billing/quota/my-on-demand-usage")) return Response.json({ amount: 0 });
    assert.fail("Unexpected network request");
  });
  return () => calls;
}

test("offline mode and missing login make no network requests", async (t) => {
  const x = await setup(t, { credentials: false });
  const calls = mockBilling(t);
  await x.run();
  assert.match(x.notifications.at(-1).text, /offline mode/);
  process.env.PI_OFFLINE = "0";
  await x.run();
  assert.match(x.notifications.at(-1).text, /Not signed in/);
  assert.equal(calls(), 0);
});

test("renders usage only through UI and prevents concurrent duplicate requests", async (t) => {
  const x = await setup(t);
  const calls = mockBilling(t);
  process.env.PI_OFFLINE = "0";
  const first = x.run();
  await x.run();
  await first;
  assert.match(x.notifications[0].text, /already running/);
  assert.equal(x.notifications.at(-1).level, "info");
  assert.match(x.notifications.at(-1).text, /Weekly: 11% used/);
  assert.equal(calls(), 4);
  await x.run();
  assert.equal(calls(), 8);
});

test("membership failures do not leak errors and permit retry", async (t) => {
  const x = await setup(t);
  process.env.PI_OFFLINE = "0";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("synthetic-secret"); });
  await x.run();
  assert.equal(x.notifications.at(-1).level, "error");
  assert.doesNotMatch(x.notifications.at(-1).text, /synthetic-secret/);
  mockBilling(t);
  await x.run();
  assert.equal(x.notifications.at(-1).level, "info");
});

test("partial results are displayed as a warning", async (t) => {
  const x = await setup(t);
  process.env.PI_OFFLINE = "0";
  t.mock.method(globalThis, "fetch", async (url) => url.endsWith("users/current-membership")
    ? Response.json({ org: { org_id: "org-0123456789abcdef" } })
    : new Response(null, { status: 403 }));
  await x.run();
  assert.equal(x.notifications.at(-1).level, "warning");
  assert.match(x.notifications.at(-1).text, /Quota unavailable/);
});
