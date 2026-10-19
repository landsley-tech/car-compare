"""Car Compare server: serves the web app and a hardened proxy to the US EPA fueleconomy.gov API.

Standard library only. Run: python3 server.py  (then open http://127.0.0.1:8000)
"""
import ipaddress
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"  # only set when behind Caddy / Cloudflare Tunnel
MAX_CONN = int(os.environ.get("MAX_CONN", "64"))
MAX_CONN_PER_IP = int(os.environ.get("MAX_CONN_PER_IP", "16"))
RATE_PER_MIN = int(os.environ.get("RATE_PER_MIN", "120"))
EPA = "https://www.fueleconomy.gov/ws/rest/vehicle/"
WEB = Path(__file__).resolve().parent / "web"

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json"}
# Built once at startup: request paths are looked up in this dict, never joined onto the filesystem.
STATIC = {"/" + str(p.relative_to(WEB)).replace(os.sep, "/"): (p.read_bytes(), TYPES[p.suffix])
          for p in WEB.rglob("*") if p.is_file() and p.suffix in TYPES}
STATIC["/"] = STATIC["/index.html"]

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
       # ponytail: style attributes carry per-car colour variables; all data is escaped and scripts are 'self' only.
       "style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data: https://s1.cdn.autoevolution.com; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
}

TEXT_RE = re.compile(r"^[\w .,&()'/+-]{1,80}$")
YEAR_MIN, YEAR_MAX = 1984, time.gmtime().tm_year + 1


class RateLimiter:
    """Token bucket per client IP."""

    def __init__(self, per_min, burst=None):
        self.rate, self.cap = per_min / 60, burst or max(10, per_min // 2)
        self.buckets, self.lock = {}, threading.Lock()

    def allow(self, ip):
        now = time.monotonic()
        with self.lock:
            if len(self.buckets) > 50_000:  # stop a spoofed-IP flood from eating memory
                self.buckets.clear()
            tokens, last = self.buckets.get(ip, (self.cap, now))
            tokens = min(self.cap, tokens + (now - last) * self.rate)
            ok = tokens >= 1
            self.buckets[ip] = (tokens - 1 if ok else tokens, now)
            return ok


class TTLCache:
    def __init__(self, size=4000, ttl=86400):
        self.size, self.ttl, self.data, self.lock = size, ttl, OrderedDict(), threading.Lock()

    def get(self, key):
        with self.lock:
            hit = self.data.get(key)
            if hit and hit[0] > time.monotonic():
                self.data.move_to_end(key)
                return hit[1]

    def put(self, key, value):
        with self.lock:
            self.data[key] = (time.monotonic() + self.ttl, value)
            self.data.move_to_end(key)
            while len(self.data) > self.size:
                self.data.popitem(last=False)


cache = TTLCache()
upstream_slots = threading.BoundedSemaphore(4)  # we never hammer the EPA, however hard we are hit


class UpstreamError(Exception):
    pass


def epa_get(path, **params):
    url = EPA + path + ("?" + urllib.parse.urlencode(params) if params else "")
    hit = cache.get(url)
    if hit is not None:
        return hit
    if not upstream_slots.acquire(timeout=5):
        raise UpstreamError("busy")
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "car-compare/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read(2_000_000) or b"null")
    except (OSError, ValueError) as e:
        raise UpstreamError(str(e)) from e
    finally:
        upstream_slots.release()
    cache.put(url, data)
    return data


def menu(data):
    items = (data or {}).get("menuItem", [])
    return [items] if isinstance(items, dict) else items  # EPA returns a bare object when there is one item


def fuel_of(v):
    f, atv = v.get("fuelType", ""), v.get("atvType", "")
    if f == "Electricity" or atv == "EV":
        return "Electric"
    if atv == "Plug-in Hybrid" or "Electricity" in f:
        return "Plug-in hybrid"
    if atv == "Hybrid":
        return "Hybrid"
    if "Diesel" in f:
        return "Diesel"
    if "E85" in f:
        return "Flex fuel"
    if "CNG" in f or "Natural Gas" in f:
        return "CNG"
    if "Hydrogen" in f:
        return "Hydrogen"
    return "Petrol"


def num(v, key):
    try:
        return float(v.get(key) or 0)
    except ValueError:
        return 0.0


def body_of(cls):
    cls = cls.lower()
    if "sport utility" in cls or "pickup" in cls or "van" in cls:
        return "suv"
    if "two seaters" in cls:
        return "roadster"
    if "wagon" in cls:
        return "hatch"
    if "minicompact" in cls:
        return "coupe"
    return "sedan"


def map_vehicle(v):
    """EPA record -> the app's car schema. US mpg -> UK mpg, g/mile -> g/km."""
    drive = v.get("drive", "")
    displ, cyl = num(v, "displ"), int(num(v, "cylinders"))
    fuel = fuel_of(v)
    asp = "electric" if fuel == "Electric" else "turbo" if v.get("tCharger") or v.get("sCharger") == "S" else "na"
    engine = "Electric motor " + v.get("evMotor", "") if fuel == "Electric" else \
        f"{displ:.1f}L {cyl}-cyl{' turbo' if v.get('tCharger') else ' supercharged' if v.get('sCharger') == 'S' else ''}"
    co2 = num(v, "co2TailpipeGpm")
    return {
        "id": "epa-" + str(v.get("id", "")), "source": "epa", "make": v.get("make", ""), "model": v.get("model", ""),
        "trim": f"{v.get('trany', '')}, {engine}".strip(", "), "year": int(num(v, "year")), "fuel": fuel,
        "engine": engine.strip(), "cc": round(displ * 1000) or None, "asp": asp,
        "drive": "AWD" if ("4-Wheel" in drive or "All-Wheel" in drive) else "RWD" if "Rear" in drive else "FWD" if "Front" in drive else drive,
        "box": v.get("trany", ""), "mpg": round(num(v, "comb08") * 1.201) or None,
        "co2": round(co2 / 1.609) if co2 > 0 else (0 if fuel == "Electric" else None),
        "range": round(num(v, "range")) or None, "cls": v.get("VClass", ""), "body": body_of(v.get("VClass", "")),
    }


def options_with_fuel(year, make, model):
    opts = menu(epa_get("menu/options", year=year, make=make, model=model))[:20]
    with ThreadPoolExecutor(4) as ex:
        cars = list(ex.map(lambda o: map_vehicle(epa_get(str(o["value"]))), opts))
    return [{"id": o["value"], "text": o["text"], "fuel": c["fuel"]} for o, c in zip(opts, cars)]


def text_param(q, name):
    v = q.get(name, [""])[0]
    if not TEXT_RE.fullmatch(v):
        raise ValueError(name)
    return v


def year_param(q):
    y = q.get("year", [""])[0]
    if not y.isdigit() or not YEAR_MIN <= int(y) <= YEAR_MAX:
        raise ValueError("year")
    return y


def id_param(q, name="id"):
    v = q.get(name, [""])[0]
    if not v.isdigit() or len(v) > 8:
        raise ValueError(name)
    return int(v)


# ---------- full database (data/cars.db, built by tools/build_db.py) ----------
DB_PATH = Path(__file__).resolve().parent / "data" / "cars.db"
_local = threading.local()


class DatabaseMissing(Exception):
    pass


def db():
    if not getattr(_local, "db", None):
        if not DB_PATH.exists():
            raise DatabaseMissing()
        _local.db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)  # read-only: the web can never write to it
        _local.db.row_factory = sqlite3.Row
    return _local.db


