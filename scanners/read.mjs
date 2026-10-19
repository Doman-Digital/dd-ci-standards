// Prints `<scanner>=true|false` for each scanner in scanners.json, for one
// repo (owner/name, compared without case). Used by scanners/action.yml.
import { readFileSync } from "node:fs";

export function scannersFor(register, repo) {
  const want = String(repo).toLowerCase();
  const out = {};
  for (const [scanner, repos] of Object.entries(register.scanners ?? {})) {
    out[scanner] = Object.keys(repos).some((r) => r.toLowerCase() === want);
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [, , file, repo] = process.argv;
  for (const [k, v] of Object.entries(scannersFor(JSON.parse(readFileSync(file, "utf8")), repo))) console.log(`${k}=${v}`);
}
