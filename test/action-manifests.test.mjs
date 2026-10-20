import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// GitHub evaluates ${{ }} in an action's description and input descriptions
// too, so an example written there with braces stops the action loading in
// every caller: workspace-scope did, on 20 October 2026.
const ROOT = new URL("..", import.meta.url).pathname;
function manifests(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") manifests(p, out);
    else if (/^action\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

test("no action description holds an expression", () => {
  const found = manifests(ROOT);
  assert.ok(found.length >= 4, `found ${found.length} action manifests`);
  for (const file of found) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inDesc = false, indent = 0;
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)description:\s*(.*)$/);
      if (m) { inDesc = /^[|>]/.test(m[2]); indent = m[1].length; assert.ok(!m[2].includes("${{"), `${file}:${i + 1}`); return; }
      if (inDesc) {
        if (line.trim() && line.match(/^(\s*)/)[1].length <= indent) { inDesc = false; return; }
        assert.ok(!line.includes("${{"), `${file}:${i + 1}: an expression inside a description`);
      }
    });
  }
});
