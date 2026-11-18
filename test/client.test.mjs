import { test } from "node:test";
import assert from "node:assert/strict";
import { clientCommand, findClientNew, registryCandidates } from "../lib/client.mjs";

test("the registry checkout is found from DD_REGISTRY_DIR first, then the box copy, then the clone", () => {
  assert.deepEqual(registryCandidates({ DD_REGISTRY_DIR: "/r" }, "/h"), ["/r", "/h/.dd/run/dd-repo-registry", "/h/GitHub/dd-repo-registry"]);
  assert.equal(findClientNew(["/a", "/b"], (f) => f === "/b/bin/client-new.mjs"), "/b/bin/client-new.mjs");
  assert.equal(findClientNew(["/a"], () => false), null);
});

test("dd client new forwards every argument and returns the registry command's exit code", () => {
  const seen = [];
  const code = clientCommand(["new", "acme", "--intake", "/x.yaml", "--dry-run"], {
    find: () => "/reg/bin/client-new.mjs",
    run: (node, argv, opts) => { seen.push(argv); assert.equal(opts.stdio, "inherit"); return { status: 3 }; },
  });
  assert.equal(code, 3);
  assert.deepEqual(seen, [["/reg/bin/client-new.mjs", "acme", "--intake", "/x.yaml", "--dry-run"]]);
});

test("a missing checkout or a missing slug is a usage error that names the fix", () => {
  const out = [];
  assert.equal(clientCommand(["new", "acme"], { find: () => null, err: (m) => out.push(m) }), 2);
  assert.match(out[0], /Clone Doman-Digital\/dd-repo-registry/);
  assert.equal(clientCommand(["new"], { err: (m) => out.push(m) }), 2);
  assert.equal(clientCommand(["old", "x"], { err: (m) => out.push(m) }), 2);
});
