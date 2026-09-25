import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDevinBinInPath } from "../src/cli.ts";
import { credentialsPath, readActiveCredentials, readCredentials, resolveStreamAuth } from "../src/credentials.ts";

test("discovers the standard CLI names on PATH without recognizing fed-specific names", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const bin = join(directory, "devin.exe");
  writeFileSync(bin, "");
  try {
    const found = findDevinBinInPath(directory, "win32");
    assert.equal(found, bin);
    rmSync(bin);
    writeFileSync(join(directory, "devin-fed.exe"), "");
    assert.equal(findDevinBinInPath(directory, "win32"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores a directory named like a Devin CLI in PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  mkdirSync(join(directory, "devin.exe"));
  try {
    assert.equal(findDevinBinInPath(directory, "win32"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses DEVIN_CREDENTIALS_PATH to read a fed credential file and its endpoint", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const credentials = join(directory, "devin-fed", "credentials.toml");
  mkdirSync(join(directory, "devin-fed"), { recursive: true });
  writeFileSync(credentials, 'api_key = "fed-key"\napi_server_url = "https://fed.example"\n');
  const previous = process.env.DEVIN_CREDENTIALS_PATH;
  process.env.DEVIN_CREDENTIALS_PATH = credentials;
  t.after(() => {
    if (previous === undefined) delete process.env.DEVIN_CREDENTIALS_PATH;
    else process.env.DEVIN_CREDENTIALS_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(credentialsPath(), credentials);
  const active = readActiveCredentials();
  assert.deepEqual(resolveStreamAuth(undefined, undefined, active), {
    apiKey: "fed-key",
    host: "https://fed.example",
  });
  assert.deepEqual(resolveStreamAuth("explicit-key", "https://custom.example/", active), {
    apiKey: "explicit-key",
    host: "https://custom.example",
  });
});

test("reads credentials from an explicitly supplied path", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const credentials = join(directory, "credentials.toml");
  writeFileSync(credentials, 'api_key = "fed-key"\napi_server_url = "https://fed.example"\n');
  try {
    assert.deepEqual(readCredentials(credentials), {
      apiKey: "fed-key",
      apiServerUrl: "https://fed.example",
      webappHost: "app.devin.ai",
      apiUrl: "https://api.devin.ai",
      path: credentials,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps explicit API keys separate from local CLI credentials", () => {
  const standardCredentials = {
    apiKey: "standard-key",
    apiServerUrl: "https://standard.example",
    webappHost: "app.devin.ai",
    apiUrl: "https://api.devin.ai",
    path: "/standard/credentials.toml",
  };
  const fedCredentials = {
    ...standardCredentials,
    apiKey: "fed-key",
    apiServerUrl: "https://fed.example",
    path: "/fed/credentials.toml",
  };

  assert.deepEqual(resolveStreamAuth("explicit-key", undefined, standardCredentials), {
    apiKey: "explicit-key",
    host: "https://server.codeium.com",
  });
  assert.deepEqual(resolveStreamAuth("explicit-key", "https://custom.example/", fedCredentials), {
    apiKey: "explicit-key",
    host: "https://custom.example",
  });
  assert.deepEqual(resolveStreamAuth("standard-key", undefined, standardCredentials), {
    apiKey: "standard-key",
    host: "https://standard.example",
  });
  assert.deepEqual(resolveStreamAuth("fed-key", undefined, fedCredentials), {
    apiKey: "fed-key",
    host: "https://fed.example",
  });
});