DB_FUELS = set()


def db_filters(q, alias="e"):
    """Optional fuel / decade filters -> (sql, params). Values are validated and always bound, never interpolated."""
    sql, params = [], []
    fuel = q.get("fuel", [""])[0]
    if fuel:
        if not DB_FUELS:
            DB_FUELS.update(r[0] for r in db().execute("SELECT DISTINCT fuel FROM engines WHERE fuel IS NOT NULL"))
        if fuel not in DB_FUELS:
            raise ValueError("fuel")
        sql.append(f"{alias}.fuel = ?")
        params.append(fuel)
    dec = q.get("decade", [""])[0]
    if dec:
        if not (dec.isdigit() and len(dec) == 4 and int(dec) % 10 == 0 and 1890 <= int(dec) <= 2030):
            raise ValueError("decade")
        sql.append("m.year_from <= ? AND COALESCE(m.year_to, 9999) >= ?")
        params += [int(dec) + 9, int(dec)]
    return sql, params


def where(clauses):
    return (" WHERE " + " AND ".join(clauses)) if clauses else ""


def db_car(row):
    c = dict(row)
    dims = {k: c.pop(k) for k in ("length", "width", "height", "wheelbase")}
    extra = {"id": f"db-{c.pop('id')}", "source": "db", "make": c.pop("brand"), "model": c.pop("model_name"),
             "trim": c.pop("name"), "year": c["year_from"], "years": [c.pop("year_from"), c.pop("year_to")],
             "dims": dims if all(dims.values()) else None}
    c.pop("model_id", None)
    return {**c, **extra}


