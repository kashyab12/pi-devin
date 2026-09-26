/**
 * Devin streams thinking as a summary (`delta_thinking`) plus an opaque
 * `delta_signature` and `delta_signature_type`. The signature lets the server
 * verify and continue a reasoning trace, so it must be replayed with the summary
 * on the next request.
 *
 * Pi stores one opaque string per thinking block (`thinkingSignature`). The
 * signature type rides along in that string only when it cannot be derived from
 * the signature itself.
 */

const TYPE_SEPARATOR = "\u001f";

export interface ChatThinking {
  /** Thinking summary sent by the server. */
  text: string;
  /** Opaque signature for server-side verification and continuation. */
  signature: string;
  /** `signature_type` reported by the server. */
  signatureType?: string;
  /** Whether the server marked the trace as redacted. */
  redacted?: boolean;
}

export function signatureTypeOf(signature: string): string {
  return signature.startsWith("sealed.") ? "sealed" : "non-sealed";
}

/** Store the signature in pi's `thinkingSignature` without losing its type. */
export function packThinkingSignature(signature: string, signatureType?: string): string {
  if (!signatureType || signatureType === signatureTypeOf(signature)) return signature;
  return `${signatureType}${TYPE_SEPARATOR}${signature}`;
}

export function unpackThinkingSignature(value: string | undefined): {
  signature?: string;
  signatureType?: string;
} {
  if (!value) return {};
  const index = value.indexOf(TYPE_SEPARATOR);
  if (index === -1) return { signature: value, signatureType: signatureTypeOf(value) };
  return { signatureType: value.slice(0, index), signature: value.slice(index + 1) };
}
