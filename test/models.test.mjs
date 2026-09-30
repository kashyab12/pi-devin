import assert from "node:assert/strict";
import test from "node:test";
import { modelsFromCatalog } from "../src/models.ts";

test("does not expose CLI-only routers or fusion compositions as chat models", () => {
  const catalog = {
    families: [
      {
        family_label: "Adaptive",
        family_uid: "Adaptive",
        slug: "adaptive",
        variants: [{ model_uid: "adaptive", label: "Adaptive" }],
      },
      {
        family_label: "Fusion",
        family_uid: "Fusion",
        slug: "fusion",
        variants: [
          { model_uid: "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium", label: "Fusion" },
          { model_uid: "fusion-claude-fable-5-1-medium-sidekick-gpt-5-6-luna-high", label: "Fusion" },
        ],
      },
      {
        family_label: "Test",
        family_uid: "test",
        slug: "test",
        variants: [{ model_uid: "test-high", label: "Test high" }],
      },
    ],
  };
  assert.deepEqual(modelsFromCatalog(catalog).map((model) => model.id), ["test-high"]);
});
