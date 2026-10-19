"""Server tests, including attack cases. Run: python3 -m unittest discover tests"""
import http.client
import json
import socket
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

M4 = {"id": "38623", "make": "BMW", "model": "M4 Coupe", "year": "2018", "fuelType": "Premium", "atvType": "",
      "comb08": "20", "co2TailpipeGpm": "450.0", "displ": "3.0", "cylinders": "6", "drive": "Rear-Wheel Drive",
      "trany": "Automatic (AM-S7)", "tCharger": "T", "sCharger": "", "VClass": "Compact Cars", "range": "0", "evMotor": ""}
EV = {"id": "1", "make": "Tesla", "model": "Model 3", "year": "2020", "fuelType": "Electricity", "atvType": "EV",
      "comb08": "130", "co2TailpipeGpm": "0.0", "displ": "", "cylinders": "", "drive": "All-Wheel Drive",
      "trany": "Automatic (A1)", "tCharger": "", "sCharger": "", "VClass": "Midsize Cars", "range": "322", "evMotor": "AC"}


def fake_epa(path, **params):
    if path == "menu/make":
        return {"menuItem": [{"text": "BMW", "value": "BMW"}, {"text": "Ford", "value": "Ford"}]}
    if path == "menu/model":
        return {"menuItem": {"text": "M4 Coupe", "value": "M4 Coupe"}}  # EPA sends a bare object for one item
    if path == "menu/options":
        return {"menuItem": [{"text": "Auto 7", "value": "38623"}]}
    if path == "38623":
        return M4
    raise server.UpstreamError("unknown")


class ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.make_server("127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        server.limiter = server.RateLimiter(100_000)  # tests that need a tight limit set their own
        server.cache = server.TTLCache()

    def get(self, path, method="GET", headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body


class StaticTests(ServerCase):
    def test_index_and_assets(self):
        r, body = self.get("/")
        self.assertEqual(r.status, 200)
        self.assertIn(b"Car Compare", body)
        r, _ = self.get("/app.js")
        self.assertEqual(r.getheader("Content-Type"), "text/javascript; charset=utf-8")
        r, body = self.get("/data/cars.json")
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(body))

    def test_installable_app_files(self):
        for path, ctype in [("/manifest.webmanifest", "application/manifest+json"), ("/sw.js", "text/javascript; charset=utf-8"),
                            ("/icon-192.png", "image/png"), ("/icon-512.png", "image/png"), ("/icon.svg", "image/svg+xml")]:
            r, body = self.get(path)
            self.assertEqual((r.status, r.getheader("Content-Type")), (200, ctype), path)
        manifest = json.loads(self.get("/manifest.webmanifest")[1])
        self.assertEqual(manifest["display"], "standalone")
        for icon in manifest["icons"]:
            self.assertEqual(self.get(icon["src"])[0].status, 200, icon["src"])

    def test_security_headers_on_every_response(self):
        for path in ["/", "/nope", "/api/epa/years"]:
            r, _ = self.get(path)
            self.assertIn("default-src 'self'", r.getheader("Content-Security-Policy"))
            self.assertIn("frame-ancestors 'none'", r.getheader("Content-Security-Policy"))
            self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
            self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
            self.assertEqual(r.getheader("Server"), "car-compare")  # no Python version leaked

    def test_head(self):
        r, body = self.get("/", "HEAD")
        self.assertEqual((r.status, body), (200, b""))

    def test_unknown_path_404(self):
        self.assertEqual(self.get("/admin")[0].status, 404)


class AttackTests(ServerCase):
    def test_path_traversal_cannot_read_files(self):
        for path in ["/../server.py", "/%2e%2e/server.py", "/data/../../server.py", "/..%2fserver.py",
                     "//etc/passwd", "/../../../../etc/passwd", "/web/index.html/..", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
                     "/server.py", "/tests/test_server.py", "/.git/config", "/index.html%00.js"]:
            r, body = self.get(path)
            self.assertEqual(r.status, 404, path)
            self.assertNotIn(b"make_server", body)
            self.assertNotIn(b"root:", body)

    def test_only_get_and_head_allowed(self):
        for m in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]:
            self.assertEqual(self.get("/", m)[0].status, 405, m)

    def test_long_uri_rejected(self):
        self.assertEqual(self.get("/api/epa/makes?year=" + "9" * 2000)[0].status, 414)

    def test_bad_parameters_rejected_before_upstream(self):
        with mock.patch.object(server, "epa_get", side_effect=AssertionError("must not call upstream")):
            for path in ["/api/epa/makes", "/api/epa/makes?year=abc", "/api/epa/makes?year=1900", "/api/epa/makes?year=99999",
                         "/api/epa/makes?year=2018%0d%0aX-Injected:1", "/api/epa/models?year=2018&make=%3Cscript%3E",
                         "/api/epa/models?year=2018&make=BMW%26year%3D1", "/api/epa/models?year=2018&make=" + "A" * 81,
                         "/api/epa/models?year=2018&make=", "/api/epa/vehicle?id=1%2F..%2Fmenu", "/api/epa/vehicle?id=-1",
                         "/api/epa/vehicle?id=123456789", "/api/epa/options?year=2018&make=BMW&model=M4%22%3B--"]:
                r, body = self.get(path)
                self.assertEqual(r.status, 400, path)
                self.assertEqual(r.getheader("Content-Type"), "application/json; charset=utf-8")

    def test_query_field_bomb_is_400_not_500(self):
        path = "/api/epa/makes?" + "&".join(f"a{i}=1" for i in range(50))
        self.assertEqual(self.get(path)[0].status, 400)

    def test_upstream_url_stays_on_epa_host_and_is_encoded(self):
        seen = []

        def fake_open(req, timeout):
            seen.append(req.full_url)
            raise OSError("offline")

        with mock.patch("urllib.request.urlopen", fake_open):
            self.get("/api/epa/models?year=2018&make=" + "..%2F..%2Fevil.com%2Fx")
        self.assertTrue(seen)
        self.assertTrue(seen[0].startswith("https://www.fueleconomy.gov/ws/rest/vehicle/menu/model?"))
        self.assertIn("make=..%2F..%2Fevil.com%2Fx", seen[0])

    def test_upstream_failure_is_502_and_server_survives(self):
        with mock.patch("urllib.request.urlopen", side_effect=OSError("down")):
            r, body = self.get("/api/epa/makes?year=2018")
        self.assertEqual(r.status, 502)
        self.assertNotIn(b"down", body)  # internal error text is not leaked
        self.assertEqual(self.get("/")[0].status, 200)

    def test_rate_limit_and_spoofed_forwarded_for_does_not_bypass(self):
        server.limiter = server.RateLimiter(60, burst=5)
        codes = [self.get("/", headers={"X-Forwarded-For": f"10.0.0.{i}"})[0].status for i in range(10)]
        self.assertEqual(codes[:5], [200] * 5)
        self.assertEqual(set(codes[5:]), {429})

    def test_flood_does_not_take_server_down(self):
        server.limiter = server.RateLimiter(60, burst=20)

        def hit(_):
            try:
                return self.get("/")[0].status
            except OSError:
                return "dropped"

        with ThreadPoolExecutor(40) as ex:
            codes = list(ex.map(hit, range(400)))
        self.assertGreater(codes.count(429) + codes.count(503) + codes.count("dropped"), 300)
        server.limiter = server.RateLimiter(100_000)
        self.assertEqual(self.get("/")[0].status, 200)

    def test_slowloris_connections_are_dropped_and_capped(self):
        with mock.patch.object(server.Handler, "timeout", 1), mock.patch.object(server, "MAX_CONN_PER_IP", 4):
            slow = []
            for _ in range(4):
                s = socket.create_connection(("127.0.0.1", self.port))
                s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n")  # never finish the headers
                slow.append(s)
            time.sleep(0.2)
            # per-IP cap: a 5th connection from the same IP is refused immediately
            r, _ = self.get("/")
            self.assertEqual(r.status, 503)
            # the server times the slow sockets out...
            time.sleep(1.8)
            for s in slow:
                s.settimeout(2)
                self.assertEqual(s.recv(100), b"")  # closed by the server
                s.close()
            # ...and serves normally again
            self.assertEqual(self.get("/")[0].status, 200)

    def test_spoofed_headers_behind_caddy_do_not_bypass_rate_limit(self):
        server.limiter = server.RateLimiter(60, burst=5)
        with mock.patch.object(server, "TRUST_PROXY", "caddy"):
            codes = [self.get("/", headers={"X-Forwarded-For": f"10.0.0.{i}, 198.51.100.9", "CF-Connecting-IP": f"10.1.0.{i}"})[0].status
                     for i in range(10)]
        self.assertEqual(set(codes[5:]), {429})

    def test_unexpected_upstream_reply_is_500_and_server_survives(self):
        for reply in (["a list"], "text", 42, {"menuItem": "nonsense"}, {"menuItem": [{"no": "value"}]}):
            with mock.patch.object(server, "epa_get", lambda p, _r=reply, **k: _r):
                r, body = self.get("/api/epa/makes?year=2018")
            self.assertIn(r.status, (200, 500), reply)
            self.assertTrue(json.loads(body) == [] or json.loads(body) == {"error": "unexpected error"}, reply)
        with mock.patch.object(server, "epa_get", lambda p, **k: ["a list"]):
            r, body = self.get("/api/epa/vehicle?id=1")
        self.assertEqual((r.status, json.loads(body)), (500, {"error": "unexpected error"}))
        self.assertEqual(self.get("/")[0].status, 200)

    def test_api_responses_are_json_not_html(self):
        # anything reflected from EPA data comes back as JSON, which browsers will not execute as a page
        with mock.patch.object(server, "epa_get", lambda p, **k: {"menuItem": [{"value": "<script>alert(1)</script>"}]}):
            r, body = self.get("/api/epa/makes?year=2018")
        self.assertEqual(r.getheader("Content-Type"), "application/json; charset=utf-8")


