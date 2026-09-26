import assert from "node:assert/strict";
import test from "node:test";
import { FALLBACK_MODELS, modelsFromCatalog, resolveModelUid } from "../src/models.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function variant(model_uid) {
  return { model_uid, label: model_uid };
}

function family(slug, variants, family_uid = slug) {
  return { family_label: slug, family_uid, slug, variants: variants.map(variant) };
}

test("maps sparse catalog families to their family slug and hides unsupported levels", () => {
  const [model] = modelsFromCatalog({
    families: [family("swe-2", ["swe-2-high", "swe-2-medium", "swe-2-max", "swe-2-high-priority"])],
  });

  assert.equal(model.id, "swe-2");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: "swe-2-medium",
    high: "swe-2-high",
    xhigh: null,
    max: "swe-2-max",
  });
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, "medium"), "swe-2-medium");
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, "high"), "swe-2-high");
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, "max"), "swe-2-max");
  assert.ok(Object.hasOwn(model.thinkingLevelMap, "off"));
});

test("preserves every variant in a complete thinking-level family", () => {
  const [model] = modelsFromCatalog({
    families: [family("complete-family", [
      "complete-none",
      "complete-minimal",
      "complete-low",
      "complete-medium",
      "complete-high",
      "complete-xhigh",
      "complete-max",
    ])],
  });

  assert.equal(model.id, "complete-family");
  assert.deepEqual(model.thinkingLevelMap, {
    off: "complete-none",
    minimal: "complete-minimal",
    low: "complete-low",
    medium: "complete-medium",
    high: "complete-high",
    xhigh: "complete-xhigh",
    max: "complete-max",
  });
});

test("keeps the selected variant UID for non-reasoning catalog families", () => {
  const catalog = {
    families: [family("single-family", ["single-family-high"], "single-family-uid")],
  };
  const [model] = modelsFromCatalog(catalog);

  assert.equal(model.id, "single-family-high");
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(model.contextWindow, 256_000);
  assert.equal(model.maxTokens, 128_000);
});

test("fallback families expose complete maps whose supported levels resolve to model UIDs", () => {
  const expected = {
    "claude-opus-5": {
      low: "claude-opus-5-low",
      medium: "claude-opus-5-medium",
      high: "claude-opus-5-high",
      xhigh: "claude-opus-5-xhigh",
      max: "claude-opus-5-max",
    },
    "claude-fable-5": {
      low: "claude-5-fable-low",
      medium: "claude-5-fable-medium",
      high: "claude-5-fable-high",
      xhigh: "claude-5-fable-xhigh",
      max: "claude-5-fable-max",
    },
    "gpt-5.6-sol": {
      off: "gpt-5-6-sol-none",
      low: "gpt-5-6-sol-low",
      medium: "gpt-5-6-sol-medium",
      high: "gpt-5-6-sol-high",
      xhigh: "gpt-5-6-sol-xhigh",
      max: "gpt-5-6-sol-max",
    },
    "swe-1.7": {
      medium: "swe-1-7-medium",
      high: "swe-1-7",
    },
  };

  assert.deepEqual(FALLBACK_MODELS.map((model) => model.id), Object.keys(expected));
  for (const model of FALLBACK_MODELS) {
    assert.equal(model.reasoning, true);
    assert.ok(model.thinkingLevelMap);
    for (const level of THINKING_LEVELS) {
      assert.ok(Object.hasOwn(model.thinkingLevelMap, level), `${model.id} is missing ${level}`);
      const expectedUid = expected[model.id][level];
      assert.equal(model.thinkingLevelMap[level], expectedUid ?? null);
      if (expectedUid) {
        assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, level), expectedUid);
      }
    }
    assert.equal(resolveModelUid(model.id, model.thinkingLevelMap), expected[model.id].high);
  }
});