def db_api(path, q):
    if path == "/api/db/meta":
        r = db().execute("SELECT (SELECT COUNT(DISTINCT brand) FROM models), (SELECT COUNT(*) FROM models), (SELECT COUNT(*) FROM engines),"
                         " (SELECT MIN(year_from) FROM models), (SELECT MAX(year_from) FROM models)").fetchone()
        fuels = [x[0] for x in db().execute("SELECT fuel FROM engines WHERE fuel IS NOT NULL GROUP BY fuel ORDER BY COUNT(*) DESC")]
        return {"brands": r[0], "models": r[1], "versions": r[2], "from": r[3], "to": r[4], "fuels": fuels,
                "decades": list(range(r[3] // 10 * 10, r[4] + 1, 10))}
    if path == "/api/db/brands":
        f, p = db_filters(q)
        return [x[0] for x in db().execute(f"SELECT DISTINCT m.brand FROM models m JOIN engines e ON e.model_id = m.id{where(f)} ORDER BY m.brand", p)]
    if path == "/api/db/models":
        f, p = db_filters(q)
        rows = db().execute(f"SELECT DISTINCT m.id, m.name, m.year_from, m.year_to FROM models m JOIN engines e ON e.model_id = m.id"
                            f"{where(['m.brand = ?'] + f)} ORDER BY m.year_from, m.name", [text_param(q, "brand")] + p)
        return [{"id": r[0], "name": r[1], "from": r[2], "to": r[3]} for r in rows]
    if path == "/api/db/versions":
        f, p = db_filters({"fuel": q.get("fuel", [""])})
        rows = db().execute(f"SELECT e.id, e.name, e.fuel, e.hp FROM engines e{where(['e.model_id = ?'] + f)} ORDER BY e.hp, e.name",
                            [id_param(q, "model")] + p)
        return [{"id": r[0], "text": r[1], "fuel": r[2]} for r in rows]
    if path == "/api/db/car":
        r = db().execute("SELECT e.*, m.brand, m.name AS model_name, m.year_from, m.year_to, m.image FROM engines e JOIN models m ON m.id = e.model_id"
                         " WHERE e.id = ?", [id_param(q)]).fetchone()
        if not r:
            raise LookupError()
        return db_car(r)
    return None


def api(path, q):
    if path.startswith("/api/db/"):
        return db_api(path, q)
    if path == "/api/epa/years":
        return list(range(YEAR_MAX, YEAR_MIN - 1, -1))
    if path == "/api/epa/makes":
        return [m["value"] for m in menu(epa_get("menu/make", year=year_param(q)))]
    if path == "/api/epa/models":
        return [m["value"] for m in menu(epa_get("menu/model", year=year_param(q), make=text_param(q, "make")))]
    if path == "/api/epa/options":
        return options_with_fuel(year_param(q), text_param(q, "make"), text_param(q, "model"))
    if path == "/api/epa/vehicle":
        return map_vehicle(epa_get(str(id_param(q))))
    return None


limiter = RateLimiter(RATE_PER_MIN)


class Handler(BaseHTTPRequestHandler):
    timeout = 10  # per-socket read timeout: slow clients are dropped instead of holding a thread

    def version_string(self):
        return "car-compare"  # don't advertise the Python version

    def client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get("CF-Connecting-IP") or self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            try:
                return str(ipaddress.ip_address(fwd))
            except ValueError:
                pass
        return self.client_address[0]

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", cache_secs=0):
        self.send_response(code)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"public, max-age={cache_secs}" if cache_secs else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj, cache_secs=0):
        self.send(code, json.dumps(obj).encode(), "application/json; charset=utf-8", cache_secs)

    def do_GET(self):
        if len(self.path) > 1024:
            return self.send(414, b"URI too long")
        if not limiter.allow(self.client_ip()):
            return self.send(429, b"Too many requests, slow down")
        url = urllib.parse.urlsplit(self.path)
        if url.path in STATIC:
            body, ctype = STATIC[url.path]
            return self.send(200, body, ctype, cache_secs=300)
        if not url.path.startswith("/api/"):
            return self.send(404, b"Not found")
        try:
            result = api(url.path, urllib.parse.parse_qs(url.query, max_num_fields=10))
        except ValueError as e:
            return self.send_json(400, {"error": f"invalid {e}"})
        except UpstreamError:
            return self.send_json(502, {"error": "EPA data service unavailable, try again shortly"})
        except LookupError:
            return self.send_json(404, {"error": "not found"})
        except DatabaseMissing:
            return self.send_json(503, {"error": "car database not built yet: run python3 tools/build_db.py"})
        if result is None:
            return self.send(404, b"Not found")
        self.send_json(200, result, cache_secs=3600)

    do_HEAD = do_GET

    def refuse(self):
        self.send(405, b"Method not allowed")

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = refuse

    def log_message(self, fmt, *args):
        print(f"{self.client_ip()} {fmt % args}", flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.slots, self.per_ip, self.lock = threading.BoundedSemaphore(MAX_CONN), {}, threading.Lock()

    def process_request(self, request, client_address):
        ip = client_address[0]
        with self.lock:
            busy = not TRUST_PROXY and self.per_ip.get(ip, 0) >= MAX_CONN_PER_IP
            if not busy:
                self.per_ip[ip] = self.per_ip.get(ip, 0) + 1
        if busy or not self.slots.acquire(blocking=False):
            if not busy:
                self._release_ip(ip)
            try:
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            return self.shutdown_request(request)
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            self._release_ip(ip)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()
            self._release_ip(client_address[0])

    def _release_ip(self, ip):
        with self.lock:
            n = self.per_ip.get(ip, 1) - 1
            if n:
                self.per_ip[ip] = n
            else:
                self.per_ip.pop(ip, None)


def make_server(host=HOST, port=PORT):
    return Server((host, port), Handler)


if __name__ == "__main__":
    srv = make_server()
    print(f"Car Compare running on http://{HOST}:{srv.server_address[1]}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
