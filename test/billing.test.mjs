import assert from "node:assert/strict";
import test from "node:test";
import { formatBillingUsage, loadBillingUsage } from "../src/billing.ts";

const orgId = "org-0123456789abcdef";
const fixtures = {
  "users/current-membership": { org: { org_id: orgId }, user: { email: "private@example.invalid" } },
  [`${orgId}/billing/quota/usage`]: {
    is_quota_plan: true, has_quota_allocation: true,
    daily_percentage: 0, weekly_percentage: 11,
    daily_reset_at: "2026-10-16T00:00:00-08:00",
    weekly_reset_at: "2026-10-18T00:00:00-08:00",
  },
  [`${orgId}/billing/status`]: { plan_slug: "pro", is_subscription_valid: true, uses_quota: true },
  [`${orgId}/billing/quota/my-on-demand-usage`]: {
    amount: 0, cycle_start: "2026-09-23T15:11:41Z", cycle_end: "2026-10-23T15:11:41Z",
  },
};

function mockFetch(
  override = {},
  inspect,
) {
  return (async (input, init) => {
    const url = new URL(String(input));
    inspect?.(url, init);
    const path = url.pathname.slice("/api/".length);
    assert.ok(path in fixtures, `Unexpected request: ${path}`);
    const data = path in override ? override[path] : fixtures[path];
    if (data instanceof Error) throw data;
    if (data instanceof Response) return data;
    return Response.json(data);
  });
}

test("uses pinned origin, safe requests and dynamic org without returning PII", async () => {
  let calls = 0;
  const usage = await loadBillingUsage("test-secret", mockFetch({}, (url, init) => {
    calls++;
    assert.equal(url.origin, "https://app.devin.ai");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-secret");
    assert.ok(init?.signal);
  }));
  assert.equal(calls, 4);
  assert.equal(usage.quota?.weeklyPercentage, 11);
  assert.equal(usage.quota?.dailyResetAt, "2026-10-16T08:00:00.000Z");
  assert.deepEqual(usage.warnings, []);
  const text = formatBillingUsage(usage);
  assert.match(text, /Daily: 0% used/);
  assert.match(text, /Weekly: 11% used/);
  assert.match(text, /Your on-demand usage: 0/);
  assert.doesNotMatch(JSON.stringify(usage), /private@example|test-secret|org_id/);
});

test("rejects path injection in organization before billing requests", async () => {
  let calls = 0;
  await assert.rejects(loadBillingUsage("test", mockFetch({
    "users/current-membership": { org: { org_id: "../other-host" } },
  }, () => { calls++; })), /organization ID/);
  assert.equal(calls, 1);
});

test("retains partial results and suppresses raw failure text", async () => {
  const usage = await loadBillingUsage("test", mockFetch({
    [`${orgId}/billing/quota/usage`]: new Error("secret-token"),
    [`${orgId}/billing/status`]: new Response("private server error", { status: 403 }),
  }));
  assert.equal(usage.onDemand?.amount, 0);
  assert.deepEqual(usage.warnings, ["Quota unavailable", "Plan unavailable"]);
  assert.doesNotMatch(formatBillingUsage(usage), /secret-token|private server error/);
});

test("rejects malformed quotas and does not invent currency units", async () => {
  const usage = await loadBillingUsage("test", mockFetch({
    [`${orgId}/billing/quota/usage`]: { is_quota_plan: true, has_quota_allocation: true, daily_percentage: -1, weekly_percentage: "11" },
    [`${orgId}/billing/quota/my-on-demand-usage`]: { amount: 1.25 },
  }));
  assert.equal(usage.quota, undefined);
  assert.match(formatBillingUsage(usage), /1.25 \(API amount; unit unverified\)/);
});

test("honors hidden daily quota", () => {
  const text = formatBillingUsage({ quota: { dailyPercentage: 0, weeklyPercentage: 11, hideDaily: true }, warnings: [] });
  assert.doesNotMatch(text, /Daily:/);
  assert.match(text, /Weekly:/);
});

test("rejects oversized and non-JSON membership responses", async () => {
  await assert.rejects(loadBillingUsage("test", mockFetch({
    "users/current-membership": Response.json({ padding: "x".repeat(256 * 1024) }),
  })), /size limit/);
  await assert.rejects(loadBillingUsage("test", mockFetch({
    "users/current-membership": new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
  })), /did not return JSON/);
});
