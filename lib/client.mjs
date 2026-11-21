// dd client new <slug>: forwards to dd-repo-registry's bin/client-new.mjs (DOM-999, DOM-18147).
//
// The step table, the detectors, the registry edit and the sweep rules live in dd-repo-registry because they read its
// registers (registry.yaml, access-standard.yaml, costs.yaml, creds.yaml). This file only finds a checkout of it and
// hands over the arguments, so there is one copy of the logic.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a registry checkout may be, in order: DD_REGISTRY_DIR, then for a read-only run the box's job copy and the usual
 * clone, and for a run that writes (no --dry-run, --checklist or --json) the clone first and never the job copy: that is
 * reset to origin/main on every refresh, so a branch or an edit made there is lost (DOM-18189).
 */
export function registryCandidates(env = process.env, home = homedir(), { write = false } = {}) {
  const job = join(home, ".dd", "run", "dd-repo-registry");
  const clone = join(home, "GitHub", "dd-repo-registry");
  return [env.DD_REGISTRY_DIR, ...(write ? [clone] : [job, clone])].filter(Boolean);
}

/** True for a run that edits the register or opens a pull request. */
export const writes = (args) => !args.some((a) => ["--dry-run", "--checklist", "--json"].includes(a));

/** The bin/client-new.mjs to run, or null. */
export function findClientNew(candidates = registryCandidates(), exists = existsSync) {
  for (const dir of candidates) {
    const file = join(dir, "bin", "client-new.mjs");
    if (exists(file)) return file;
  }
  return null;
}

export const CLIENT_USAGE = `usage: dd-framework client new <slug> [--intake <file>] [--dry-run] [--no-pr] [--checklist] [--json]
                     [--confirm <step,step> --evidence "<what shows it is done>"]
  One idempotent command to onboard a client. --dry-run reads only. The intake holds the client's contacts: keep it
  outside any git checkout (for example under ~/.dd). Set DD_REGISTRY_DIR to use another dd-repo-registry checkout.`;

export function clientCommand(args, { find = findClientNew, run = spawnSync, err = console.error, env = process.env, home = homedir() } = {}) {
  const [verb, ...rest] = args;
  if (verb !== "new" || !rest.length) { err(CLIENT_USAGE); return 2; }
  const candidates = registryCandidates(env, home, { write: writes(rest) });
  const file = find(candidates);
  if (!file) { err(`dd client new: no dd-repo-registry checkout found (looked in ${candidates.join(", ")}). Clone Doman-Digital/dd-repo-registry into ~/GitHub or set DD_REGISTRY_DIR.`); return 2; }
  const r = run(process.execPath, [file, ...rest], { stdio: "inherit" });
  return r.status ?? 2;
}
