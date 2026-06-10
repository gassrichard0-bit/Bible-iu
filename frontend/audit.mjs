/**
 * Responsive audit against the live Bible IU dev server.
 *
 * For each viewport, log in past both gates (X-App-Password + a fresh
 * registered user), navigate the main routes, screenshot each, and
 * measure whether the page horizontally overflows the viewport
 * (which is what causes the iOS "swipe-from-edge" interaction
 * deadzone + the cut-off-content look we saw in the headless Chrome
 * screenshots earlier).
 */
import { webkit } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:5173";
const API_URL = process.env.API_URL || "http://127.0.0.1:8765";
const APP_PASSWORD = process.env.BIBLE_IU_PASSWORD || "bible2026";

const VIEWPORTS = [
  { name: "iphone-se",      width: 375,  height: 667,  isMobile: true },
  { name: "iphone-14-pro",  width: 393,  height: 852,  isMobile: true },
  { name: "ipad-portrait",  width: 768,  height: 1024, isMobile: false },
  { name: "desktop",        width: 1440, height: 900,  isMobile: false },
];

// Routes to walk. We keep the list short — the goal is a sanity sweep,
// not exhaustive coverage. Each entry: { hash, label }.
const ROUTES = [
  { hash: "",            label: "home" },
  { hash: "#settings",   label: "settings" },
];

const OUT = "/tmp/bible-iu-responsive";

async function registerThrowaway() {
  const handle = "audit_" + Math.random().toString(36).slice(2, 8);
  const r = await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": APP_PASSWORD,
    },
    body: JSON.stringify({
      handle,
      password: "audit-pw-1234",
      display_name: "Audit Bot",
    }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  return { handle, token: body.token };
}

async function deleteUser(token) {
  try {
    await fetch(`${API_URL}/auth/me`, {
      method: "DELETE",
      headers: { "X-Session-Token": token, "X-App-Password": APP_PASSWORD },
    });
  } catch {}
}

async function auditOne(vp, token) {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.isMobile ? 2 : 1,
    userAgent: vp.isMobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 " +
        "Mobile/15E148 Safari/604.1"
      : undefined,
    hasTouch: vp.isMobile,
    isMobile: vp.isMobile,
  });
  // Seed localStorage BEFORE the app mounts so both gates pass.
  await context.addInitScript(
    ([pw, tok]) => {
      localStorage.setItem("bible-iu:password", pw);
      localStorage.setItem("bible-iu:session-token", tok);
    },
    [APP_PASSWORD, token],
  );

  const page = await context.newPage();
  const results = [];

  for (const route of ROUTES) {
    const url = `${APP_URL}/${route.hash}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    // Give React + Vite HMR + queries a beat.
    await page.waitForTimeout(1500);

    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      innerW: window.innerWidth,
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
      // Find the first element whose right edge is beyond the viewport.
      overflowing: (() => {
        const vw = window.innerWidth;
        const offenders = [];
        const walker = document.createTreeWalker(
          document.body, NodeFilter.SHOW_ELEMENT, null,
        );
        let node;
        while ((node = walker.nextNode())) {
          const r = node.getBoundingClientRect();
          if (r.right > vw + 1 && r.width > 0 && r.height > 0) {
            // Skip tiny pixels and inheriting-overflow children.
            offenders.push({
              tag: node.tagName.toLowerCase(),
              cls: (node.className || "").toString().slice(0, 100),
              right: Math.round(r.right),
              vw,
            });
            if (offenders.length >= 5) break;
          }
        }
        return offenders;
      })(),
    }));

    const shotPath = `${OUT}/${vp.name}_${route.label}.png`;
    await page.screenshot({ path: shotPath, fullPage: false });
    results.push({ route: route.label, ...m, shot: shotPath });
  }

  await browser.close();
  return results;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { handle, token } = await registerThrowaway();
  console.log(`registered throwaway: ${handle}`);

  const report = [];
  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n=== ${vp.name} (${vp.width}×${vp.height}) ===`);
      const rs = await auditOne(vp, token);
      for (const r of rs) {
        const ovfl = r.scrollW > r.innerW;
        console.log(
          `  ${r.route.padEnd(10)} scroll=${r.scrollW} viewport=${r.innerW}` +
          (ovfl ? ` ⚠ overflows by ${r.scrollW - r.innerW}px` : " ✓"),
        );
        if (r.overflowing.length) {
          for (const e of r.overflowing.slice(0, 3)) {
            console.log(`     offender <${e.tag}> right=${e.right}px (vw=${e.vw}) class="${e.cls}"`);
          }
        }
        report.push({ viewport: vp.name, ...r });
      }
    }
  } finally {
    await deleteUser(token);
    console.log("\n(cleanup) throwaway user deleted");
  }

  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\nfull report: ${OUT}/report.json`);
  console.log(`screenshots: ${OUT}/*.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
