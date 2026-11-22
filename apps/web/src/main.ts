import { describeHealth } from "./health.ts";

const status = document.querySelector<HTMLElement>("#status")!;

try {
  const response = await fetch("/api/healthz");
  status.textContent = describeHealth(response.status, await response.json().catch(() => null));
} catch {
  status.textContent = "API unreachable";
}
