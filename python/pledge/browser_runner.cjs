// Records a browser session: node browser_runner.cjs STEPS.cjs OUT_DIR  (PLEDGE_JOURNEY names the journey)
//
// STEPS.cjs exports `async (page, { journey }) => {...}`: what a user of the app does to see the state a broken
// journey left behind. This file owns the recording, so every scenario's comes out the same: trace.zip (DOM
// snapshots, network and console on one timeline), video.webm and screenshot.png of the last screen.
// CommonJS because NODE_PATH, which is how Playwright is found in the sandbox, does not apply to ES modules.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const VIEWPORT = { width: 1280, height: 800 };

(async () => {
  const [script, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: out, size: VIEWPORT } });
  // The sandbox drops outbound packets, so a font or analytics request would hang and the page never finish
  // loading. Fail anything that is not the app itself at once, as a browser with no internet would.
  await context.route((url) => !["127.0.0.1", "localhost"].includes(url.hostname), (route) => route.abort());
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  let failure = null;
  try {
    await require(path.resolve(script))(page, { journey: process.env.PLEDGE_JOURNEY });
  } catch (error) {
    failure = error; // the recording up to the failure is still worth keeping
  }
  await page.screenshot({ path: path.join(out, "screenshot.png") }).catch(() => {});
  await context.tracing.stop({ path: path.join(out, "trace.zip") });
  const video = page.video();
  await context.close(); // the video file is complete only after this
  if (video) fs.renameSync(await video.path(), path.join(out, "video.webm"));
  await browser.close();
  if (failure) {
    console.error(String(failure.stack || failure));
    process.exit(1);
  }
})();
