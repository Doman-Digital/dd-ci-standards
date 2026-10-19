import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scannersFor } from "../scanners/read.mjs";

const register = JSON.parse(readFileSync(new URL("../scanners.json", import.meta.url), "utf8"));

test("scanners.json names each repo with a reason, as owner/name", () => {
  for (const [scanner, repos] of Object.entries(register.scanners)) {
    for (const [repo, reason] of Object.entries(repos)) {
      assert.match(repo, /^[\w.-]+\/[\w.-]+$/, `${scanner}: ${repo}`);
      assert.ok(typeof reason === "string" && reason.length > 20, `${scanner}: ${repo} has no reason`);
    }
  }
});

test("a listed repo gets the scanner, case aside; any other repo does not", () => {
  assert.deepEqual(scannersFor(register, "Sensphere/Sen-Sphere"), { semgrep: true });
  assert.deepEqual(scannersFor(register, "Doman-Digital/Doman-Digital"), { semgrep: false });
});
