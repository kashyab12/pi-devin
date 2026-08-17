import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { runDevin } from "./cli.js";

export interface DevinVariant {
  model_uid: string;
  label: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  cost_tier?: string;
  cost_summary?: string;
  is_new?: boolean;
  is_beta?: boolean;
}

export interface DevinFamily {
  family_label: string;
  family_uid: string;
  slug: string;
  aliases?: string[];
  variants: DevinVariant[];
}

export interface DevinCatalog {
  families: DevinFamily[];
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseCost(summary?: string): ProviderModelConfig["cost"] {
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!summary) return empty;
  const input = summary.match(/\$([0-9.]+)\s*\/\s*MTok In/i);
  const output = summary.match(/\$([0-9.]+)\s*\/\s*MTok Out/i);
  const inCost = input ? Number(input[1]) : 0;
  const outCost = output ? Number(output[1]) : 0;
  return {
    input: inCost,
    output: outCost,
    cacheRead: Number((inCost * 0.1).toFixed(4)),
    cacheWrite: Number((inCost * 1.25).toFixed(4)),
  };
}

function variantKey(uid: string): string | null {
  const suffixes = [
    "none-priority",
    "low-priority",
    "medium-priority",
    "high-priority",
    "xhigh-priority",
    "max-priority",
    "low-fast",
    "medium-fast",
    "high-fast",
    "xhigh-fast",
    "max-fast",
    "thinking-1m",
    "thinking",
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "minimal",
  ];
  for (const suffix of suffixes) {
    if (uid === suffix || uid.endsWith(`-${suffix}`)) return suffix;
  }
  return null;
}

function thinkingFromSuffix(suffix: string | null): keyof ThinkingLevelMap | null {
  if (!suffix) return "high";
  if (suffix === "none" || suffix === "none-priority") return "off";
  if (suffix === "minimal") return "minimal";
  if (suffix.startsWith("low")) return "low";
  if (suffix.startsWith("medium")) return "medium";
  if (suffix.startsWith("high") && !suffix.startsWith("xhigh")) return "high";
  if (suffix.startsWith("xhigh")) return "xhigh";
  if (suffix.startsWith("max")) return "max";
  if (suffix.includes("thinking")) return "high";
  return null;
}

function preferredDefault(map: ThinkingLevelMap): string | undefined {
  for (const level of ["high", "medium", "max", "xhigh", "low", "minimal", "off"] as const) {
    const value = map[level];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function familyToModels(family: DevinFamily): ProviderModelConfig[] {
  const usable = family.variants.filter((variant) => {
    const key = variantKey(variant.model_uid);
    return !key || (!key.includes("priority") && !key.includes("fast") && key !== "thinking-1m");
  });
  const source = usable.length > 0 ? usable : family.variants;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const variant of source) {
    const level = thinkingFromSuffix(variantKey(variant.model_uid));
    if (level && thinkingLevelMap[level] === undefined) {
      thinkingLevelMap[level] = variant.model_uid;
    }
  }

  const defaultUid = preferredDefault(thinkingLevelMap) ?? source[0]?.model_uid ?? family.family_uid;
  const sample = source.find((variant) => variant.model_uid === defaultUid) ?? source[0];
  if (!sample) return [];

  const mappedLevels = THINKING_ORDER.filter((level) => typeof thinkingLevelMap[level] === "string");
  const reasoning = mappedLevels.length > 1;

  return [
    {
      id: defaultUid,
      name: family.family_label || family.slug || defaultUid,
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
      input: ["text", "image"],
      cost: parseCost(sample.cost_summary),
      contextWindow: sample.max_context_tokens ?? 256_000,
      maxTokens: sample.max_output_tokens ?? 128_000,
    },
  ];
}

export const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-5-high",
    name: "Claude Opus 5",
    reasoning: true,
    thinkingLevelMap: {
      low: "claude-opus-5-low",
      medium: "claude-opus-5-medium",
      high: "claude-opus-5-high",
      xhigh: "claude-opus-5-xhigh",
      max: "claude-opus-5-max",
    },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5-fable-high",
    name: "Claude Fable 5",
    reasoning: true,
    thinkingLevelMap: {
      low: "claude-5-fable-low",
      medium: "claude-5-fable-medium",
      high: "claude-5-fable-high",
      xhigh: "claude-5-fable-xhigh",
      max: "claude-5-fable-max",
    },
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5-6-sol-high",
    name: "GPT-5.6 Sol",
    reasoning: true,
    thinkingLevelMap: {
      off: "gpt-5-6-sol-none",
      low: "gpt-5-6-sol-low",
      medium: "gpt-5-6-sol-medium",
      high: "gpt-5-6-sol-high",
      xhigh: "gpt-5-6-sol-xhigh",
      max: "gpt-5-6-sol-max",
    },
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "swe-1-7",
    name: "SWE-1.7",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_000,
    maxTokens: 128_000,
  },
];

export function modelsFromCatalog(catalog: DevinCatalog | null): ProviderModelConfig[] {
  if (!catalog?.families?.length) return FALLBACK_MODELS;
  const models = catalog.families.flatMap(familyToModels);
  return models.length > 0 ? models : FALLBACK_MODELS;
}

export async function loadCliCatalog(): Promise<DevinCatalog | null> {
  const { stdout, code, stderr } = await runDevin(["models", "list", "--format", "json"], {
    timeoutMs: 20_000,
  });
  if (code !== 0) {
    throw new Error(stderr.trim() || `devin models list exited ${code}`);
  }
  const parsed = JSON.parse(stdout) as DevinCatalog;
  if (!parsed?.families) return null;
  return parsed;
}

export function resolveModelUid(
  modelId: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
  reasoning?: string,
): string {
  if (reasoning && thinkingLevelMap) {
    const mapped = thinkingLevelMap[reasoning as keyof ThinkingLevelMap];
    if (typeof mapped === "string") return mapped;
  }
  if (thinkingLevelMap) {
    const fallback = preferredDefault(thinkingLevelMap);
    if (fallback) return fallback;
  }
  return modelId;
}
