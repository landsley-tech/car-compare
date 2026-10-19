# Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
# Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
# SPDX-License-Identifier: MIT
"""Check a running Car Compare site the way the public will reach it.

  python3 tools/check_public.py https://cars.example.com
  python3 tools/check_public.py http://127.0.0.1:8000 --insecure   (local / self-signed certificate)

Read-only apart from a short burst of requests to prove the rate limit works (skip it with --no-burst).
Exit code 0 = every check passed.
"""
import argparse
import http.client
import json
import ssl
import statistics
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--insecure", action="store_true", help="accept a self-signed certificate")
    ap.add_argument("--no-burst", action="store_true", help="skip the rate-limit burst")
    args = ap.parse_args()
    base = urllib.parse.urlsplit(args.url)
    https = base.scheme == "https"
    ctx = ssl._create_unverified_context() if args.insecure else ssl.create_default_context()

    def req(path, method="GET", headers=None, host=None):
        conn = (http.client.HTTPSConnection(host or base.netloc, timeout=15, context=ctx) if https
                else http.client.HTTPConnection(host or base.netloc, timeout=15))
        try:
            conn.request(method, path, headers=headers or {})
            r = conn.getresponse()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
        finally:
            conn.close()

    # 1. the page and its security headers
    status, h, body = req("/")
    check("home page loads", status == 200 and b"Car Compare" in body, f"HTTP {status}")
    csp = h.get("content-security-policy", "")
    check("Content-Security-Policy blocks outside scripts", "script-src 'self'" in csp and "frame-ancestors 'none'" in csp)
    check("nosniff + no framing headers", h.get("x-content-type-options") == "nosniff" and h.get("x-frame-options") == "DENY")
    check("server software version hidden", "python" not in h.get("server", "").lower(), h.get("server", ""))
    if https:
        check("HSTS (HTTPS-only) header", "max-age" in h.get("strict-transport-security", ""),
              h.get("strict-transport-security", "missing: turn on HSTS in Cloudflare or Caddy"))
        plain = http.client.HTTPConnection(base.hostname, 80, timeout=5)
        try:
            plain.request("GET", "/")
            code = plain.getresponse().status
            check("plain http redirects to https", code in (301, 302, 307, 308), f"HTTP {code}")
        except OSError:
            check("plain http redirects to https", True, "port 80 closed, so nothing is served unencrypted")
        finally:
            plain.close()

    # 2. attacks that must fail
    leaks = [p for p in ("/../server.py", "/%2e%2e/server.py", "/server.py", "/data/cars.db", "/.git/config", "/PRIVATE-make-it-public.md")
             if (r := req(p))[0] == 200]
    check("no source, database or private files served", not leaks, ", ".join(leaks))
    check("only GET/HEAD allowed", all(req("/", m)[0] in (403, 405) for m in ("POST", "PUT", "DELETE")))
    bad = ["/api/db/brands?fuel=x'%20OR%201=1--", "/api/db/car?id=1%20UNION%20SELECT%201", "/api/epa/makes?year=abc"]
    check("bad / injected input rejected", all(req(p)[0] == 400 for p in bad))
    status, h, body = req("/api/db/models?brand=%3Cscript%3E")
    check("API replies are JSON, never HTML", h.get("content-type", "").startswith("application/json"), f"HTTP {status}")

    # 3. speed with 20 people using it at once
    paths = ["/", "/app.js", "/api/db/meta", "/api/db/brands", "/api/db/models?brand=BMW", "/api/db/car?id=3497"]
    def timed(i):
        t0 = time.perf_counter()
        try:
            s = req(paths[i % len(paths)])[0]
        except OSError:
            s = "failed"
        return s, time.perf_counter() - t0
    with ThreadPoolExecutor(20) as ex:
        runs = list(ex.map(timed, range(100)))
    # all this traffic comes from one IP, so some API calls being rate limited (429) is correct; errors are not
    errors = [s for s, _ in runs if s not in (200, 429)]
    times = sorted(t for _, t in runs)
    p95 = times[94]
    check("20 requests at once: every one answered, no errors", not errors,
          f"{sum(s == 200 for s, _ in runs)} served, {sum(s == 429 for s, _ in runs)} rate limited, {len(errors)} errors")
    check("20 requests at once: fast enough", p95 < 1.0, f"median {statistics.median(times) * 1000:.0f} ms, 95% under {p95 * 1000:.0f} ms")

    # 4. one visitor flooding gets slowed down, and faking an IP header doesn't help
    if not args.no_burst:
        codes = [req("/api/db/meta", headers={"X-Forwarded-For": f"10.9.{i // 250}.{i % 250}", "CF-Connecting-IP": f"10.8.0.{i % 250}"})[0]
                 for i in range(300)]
        check("flood from one visitor is rate limited (even with faked IP headers)", 429 in codes or 403 in codes,
              f"{codes.count(429) + codes.count(403)} of 300 refused")
        time.sleep(1)

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
