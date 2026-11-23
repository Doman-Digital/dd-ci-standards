// Every page the caller names, at 375px: the pull request's screenshot against its base's, both built and taken in
// this run on this machine, so fonts, the CMS and the browser are the same on both sides and only the change shows.
// The head phase also fails a sideways page or a sideways row that scrolls up and down (craft's measure, checks
// "scroll" and "rowscroll") that the base did not have, so a fault already on main does not fail every pull request.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { measurePhoneInPage, PHONE_FLOORS } from "@domandigital/craft/phone";

const phase = process.env.VISUAL_PHASE === "base" ? "base" : "head";
const out = process.env.VISUAL_OUT ?? "phone-visual";
const ratio = Number(process.env.VISUAL_MAX_DIFF_RATIO ?? "0");
const pages = (process.env.VISUAL_PAGES ?? "/").split("\n").map((p) => p.trim()).filter((p) => p.startsWith("/"));
const LAYOUT = new Set(["scroll", "rowscroll"]);
export const nameOf = (path) => (path === "/" ? "home" : path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase());

for (const path of pages) {
  test(`phone ${path}`, async ({ page }) => {
    const name = nameOf(path);
    const res = await page.goto(path, { waitUntil: "networkidle" });
    expect(res?.status(), `${path} answers`).toBeLessThan(400);
    // Lazy images and fonts load before the capture: walk the page once, then back to the top.
    await page.evaluate(async () => {
      await document.fonts?.ready;
      for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState("networkidle");
    // A page the base does not have is new: nothing to compare it with, so it is reported and only measured.
    if (phase === "head" && !existsSync(`${out}/base/${name}.png`)) test.info().annotations.push({ type: "new page", description: `${path} is not on the base` });
    // A video's frame and a third-party frame differ between any two loads: masked on both sides.
    else await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, animations: "disabled", caret: "hide", maxDiffPixelRatio: ratio, mask: [page.locator("video, iframe")] });

    const findings = (await page.evaluate(measurePhoneInPage, { ...PHONE_FLOORS })).filter((f) => LAYOUT.has(f.check));
    const file = `${out}/base/${name}.layout.json`;
    if (phase === "base") {
      mkdirSync(`${out}/base`, { recursive: true });
      writeFileSync(file, JSON.stringify(findings));
      return;
    }
    const before = new Set((existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []).map((f) => `${f.check} ${f.element}`));
    const fresh = findings.filter((f) => !before.has(`${f.check} ${f.element}`)).map((f) => `${f.check} ${f.element}: ${f.detail}`);
    expect(fresh, `${path}: new layout faults at 375px`).toEqual([]);
  });
}
