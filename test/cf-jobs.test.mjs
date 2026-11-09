import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cronGapMinutes, wranglerCrons } from "../lib/rules.mjs";
import { parseCfRow, readCfJobs } from "../lib/cf-jobs.mjs";

test("cronGapMinutes is the smallest space between firings, from the minute field only", () => {
  const cases = {
    "* * * * *": 1,
    "*/2 * * * *": 2,
    "*/5 * * * *": 5,
    "*/15 * * * *": 15,
    "0 * * * *": 60,
    "0 2 * * *": 60,
    "0,30 * * * *": 30,
    "5/10 * * * *": 10,
    "0-10/3 * * * *": 3,
    "13 9 1-3 1,4,7,10 *": 60,
  };
  for (const [s, gap] of Object.entries(cases)) assert.equal(cronGapMinutes(s), gap, s);
  // Not a five-field cron this reads: no answer rather than a wrong one.
  for (const s of ["@hourly", "*/0 * * * *", "61 * * * *", "* * * *", undefined]) assert.equal(cronGapMinutes(s), null, String(s));
});

test("wranglerCrons reads triggers from jsonc and toml, every environment", () => {
  const jsonc = '{ "triggers": { "crons": ["*/5 * * * *", "0 2 * * *"] }, "env": { "staging": { "triggers": { "crons": ["* * * * *"] } } } }';
  assert.deepEqual(wranglerCrons("services/x/wrangler.jsonc", jsonc), ["*/5 * * * *", "0 2 * * *", "* * * * *"]);
  assert.deepEqual(wranglerCrons("wrangler.toml", '[triggers]\ncrons = ["*/2 * * * *"]\n'), ["*/2 * * * *"]);
  assert.deepEqual(wranglerCrons("wrangler.jsonc", '{ "name": "no-crons" }'), []);
});

test("parseCfRow reads defined_in as repo and path, drops a #environment, and keeps database and db_gate", () => {
  const row = parseCfRow([
    "id: cf.dd-checks-staging",
    "defined_in: Doman-Digital/Doman-Digital:services/checks/wrangler.jsonc#staging",
    'schedule: "* * * * *"',
    "database: none",
    'db_gate: "a gate # not a comment"',
    "purpose: nested colons: are fine",
  ].join("\n"));
  assert.deepEqual(row, { id: "cf.dd-checks-staging", repo: "Doman-Digital/Doman-Digital", path: "services/checks/wrangler.jsonc", schedule: "* * * * *", database: "none", dbGate: "a gate # not a comment", verdict: undefined });
});

test("readCfJobs reads cf.* rows and skips everything else; null when there is no registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-jobs-"));
  mkdirSync(join(dir, "jobs"));
  writeFileSync(join(dir, "jobs", "cf.demo.yaml"), 'id: cf.demo\ndefined_in: Doman-Digital/demo:wrangler.jsonc\nschedule: "*/5 * * * *"\ndatabase: none\n');
  writeFileSync(join(dir, "jobs", "gh.demo.yaml"), "id: gh.demo\nschedule: \"0 1 * * *\"\n");
  const jobs = readCfJobs(dir);
  assert.deepEqual(jobs.map((j) => j.id), ["cf.demo"]);
  assert.equal(readCfJobs(join(dir, "absent")), null);
});
