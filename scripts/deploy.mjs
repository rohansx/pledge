// Point the Dokploy apps at the images just built, deploy them, then prove the new version is the one answering.
// The smoke test is the source of truth: Dokploy's own status is polled only to fail fast.
const required = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "DOKPLOY_API_APP_ID", "DOKPLOY_WEB_APP_ID", "API_IMAGE", "WEB_IMAGE", "PUBLIC_URL", "VERSION"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`missing environment: ${missing.join(", ")}`);
  process.exit(1);
}
const env = process.env;
const SMOKE_TIMEOUT_MS = 5 * 60_000; // a first deploy also waits for the TLS certificate
const POLL_MS = 5_000;

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

async function deploy(name, applicationId, dockerImage) {
  await dokploy("POST", "application.saveDockerProvider", { applicationId, dockerImage, username: null, password: null, registryUrl: null });
  await dokploy("POST", "application.deploy", { applicationId });
  console.info(`${name}: deploying ${dockerImage}`);
}

async function failedApp() {
  for (const [name, applicationId] of [["api", env.DOKPLOY_API_APP_ID], ["web", env.DOKPLOY_WEB_APP_ID]]) {
    const app = await dokploy("GET", "application.one", { applicationId }).catch(() => null);
    if (app?.applicationStatus === "error") return name;
  }
  return null;
}

/** What is live right now, or the reason it could not be read. */
async function live() {
  try {
    const options = () => ({ signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const health = await fetch(`${env.PUBLIC_URL}/api/healthz`, options());
    const body = await health.json();
    const web = await fetch(`${env.PUBLIC_URL}/version.txt`, options());
    return { api: body?.data?.version, db: body?.data?.db, apiStatus: health.status, web: (await web.text()).trim().slice(0, 80) };
  } catch (error) {
    return { error: error.cause?.code ?? error.message };
  }
}

await deploy("api", env.DOKPLOY_API_APP_ID, env.API_IMAGE);
await deploy("web", env.DOKPLOY_WEB_APP_ID, env.WEB_IMAGE);

const deadline = Date.now() + SMOKE_TIMEOUT_MS;
let seen;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  seen = await live();
  if (seen.api === env.VERSION && seen.web === env.VERSION && seen.db === "ok") {
    console.info(`live: api and web at ${env.VERSION}, database ok`);
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
