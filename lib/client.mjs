// dd client new <slug>: forwards to dd-repo-registry's bin/client-new.mjs (DOM-999, DOM-18147).
//
// The step table, the detectors, the registry edit and the sweep rules live in dd-repo-registry because they read its
// registers (registry.yaml, access-standard.yaml, costs.yaml, creds.yaml). This file only finds a checkout of it and
// hands over the arguments, so there is one copy of the logic.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where a registry checkout may be, in order: DD_REGISTRY_DIR, the box's job copy, the usual clone. */
export function registryCandidates(env = process.env, home = homedir()) {
  return [env.DD_REGISTRY_DIR, join(home, ".dd", "run", "dd-repo-registry"), join(home, "GitHub", "dd-repo-registry")].filter(Boolean);
}

/** The bin/client-new.mjs to run, or null. */
export function findClientNew(candidates = registryCandidates(), exists = existsSync) {
  for (const dir of candidates) {
    const file = join(dir, "bin", "client-new.mjs");
    if (exists(file)) return file;
  }
  return null;
}

export const CLIENT_USAGE = `usage: dd client new <slug> [--intake <file>] [--dry-run] [--no-pr] [--checklist] [--json]
                     [--confirm <step,step> --evidence "<what shows it is done>"]
  One idempotent command to onboard a client. --dry-run reads only. The intake holds the client's contacts: keep it
  outside any git checkout (for example under ~/.dd). Set DD_REGISTRY_DIR to use another dd-repo-registry checkout.`;

export function clientCommand(args, { find = findClientNew, run = spawnSync, err = console.error } = {}) {
  const [verb, ...rest] = args;
  if (verb !== "new" || !rest.length) { err(CLIENT_USAGE); return 2; }
  const file = find();
  if (!file) { err(`dd client new: no dd-repo-registry checkout found (looked in ${registryCandidates().join(", ")}). Clone Doman-Digital/dd-repo-registry into ~/GitHub or set DD_REGISTRY_DIR.`); return 2; }
  const r = run(process.execPath, [file, ...rest], { stdio: "inherit" });
  return r.status ?? 2;
}