class ProxyTrustTests(unittest.TestCase):
    """Forwarded-IP headers are believed only from the local proxy, and only the one that proxy sets."""

    def ip(self, mode, peer, headers):
        h = server.Handler.__new__(server.Handler)
        h.client_address, h.headers = (peer, 1), headers
        with mock.patch.object(server, "TRUST_PROXY", mode):
            return h.client_ip()

    def test_cloudflare_mode(self):
        hdrs = {"CF-Connecting-IP": "198.51.100.7", "X-Forwarded-For": "6.6.6.6"}
        self.assertEqual(self.ip("cloudflare", "127.0.0.1", hdrs), "198.51.100.7")
        self.assertEqual(self.ip("cloudflare", "203.0.113.50", hdrs), "203.0.113.50")  # not from the proxy: ignored

    def test_caddy_mode_uses_last_entry_and_ignores_cf_header(self):
        hdrs = {"CF-Connecting-IP": "7.7.7.7", "X-Forwarded-For": "6.6.6.6, 198.51.100.9"}
        self.assertEqual(self.ip("caddy", "127.0.0.1", hdrs), "198.51.100.9")
        self.assertEqual(self.ip("caddy", "::1", {"X-Forwarded-For": "not-an-ip"}), "::1")

    def test_no_proxy_ignores_all_headers(self):
        self.assertEqual(self.ip("", "127.0.0.1", {"CF-Connecting-IP": "7.7.7.7", "X-Forwarded-For": "6.6.6.6"}), "127.0.0.1")

    def test_unknown_trust_proxy_value_refuses_to_start(self):
        import subprocess
        r = subprocess.run([sys.executable, "-c", "import server"], cwd=Path(server.__file__).parent,
                           env={**__import__("os").environ, "TRUST_PROXY": "1"}, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("TRUST_PROXY must be", r.stderr)


class ApiTests(ServerCase):
    def test_cascade_with_fake_upstream(self):
        with mock.patch.object(server, "epa_get", fake_epa):
            self.assertEqual(json.loads(self.get("/api/epa/makes?year=2018")[1]), ["BMW", "Ford"])
            self.assertEqual(json.loads(self.get("/api/epa/models?year=2018&make=BMW")[1]), ["M4 Coupe"])
            opts = json.loads(self.get("/api/epa/options?year=2018&make=BMW&model=M4%20Coupe")[1])
            self.assertEqual(opts, [{"id": "38623", "text": "Auto 7", "fuel": "Petrol"}])
            car = json.loads(self.get("/api/epa/vehicle?id=38623")[1])
        self.assertEqual(car["make"], "BMW")

    def test_years(self):
        years = json.loads(self.get("/api/epa/years")[1])
        self.assertEqual(years[-1], 1984)

    def test_cache_avoids_second_upstream_call(self):
        calls = []

        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def read(self, n): return b'{"menuItem": []}'

        with mock.patch("urllib.request.urlopen", lambda *a, **k: calls.append(1) or Resp()):
            self.get("/api/epa/makes?year=2018")
            self.get("/api/epa/makes?year=2018")
        self.assertEqual(len(calls), 1)


class UnitTests(unittest.TestCase):
    def test_map_vehicle_petrol(self):
        c = server.map_vehicle(M4)
        self.assertEqual((c["fuel"], c["drive"], c["asp"], c["cc"]), ("Petrol", "RWD", "turbo", 3000))
        self.assertEqual(c["mpg"], 24)   # 20 US mpg -> 24 UK mpg
        self.assertEqual(c["co2"], 280)  # 450 g/mile -> 280 g/km

    def test_map_vehicle_ev(self):
        c = server.map_vehicle(EV)
        self.assertEqual((c["fuel"], c["drive"], c["asp"], c["co2"], c["range"]), ("Electric", "AWD", "electric", 0, 322))

    def test_fuel_mapping(self):
        f = lambda ft, atv="": server.fuel_of({"fuelType": ft, "atvType": atv})
        self.assertEqual(f("Diesel"), "Diesel")
        self.assertEqual(f("Regular", "Hybrid"), "Hybrid")
        self.assertEqual(f("Premium and Electricity", "Plug-in Hybrid"), "Plug-in hybrid")
        self.assertEqual(f("Gasoline or E85"), "Flex fuel")
        self.assertEqual(f("Regular"), "Petrol")

    def test_rate_limiter_refills(self):
        rl = server.RateLimiter(600, burst=2)
        self.assertEqual([rl.allow("a"), rl.allow("a"), rl.allow("a")], [True, True, False])
        self.assertTrue(rl.allow("b"))  # buckets are per IP
        time.sleep(0.15)
        self.assertTrue(rl.allow("a"))

    def test_ipv6_limited_per_home_network(self):
        rl = server.RateLimiter(60, burst=3)
        results = [rl.allow(f"2001:db8:1:2::{i:x}") for i in range(6)]  # one /64, rotating addresses
        self.assertEqual(results, [True, True, True, False, False, False])
        self.assertTrue(rl.allow("2001:db8:1:3::1"))  # a different home is unaffected

    def test_flooding_buckets_does_not_reset_active_limits(self):
        rl = server.RateLimiter(60, burst=2)
        rl.allow("198.51.100.1"); rl.allow("198.51.100.1")
        self.assertFalse(rl.allow("198.51.100.1"))
        stale = time.monotonic() - 3600
        rl.buckets.update({f"10.{i >> 16}.{(i >> 8) & 255}.{i & 255}": (2, stale) for i in range(50_001)})
        self.assertFalse(rl.allow("198.51.100.1"))  # still limited: only idle buckets were pruned
        self.assertLess(len(rl.buckets), 10)

    def test_menu_tolerates_bad_shapes(self):
        for bad in (None, [], "x", {"menuItem": "x"}, {"menuItem": [1, {"text": "no value"}]}):
            self.assertEqual(server.menu(bad), [], bad)

    def test_cache_is_bounded(self):
        c = server.TTLCache(size=3)
        for i in range(10):
            c.put(i, i)
        self.assertEqual(len(c.data), 3)
        self.assertIsNone(c.get(0))
        self.assertEqual(c.get(9), 9)


if __name__ == "__main__":
    unittest.main()
