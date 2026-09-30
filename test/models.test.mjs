import assert from "node:assert/strict";
import test from "node:test";
import { modelsFromCatalog } from "../src/models.ts";

function catalogWithCost(cost_summary) {
  return {
    families: [
      {
        family_label: "Test",
        family_uid: "test",
        slug: "test",
        variants: [{ model_uid: "test-high", label: "Test high", cost_summary }],
      },
    ],
  };
}

test("parses the current Devin CLI cost summary format", () => {
  const [model] = modelsFromCatalog(
    catalogWithCost("$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output"),
  );
  assert.deepEqual(model.cost, { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.625 });
});

test("continues to parse the legacy Devin CLI cost summary format", () => {
  const [model] = modelsFromCatalog(catalogWithCost("$1/MTok In, $2/MTok Out"));
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
});
