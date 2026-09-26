import assert from "node:assert/strict";
import test from "node:test";
import { packThinkingSignature, signatureTypeOf, unpackThinkingSignature } from "../src/thinking.ts";

test("detects sealed and non-sealed signature types", () => {
  assert.equal(signatureTypeOf("sealed.v1.opaque"), "sealed");
  assert.equal(signatureTypeOf("opaque-signature"), "non-sealed");
});

test("packs and unpacks signatures without losing an explicit type", () => {
  assert.equal(packThinkingSignature("sealed.v1.opaque", "sealed"), "sealed.v1.opaque");
  assert.deepEqual(unpackThinkingSignature("sealed.v1.opaque"), {
    signature: "sealed.v1.opaque",
    signatureType: "sealed",
  });

  const packed = packThinkingSignature("opaque-signature", "provider-specific");
  assert.equal(packed, "provider-specific\u001fopaque-signature");
  assert.deepEqual(unpackThinkingSignature(packed), {
    signature: "opaque-signature",
    signatureType: "provider-specific",
  });
  assert.deepEqual(unpackThinkingSignature(undefined), {});
});
