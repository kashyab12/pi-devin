import assert from "node:assert/strict";
import test from "node:test";
import { modelsFromCatalog } from "../src/models.ts";

const cost = (cost_summary) => modelsFromCatalog({
  families: [{
    family_label: "Example", family_uid: "example", slug: "example",
    variants: [{ model_uid: "example-high", label: "Example", cost_summary }],
  }],
})[0].cost;

test("parses current Devin CLI cost summaries", () => {
  assert.deepEqual(cost("$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output"), {
    input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0,
  });
  assert.deepEqual(cost("$0.2 / 1M Input · $0.02 / 1M Cached input · $1.2 / 1M Output"), {
    input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0,
  });
});

test("preserves legacy MTok costs and cache estimates", () => {
  assert.deepEqual(cost("$5 / MTok In, $30 / MTok Out"), {
    input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25,
  });
});

test("missing summary has zero cost", () => {
  assert.deepEqual(cost(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
