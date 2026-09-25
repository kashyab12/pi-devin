import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDevinBinInPath, isFedCli } from "../src/cli.ts";
import { credentialsPathForCli, readCredentials, resolveStreamAuth } from "../src/credentials.ts";

test("recognizes fed CLI paths on Windows and POSIX", () => {
  assert.equal(isFedCli("C:\\Users\\nick\\AppData\\Local\\devin\\devin-fed\\bin\\devin-fed.exe"), true);
  assert.equal(isFedCli("/home/nick/.local/bin/devin"), false);
});

test("recognizes a Herdr-compatible wrapper that forwards to devin-fed", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const wrapper = join(directory, "devin.cmd");
  writeFileSync(wrapper, '@echo off\n"C:\\devin-fed.exe" %*\n');
  try {
    assert.equal(isFedCli(wrapper), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps ordinary Devin wrappers on the standard credential path", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const wrapper = join(directory, "devin.cmd");
  writeFileSync(wrapper, '@echo off\n"C:\\devin.exe" %*\n');
  try {
    assert.equal(isFedCli(wrapper), false);
    assert.match(credentialsPathForCli(wrapper), /\.local[\\/]share[\\/]devin[\\/]credentials\.toml$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selects the fed credential path for the fed CLI", () => {
  assert.match(
    credentialsPathForCli("C:\\Users\\nick\\AppData\\Local\\devin\\devin-fed\\bin\\devin-fed.exe"),
    /devin[\\/]devin-fed[\\/]credentials\.toml$/,
  );
  assert.match(
    credentialsPathForCli("/home/nick/.local/bin/devin"),
    /\.local[\\/]share[\\/]devin[\\/]credentials\.toml$/,
  );
});

test("discovers a PATH-only fed CLI before choosing its credential store", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const bin = join(directory, "devin-fed.exe");
  writeFileSync(bin, "");
  try {
    const found = findDevinBinInPath(directory, "win32");
    assert.equal(found, bin);
    assert.equal(isFedCli(found), true);
    assert.match(credentialsPathForCli(found), /devin[\\/]devin-fed[\\/]credentials\.toml$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores a directory named like a Devin CLI in PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  mkdirSync(join(directory, "devin-fed.exe"));
  try {
    assert.equal(findDevinBinInPath(directory, "win32"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads API credentials from a fed credential file", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-"));
  const credentials = join(directory, "devin-fed", "credentials.toml");
  mkdirSync(join(directory, "devin-fed"), { recursive: true });
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
