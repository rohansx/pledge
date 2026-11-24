// Records a browser session: node browser_runner.cjs STEPS.cjs OUT_DIR  (PLEDGE_JOURNEY names the journey)
//
// STEPS.cjs exports `async (page, { journey, secret }) => {...}`: what a user of the app does to see the state a
// broken journey left behind. This file owns the recording, so every scenario's comes out the same: trace.zip (DOM
// snapshots, network and console on one timeline), video.webm and screenshot.png of the last screen.
// CommonJS because NODE_PATH, which is how Playwright is found in the sandbox, does not apply to ES modules.
//
// Typed secrets: a trace keeps every action's parameters, so `fill("hunter2")` is in it as typed, and again in the
// page snapshots and in the sign-in request's body. Playwright has no switch for that. This file therefore only
// collects what must not be kept: every value a password field ever held (watched in the page, so steps need do
// nothing), plus anything the steps pass through `secret(value)`. The list goes to the parent process on stdout
// and nowhere else; local.scrub_trace rewrites the trace without those values, and says what it cannot catch.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const VIEWPORT = { width: 1280, height: 800 };
const SECRETS_MARK = "PLEDGE_SECRETS "; // local.SECRETS_MARK
const MAX_SECRET_CHARS = 200;

// Runs in every page before its own scripts. `input` fires for fill() and for each key typed, on the element
// itself, so composedPath finds a field inside a shadow root too.
function watchPasswordFields() {
  window.addEventListener("input", (event) => {
    const field = event.composedPath()[0];
    const isPassword = field && (field.type === "password" || /password/i.test(field.autocomplete || ""));
    if (isPassword && field.value && window.__pledgeSecret) window.__pledgeSecret(field.value);
  }, true);
}

(async () => {
  const [script, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const secrets = new Set();
  const secret = (value) => {
    if (typeof value === "string" && value && value.length <= MAX_SECRET_CHARS) secrets.add(value);
    return value;
  };
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: out, size: VIEWPORT } });
  // The sandbox drops outbound packets, so a font or analytics request would hang and the page never finish
  // loading. Fail anything that is not the app itself at once, as a browser with no internet would.
  await context.route((url) => !["127.0.0.1", "localhost"].includes(url.hostname), (route) => route.abort());
  await context.exposeBinding("__pledgeSecret", (_source, value) => void secret(value));
  await context.addInitScript(watchPasswordFields);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  let failure = null;
  try {
    await require(path.resolve(script))(page, { journey: process.env.PLEDGE_JOURNEY, secret });
  } catch (error) {
    failure = error; // the recording up to the failure is still worth keeping
  }
  await page.screenshot({ path: path.join(out, "screenshot.png") }).catch(() => {});
  await context.tracing.stop({ path: path.join(out, "trace.zip") });
  const video = page.video();
  await context.close(); // the video file is complete only after this
  if (video) fs.renameSync(await video.path(), path.join(out, "video.webm"));
  await browser.close();
  if (failure) console.error(String(failure.stack || failure));
  // Last, after the browser is gone, so nothing typed later is missed. Without this line the parent drops the trace.
  console.log(SECRETS_MARK + JSON.stringify([...secrets]));
  process.exitCode = failure ? 1 : 0;
})();
