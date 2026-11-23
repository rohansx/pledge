"""Network spikes.

A. Install with outbound limited to package registries.
B. Close outbound entirely; in-sandbox services must still be reachable and the sandbox still controllable.
C. Q-4: with outbound closed, redirect an SDK that hard-codes its provider's address (Stripe) to a fake in the sandbox.
"""
import json

import common  # noqa: F401 (loads the key)
from common import sh
from e2b import Sandbox

REGISTRIES = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "deb.debian.org"]
DENY_ALL = ["0.0.0.0/0"]

FAKE = r'''
import http.server, json, ssl
class Handler(http.server.BaseHTTPRequestHandler):
    def _answer(self):
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        with open("/tmp/fake.log", "a") as log:
            log.write(f"{self.command} {self.headers.get('host')}{self.path} ua={self.headers.get('user-agent','')[:40]}\n")
        body = json.dumps({"object": "list", "data": [], "has_more": False, "url": "/v1/customers", "served_by": "fake"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = _answer
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/opt/fake/server.crt", "/opt/fake/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
'''

# Each client prints one line. They are run twice: with only the system trust store, then with the CA env vars set.
CLIENTS = {
    "curl": "curl -s -m 8 https://api.stripe.com/v1/customers | grep -o '\"served_by\": \"fake\"' || echo FAIL",
    "python requests": "python3 -c \"import requests; print(requests.get('https://api.stripe.com/v1/customers', timeout=8).json()['served_by'])\" 2>&1 | tail -1 | cut -c1-110",
    "stripe-python": "python3 -c \"import stripe; stripe.api_key='sk_test_x'; stripe.max_network_retries=0; print('list ok, items:', len(stripe.Customer.list().data))\" 2>&1 | tail -1 | cut -c1-110",
    "node fetch": "node -e \"fetch('https://api.stripe.com/v1/customers').then(r=>r.json()).then(j=>console.log(j.served_by)).catch(e=>console.log('FAIL', e.cause?.code||e.message))\"",
    "stripe-node": "cd /opt/client && node -e \"const s=require('stripe')('sk_test_x',{maxNetworkRetries:0}); s.customers.list().then(r=>console.log('list ok, items:', r.data.length)).catch(e=>console.log('FAIL', (e.message||'').slice(0,80)))\"",
}
CA_ENV = "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt NODE_EXTRA_CA_CERTS=/opt/fake/ca.crt"


def reach(sandbox, url):
    return sh(sandbox, f"curl -s -m 8 -o /dev/null -w '%{{http_code}}' {url} || true")[1] or "blocked"


if __name__ == "__main__":
    results: dict = {}
    sandbox = Sandbox.create(timeout=900, network={"allow_out": REGISTRIES, "deny_out": DENY_ALL})
    print("sandbox", sandbox.sandbox_id)
    try:
        results["A allow-listed registries"] = {
            "npm registry": reach(sandbox, "https://registry.npmjs.org/"),
            "pypi": reach(sandbox, "https://pypi.org/simple/"),
            "example.com (not listed)": reach(sandbox, "https://example.com/"),
            "raw IP 1.1.1.1 (not listed)": reach(sandbox, "https://1.1.1.1/"),
        }
        code, out, took = sh(sandbox, "pip install -q --break-system-packages stripe requests 2>&1 | tail -2; mkdir -p /opt/client && cd /opt/client && npm init -y >/dev/null && npm install --silent stripe 2>&1 | tail -2; python3 -c 'import stripe; print(\"stripe-python\", stripe.VERSION)'; node -e 'console.log(\"stripe-node\", require(\"/opt/client/node_modules/stripe/package.json\").version, \"node\", process.version)'", timeout=600)
        results["A install under allow-list"] = {"exit": code, "seconds": took, "tail": out.splitlines()[-2:]}
        print(json.dumps(results, indent=1))

        sandbox.update_network({"deny_out": DENY_ALL})
        sh(sandbox, "nohup python3 -m http.server 9000 --bind 127.0.0.1 >/dev/null 2>&1 &")
        results["B outbound closed"] = {
            "npm registry": reach(sandbox, "https://registry.npmjs.org/"),
            "example.com": reach(sandbox, "https://example.com/"),
            "DNS lookup": sh(sandbox, "getent hosts example.com >/dev/null && echo resolves || echo no-answer")[1],
            "in-sandbox service 127.0.0.1:9000": reach(sandbox, "http://127.0.0.1:9000/"),
            "sandbox still controllable": sh(sandbox, "echo yes")[1],
        }
        print(json.dumps(results["B outbound closed"], indent=1))

        sandbox.files.write("/opt/fake/fake.py", FAKE)
        sh(sandbox, "cd /opt/fake && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=Pledge Sandbox CA' -keyout ca.key -out ca.crt 2>/dev/null && "
                    "openssl req -newkey rsa:2048 -nodes -subj '/CN=api.stripe.com' -keyout server.key -out server.csr 2>/dev/null && "
                    "printf 'subjectAltName=DNS:api.stripe.com,DNS:*.stripe.com' > san.cnf && "
                    "openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile san.cnf -out server.crt 2>/dev/null && "
                    "echo '127.0.0.1 api.stripe.com' >> /etc/hosts && (nohup python3 fake.py >/tmp/fake.out 2>&1 &) && sleep 1", check=True)

        results["C1 hosts entry only, CA not trusted"] = {name: sh(sandbox, command)[1].splitlines()[-1] for name, command in CLIENTS.items()}
        sh(sandbox, "cp /opt/fake/ca.crt /usr/local/share/ca-certificates/pledge-sandbox.crt && update-ca-certificates >/dev/null 2>&1", check=True)
        results["C2 CA in the system trust store"] = {name: sh(sandbox, command)[1].splitlines()[-1] for name, command in CLIENTS.items()}
        results["C3 system store plus CA env vars"] = {name: sh(sandbox, f"export {CA_ENV}; {command}")[1].splitlines()[-1] for name, command in CLIENTS.items()}
        results["C fake's request log"] = sh(sandbox, "sort /tmp/fake.log | uniq -c")[1].splitlines()
    finally:
        sandbox.kill()
    print(json.dumps(results, indent=1))
