const BILLING_ORIGIN = "https://app.devin.ai";
const MAX_RESPONSE_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface BillingUsage {
  quota?: {
    dailyPercentage: number;
    weeklyPercentage: number;
    dailyResetAt?: string;
    weeklyResetAt?: string;
    hideDaily: boolean;
  };
  status?: {
    plan?: string;
    subscriptionValid?: boolean;
    usesQuota?: boolean;
  };
  onDemand?: { amount: number; cycleStart?: string; cycleEnd?: string };
  warnings: string[];
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected billing response format");
  }
  return value as JsonObject;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Unexpected billing numeric value");
  }
  return value;
}

function date(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Fetch account billing only on explicit request. Never return membership PII. */
export async function loadBillingUsage(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BillingUsage> {
  const deadline = AbortSignal.timeout(20_000);
  async function get(path: string): Promise<JsonObject> {
    let response: Response;
    try {
      response = await fetchImpl(`${BILLING_ORIGIN}/api/${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        redirect: "error",
        signal: deadline,
      });
    } catch {
      throw new Error("Billing request failed or timed out");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Billing request returned HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new Error("Billing endpoint did not return JSON");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty billing response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("Billing response exceeds size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    try {
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new Error("Unexpected billing response format");
    }
  }

  const membership = await get("users/current-membership");
  const orgId = object(membership.org).org_id;
  if (typeof orgId !== "string" || !/^org-[a-f0-9]+$/.test(orgId)) {
    throw new Error("Membership response contains no supported organization ID");
  }

  const result: BillingUsage = { warnings: [] };
  const sections = await Promise.allSettled([
    get(`${orgId}/billing/quota/usage`).then((data) => {
      if (data.is_quota_plan !== true || data.has_quota_allocation !== true) {
        throw new Error("No allocated quota plan");
      }
      result.quota = {
        dailyPercentage: finiteNumber(data.daily_percentage),
        weeklyPercentage: finiteNumber(data.weekly_percentage),
        dailyResetAt: date(data.daily_reset_at),
        weeklyResetAt: date(data.weekly_reset_at),
        hideDaily: data.hide_daily_quota === true,
      };
    }),
    get(`${orgId}/billing/status`).then((data) => {
      result.status = {
        plan: typeof data.plan_slug === "string" && /^[a-z0-9_-]{1,64}$/i.test(data.plan_slug)
          ? data.plan_slug : undefined,
        subscriptionValid: typeof data.is_subscription_valid === "boolean"
          ? data.is_subscription_valid : undefined,
        usesQuota: typeof data.uses_quota === "boolean" ? data.uses_quota : undefined,
      };
    }),
    get(`${orgId}/billing/quota/my-on-demand-usage`).then((data) => {
      result.onDemand = {
        amount: finiteNumber(data.amount),
        cycleStart: date(data.cycle_start),
        cycleEnd: date(data.cycle_end),
      };
    }),
  ]);
  const names = ["Quota", "Plan", "On-demand"];
  sections.forEach((section, index) => {
    if (section.status === "rejected") {
      // Do not expose server bodies, tokens, membership data, or arbitrary errors.
      result.warnings.push(`${names[index]} unavailable`);
    }
  });
  return result;
}

export function formatBillingUsage(usage: BillingUsage): string {
  const lines = ["Devin usage (account quota, not this Pi session)"];
  if (usage.status) {
    const status = usage.status;
    if (status.plan) lines.push(`Plan: ${status.plan}`);
    if (status.subscriptionValid !== undefined) {
      lines.push(`Subscription: ${status.subscriptionValid ? "valid" : "not valid"}`);
    }
    if (status.usesQuota === false) lines.push("This plan does not use quotas.");
  }
  const reset = (value?: string): string => value
    ? ` — resets ${new Date(value).toLocaleString()} (local time)` : "";
  if (usage.quota) {
    if (!usage.quota.hideDaily) {
      lines.push(`Daily: ${usage.quota.dailyPercentage}% used${reset(usage.quota.dailyResetAt)}`);
    }
    lines.push(`Weekly: ${usage.quota.weeklyPercentage}% used${reset(usage.quota.weeklyResetAt)}`);
  }
  if (usage.onDemand) {
    const demand = usage.onDemand;
    lines.push(demand.amount === 0
      ? "Your on-demand usage: 0 in this billing cycle"
      : `Your on-demand usage: ${demand.amount} (API amount; unit unverified)`);
    if (demand.cycleStart && demand.cycleEnd) {
      lines.push(`Billing cycle: ${demand.cycleStart} – ${demand.cycleEnd}`);
    }
  }
  lines.push(...usage.warnings);
  return lines.join("\n");
}
