"""Q-4 follow-up: stripe-python ships its own CA bundle and ignores the system store and CA env vars.
Does appending the sandbox CA to that bundled file (no change to the app's code) make it trust the fake?"""
import json

import common  # noqa: F401 (loads the key)
from common import sh
from e2b import Sandbox
from s3_network import CLIENTS, FAKE

STRIPE = CLIENTS["stripe-python"]
results: dict = {}
sandbox = Sandbox.create(timeout=600)
try:
    sh(sandbox, "pip install -q --break-system-packages stripe 2>&1 | tail -1", timeout=300)
    sandbox.files.write("/opt/fake/fake.py", FAKE)
    sh(sandbox, "cd /opt/fake && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=Pledge Sandbox CA' -keyout ca.key -out ca.crt 2>/dev/null && "
                "openssl req -newkey rsa:2048 -nodes -subj '/CN=api.stripe.com' -keyout server.key -out server.csr 2>/dev/null && "
                "printf 'subjectAltName=DNS:api.stripe.com' > san.cnf && "
                "openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile san.cnf -out server.crt 2>/dev/null && "
                "echo '127.0.0.1 api.stripe.com' >> /etc/hosts && (nohup python3 fake.py >/tmp/fake.out 2>&1 &) && sleep 1", check=True)
    results["bundled CA files in site-packages"] = sh(sandbox, "find / -xdev \\( -name 'ca-certificates.crt' -o -name 'cacert.pem' \\) -path '*site-packages*' 2>/dev/null")[1].splitlines()
    results["before"] = sh(sandbox, STRIPE)[1].splitlines()[-1][:90]
    sh(sandbox, "for f in $(find / -xdev \\( -name 'ca-certificates.crt' -o -name 'cacert.pem' \\) -path '*site-packages*' 2>/dev/null); do cat /opt/fake/ca.crt >> $f; done", check=True)
    results["after appending the sandbox CA to every bundled file"] = sh(sandbox, STRIPE)[1].splitlines()[-1][:90]
finally:
    sandbox.kill()
print(json.dumps(results, indent=1))
