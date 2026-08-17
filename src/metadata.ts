import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from "./wire.js";

const DEFAULT_VERSION = "3000.4.25";

export interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  version?: string;
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.version ?? DEFAULT_VERSION;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const parts: Buffer[] = [
    encodeString(1, "devin"),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeVarintField(9, input.requestId),
    encodeString(10, input.sessionId),
    encodeString(12, "devin"),
    encodeMessage(16, encodeTimestampBody()),
    encodeString(25, input.triggerId),
    encodeString(26, "Unset"),
    encodeString(28, "devin"),
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}
