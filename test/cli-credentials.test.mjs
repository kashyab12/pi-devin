import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFedCli } from "../src/cli.ts";
import { credentialsPathForCli } from "../src/credentials.ts";

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
