// Point the Dokploy apps at the images just built, deploy them, then prove the new version is the one answering.
// The smoke test is the source of truth: Dokploy's own status is polled only to fail fast.
const required = [
  "DOKPLOY_URL", "DOKPLOY_API_KEY", "VERSION", "IMAGE_PREFIX",
  "DOKPLOY_API_APP_ID", "DOKPLOY_WEB_APP_ID", "DOKPLOY_SITE_APP_ID", "PUBLIC_URL", "SITE_URL",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`missing environment: ${missing.join(", ")}`);
  process.exit(1);
}
const env = process.env;
const SMOKE_TIMEOUT_MS = 5 * 60_000; // a first deploy also waits for the TLS certificate
const POLL_MS = 5_000;

/** Each app, and the URL whose response proves which build is live. */
const APPS = [
  { name: "api", id: env.DOKPLOY_API_APP_ID, check: `${env.PUBLIC_URL}/api/healthz`, read: readHealth },
  { name: "web", id: env.DOKPLOY_WEB_APP_ID, check: `${env.PUBLIC_URL}/version.txt`, read: readText },
  { name: "site", id: env.DOKPLOY_SITE_APP_ID, check: `${env.SITE_URL}/version.txt`, read: readText },
];

async function readHealth(response) {
  const body = await response.json();
  // The API only counts as live when it can also reach its database.
  return body?.data?.db === "ok" ? body.data.version : `db ${body?.error ?? "not ok"}`;
}

async function readText(response) {
  return (await response.text()).trim().slice(0, 80);
}

async function dokploy(method, endpoint, payload) {
  const query = method === "GET" ? `?${new URLSearchParams(payload)}` : "";
  const response = await fetch(`${env.DOKPLOY_URL.replace(/\/$/, "")}/api/${endpoint}${query}`, {
    method,
    headers: { "x-api-key": env.DOKPLOY_API_KEY, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The version each app is serving right now, or why it could not be read. */
async function live() {
  const seen = {};
  for (const app of APPS) {
    try {
      seen[app.name] = await app.read(await fetch(app.check, { signal: AbortSignal.timeout(10_000), cache: "no-store" }));
    } catch (error) {
      seen[app.name] = `unreachable (${error.cause?.code ?? error.message})`;
    }
  }
  return seen;
}

async function failedApp() {
  for (const app of APPS) {
    const state = await dokploy("GET", "application.one", { applicationId: app.id }).catch(() => null);
    if (state?.applicationStatus === "error") return app.name;
  }
  return null;
}

for (const app of APPS) {
  const dockerImage = `${env.IMAGE_PREFIX}-${app.name}:${env.VERSION}`;
  await dokploy("POST", "application.saveDockerProvider", { applicationId: app.id, dockerImage, username: null, password: null, registryUrl: null });
  await dokploy("POST", "application.deploy", { applicationId: app.id });
  console.info(`${app.name}: deploying ${dockerImage}`);
}

const deadline = Date.now() + SMOKE_TIMEOUT_MS;
let seen;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  seen = await live();
  if (APPS.every((app) => seen[app.name] === env.VERSION)) {
    console.info(`live at ${env.VERSION}: ${APPS.map((app) => app.name).join(", ")}; database ok`);
    process.exit(0);
  }
  const failed = await failedApp();
  if (failed) {
    console.error(`Dokploy reports the ${failed} deployment failed; see its deployment log in the panel`);
    process.exit(1);
  }
}
console.error(`not live after ${SMOKE_TIMEOUT_MS / 1000}s; wanted ${env.VERSION}, last saw ${JSON.stringify(seen)}`);
process.exit(1);
