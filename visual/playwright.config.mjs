// The phone screenshot comparison (.github/workflows/phone-visual.yml). One phone, 375 x 812 at 2x, the house
// default (craft STANDARD.md section 10). The run's two phases share it: VISUAL_PHASE=base writes the base's
// screenshots and findings, VISUAL_PHASE=head compares the pull request's against them.
import { defineConfig, devices } from "@playwright/test";

const out = process.env.VISUAL_OUT ?? "phone-visual";
export default defineConfig({
  testDir: ".",
  testMatch: "phone.spec.mjs",
  outputDir: `${out}/results-${process.env.VISUAL_PHASE ?? "head"}`,
  snapshotPathTemplate: `${out}/base/{arg}{ext}`,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.VISUAL_PHASE === "base" ? [["list"]] : [["list"], ["html", { open: "never", outputFolder: `${out}/report` }], ["json", { outputFile: `${out}/results.json` }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    baseURL: process.env.VISUAL_BASE_URL,
    reducedMotion: "reduce",
    // A browser already on the machine (a local run); in CI the workflow installs Playwright's own.
    ...(process.env.VISUAL_CHROMIUM ? { launchOptions: { executablePath: process.env.VISUAL_CHROMIUM } } : {}),
  },
});
