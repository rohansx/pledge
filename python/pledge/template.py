"""The E2B base template every scan starts from. Build or rebuild it with:

    python -m pledge.template

It carries what is slow to install and rarely changes: Docker, k6 and the LiteTraffic engine. The pledge
package itself is uploaded per scan, so changing the proxy or a fake does not need a rebuild.
"""

from __future__ import annotations

TEMPLATE = "pledge-base"
# The default sandbox has 473 MiB, too little for an app, its database and Docker (see docs/spikes/phase-0.md).
CPU_COUNT, MEMORY_MB = 4, 4096  # a compiled backend plus its database does not build in less
K6_VERSION = "v2.2.0"  # the only version the engine accepts
PLAYWRIGHT_VERSION = "1.56.1"  # apps/web/Dockerfile ships the matching trace viewer
ENGINE = "litetraffic @ git+https://github.com/rohansx/litetraffic@0c8cf17a5da17ad9123625b30a336115760ebd2a"


def definition():
    from e2b import Template

    k6 = f"https://github.com/grafana/k6/releases/download/{K6_VERSION}/k6-{K6_VERSION}-linux-amd64.tar.gz"
    return (
        Template()
        .from_base_image()  # Debian 12 with Python 3.11 and Node 20, the image the spikes ran on
        .run_cmd("curl -fsSL https://get.docker.com | sh", user="root")
        .run_cmd(f"curl -fsSL {k6} | tar -xz -C /usr/local/bin --strip-components=1 k6-{K6_VERSION}-linux-amd64/k6 && k6 version", user="root")
        .run_cmd(f"pip install --break-system-packages 'aiohttp>=3.9,<4' '{ENGINE}' && python3 -m litetraffic --version", user="root")
        # For browser recordings (pledge/browser_runner.cjs). local.PLAYWRIGHT_MODULES points here.
        .run_cmd(f"mkdir -p /opt/pw && cd /opt/pw && npm init -y && npm install playwright@{PLAYWRIGHT_VERSION} && npx playwright install --with-deps chromium", user="root")
    )


def main() -> None:
    from e2b import Template, default_build_logger

    from pledge.scan import load_key

    load_key()
    info = Template.build(definition(), TEMPLATE, cpu_count=CPU_COUNT, memory_mb=MEMORY_MB, on_build_logs=default_build_logger())
    print(f"built {TEMPLATE}: {info}")


if __name__ == "__main__":
    main()
