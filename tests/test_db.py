"""Database importer + /api/db tests, including hostile input. Run: python3 -m unittest discover tests"""
import csv
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import http.client
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import build_db  # noqa: E402
import server  # noqa: E402

M4_SPECS = {
    "Engine Specs": {"Cylinders:": "L6", "Displacement:": "2979 Cm3", "Power:": "317 Kw @ 5500 Rpm\r\n431 Hp @ 5500 Rpm",
                     "Torque:": "406 Lb-Ft @ 1850 Rpm\r\n550 Nm @ 1850 Rpm", "Fuel System:": "Turbocharged Direct Injection",
                     "Fuel:": "Gasoline", "Fuel Capacity:": "15.9 Gallons (60 L)"},
    "Performance Specs": {"Top Speed:": "155 Mph (250 Km/H)", "Acceleration 0-62 Mph (0-100 Kph):": "4.1 S"},
    "Transmission Specs": {"Drive Type:": "Rear Wheel Drive", "Gearbox:": "7-Speed Dual-Clutch"},
    "Dimensions": {"Length:": "184.3 In (4681 Mm)", "Width:": "73.6 In (1869 Mm)", "Height:": "54.4 In (1382 Mm)",
                   "Wheelbase:": "110.7 In (2812 Mm)", "Cargo Volume:": "15.7 Cuft (445 L)"},
    "Weight Specs": {"Unladen Weight:": "3300 Lbs (1497 Kg)"},
    "Fuel Economy (Nedc)": {"Combined:": "28.5 Mpg Us (8.8 L/100Km)", "Co2 Emissions:": "204 G/Km"},
}
EV_SPECS = {"Engine Specs": {"Fuel:": "Electric", "Total Maximum Power:": "450 Hp", "Total Maximum Torque:": "639 Nm"},
            "Power System Specs": {"Range:": "315 Miles (507 Km)", "Nominal Capacity:": "75 kWh"},
            "Transmission Specs": {"Drive Type:": "All Wheel Drive"}}


def write_fixture(d):
    with open(d / "brands.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "url_hash", "url", "name", "logo", "created_at", "updated_at", ""])
        for i, (slug, name) in enumerate([("bmw", "BMW"), ("mercedes-benz", "MERCEDES BENZ"), ("tesla", "TESLA")]):
            w.writerow([i, "x", f"https://www.autoevolution.com/{slug}/", name, "", "", "", ""])
    good_img = "https://s1.cdn.autoevolution.com/images/gallery/BMW-M4-5086_3.jpg"
    with open(d / "automobiles.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "brand_id", "name", "url", "image", "price", "engine_id", "engine_name", "engine_specs", "created_at", "updated_at"])
        # source columns are shifted: url in "name", title in "image", photos in "engine_name"
        w.writerow([1, "a", "https://www.autoevolution.com/cars/bmw-m4-2014.html", "1", "BMW M4 Coupe (F82) 2014-2020 Photos, engines &amp; full specs ", "", "", json.dumps([good_img]), "", "", ""])
        w.writerow([2, "b", "https://www.autoevolution.com/cars/mercedes-benz-evil-2020.html", "1",
                    "MERCEDES BENZ <script>alert(1)</script>Evil 2020-Present Photos, engines &amp; full specs ", "", "",
                    json.dumps(["javascript:alert(1)", "https://evil.example/x.jpg", "https://s1.cdn.autoevolution.com/images/../../x.jpg\"onerror=\"x"]), "", "", ""])
        w.writerow([3, "c", "https://www.autoevolution.com/cars/tesla-model-3-2024.html", "1", "2025 Tesla Model 3 Photos, engines &amp; full specs ", "", "", "not json", "", "", ""])
        w.writerow([4, "d", "https://www.autoevolution.com/cars/unknownbrand-x-2000.html", "1", "Nope 2000-2001", "", "", "[]", "", "", ""])
    with open(d / "engines.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "other_id", "automobile_id", "name", "specs", "created_at", "updated_at"])
        w.writerow([10, 0, 1, "3.0L 7AT RWD (431 HP)", json.dumps(M4_SPECS), "", ""])
        bad = json.loads(json.dumps(M4_SPECS))
        bad["Engine Specs"]["Power:"] = "99999 Hp"            # scrape error -> dropped
        bad["Dimensions"]["Wheelbase:"] = "(9000 Mm)"           # longer than the car -> dropped
        w.writerow([11, 0, 2, "<img src=x onerror=alert(1)>Evil (99999 HP)", json.dumps(bad), "", ""])
        w.writerow([12, 0, 3, "Performance AWD", json.dumps(EV_SPECS), "", ""])
        w.writerow([13, 0, 3, "Broken", "{not json", "", ""])
        w.writerow([14, 0, 999, "Orphan", json.dumps(M4_SPECS), "", ""])


class BuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        write_fixture(d)
        cls.db_path = d / "cars.db"
        build_db.build(d, cls.db_path)
        cls.db = sqlite3.connect(cls.db_path)
        cls.db.row_factory = sqlite3.Row

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        cls.tmp.cleanup()

    def row(self, eid):
        return self.db.execute("SELECT e.*, m.brand, m.name AS model, m.year_from, m.year_to, m.image FROM engines e JOIN models m ON m.id = e.model_id WHERE e.id = ?", [eid]).fetchone()

    def test_parses_units(self):
        r = self.row(10)
        self.assertEqual((r["brand"], r["model"], r["year_from"], r["year_to"]), ("BMW", "M4 Coupe (F82)", 2014, 2020))
        self.assertEqual((r["hp"], r["nm"], r["kg"], r["top"], r["tank"], r["co2"]), (431, 550, 1497, 155, 60, 204))
        self.assertEqual((r["length"], r["width"], r["height"], r["wheelbase"], r["cargo"]), (4681, 1869, 1382, 2812, 445))
        self.assertEqual(r["mpg"], 32)          # 8.8 L/100km -> 32 UK mpg
        self.assertEqual(r["z60"], 3.9)         # 4.1 s to 62 -> ~3.9 s to 60
        self.assertEqual((r["fuel"], r["drive"], r["asp"], r["engine"], r["body"]), ("Petrol", "RWD", "turbo", "3.0L 6-cyl turbo", "coupe"))

    def test_ev_and_new_title_format(self):
        r = self.row(12)
        self.assertEqual((r["brand"], r["model"], r["year_from"]), ("Tesla", "Model 3", 2025))
        self.assertEqual((r["fuel"], r["hp"], r["nm"], r["range"], r["batt"], r["co2"], r["asp"], r["drive"]),
                         ("Electric", 450, 639, 315, 75, 0, "electric", "AWD"))

    def test_hostile_rows_are_cleaned(self):
        r = self.row(11)
        self.assertEqual(r["brand"], "Mercedes-Benz")
        self.assertNotIn("<", r["model"] + r["name"])        # tags stripped from titles and names
        self.assertIsNone(r["image"])                         # javascript:, foreign host and traversal URLs all rejected
        self.assertIsNone(r["hp"])                            # impossible value dropped, not stored
        self.assertIsNone(r["wheelbase"])
        self.assertEqual(r["year_to"], None)                  # "Present"

    def test_bad_rows_skipped(self):
        ids = {r[0] for r in self.db.execute("SELECT id FROM engines")}
        self.assertEqual(ids, {10, 11, 12})                   # broken JSON and orphan engine skipped
        brands = {r[0] for r in self.db.execute("SELECT brand FROM models")}
        self.assertNotIn("Nope", brands)

    def test_only_cdn_images(self):
        for (img,) in self.db.execute("SELECT image FROM models WHERE image IS NOT NULL"):
            self.assertRegex(img, build_db.IMG_RE)

    def test_zip_extract_uses_fixed_names(self):
        src = Path(build_db.__file__).read_text()
        self.assertIn('for n in ("brands.csv", "automobiles.csv", "engines.csv")', src)  # no extractall (zip-slip)
        self.assertNotIn("extractall", src)


class DbApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BuilderTests.setUpClass()
        cls.fixture = BuilderTests
        cls.patch = mock.patch.object(server, "DB_PATH", BuilderTests.db_path)
        cls.patch.start()
        server.DB_FUELS.clear()
        cls.srv = server.make_server("127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.patch.stop()
        server.DB_FUELS.clear()
        BuilderTests.tearDownClass()

    def setUp(self):
        server.limiter = server.RateLimiter(100_000)

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)

    def test_meta(self):
        s, m = self.get("/api/db/meta")
        self.assertEqual((s, m["brands"], m["models"], m["versions"]), (200, 3, 3, 3))
        self.assertIn("Electric", m["fuels"])

    def test_cascade_and_filters(self):
        self.assertEqual(self.get("/api/db/brands")[1], ["BMW", "Mercedes-Benz", "Tesla"])
        self.assertEqual(self.get("/api/db/brands?fuel=Electric")[1], ["Tesla"])
        self.assertEqual(self.get("/api/db/brands?decade=2010")[1], ["BMW"])  # the Mercedes fixture starts in 2020
        self.assertEqual(self.get("/api/db/brands?decade=2020")[1], ["BMW", "Mercedes-Benz", "Tesla"])  # BMW ran to 2020
        models = self.get("/api/db/models?brand=BMW")[1]
        self.assertEqual(models, [{"id": 1, "name": "M4 Coupe (F82)", "from": 2014, "to": 2020}])
        self.assertEqual(self.get("/api/db/versions?model=1")[1], [{"id": 10, "text": "3.0L 7AT RWD (431 HP)", "fuel": "Petrol"}])

    def test_car_record(self):
        s, c = self.get("/api/db/car?id=10")
        self.assertEqual((s, c["id"], c["make"], c["model"], c["source"], c["years"]), (200, "db-10", "BMW", "M4 Coupe (F82)", "db", [2014, 2020]))
        self.assertEqual(c["dims"], {"length": 4681, "width": 1869, "height": 1382, "wheelbase": 2812})
        self.assertNotIn("model_id", c)
        s, c = self.get("/api/db/car?id=11")
        self.assertIsNone(c["dims"])  # missing wheelbase -> no outline rather than a wrong one

    def test_sql_injection_rejected(self):
        for path in ["/api/db/brands?fuel=Petrol'%20OR%20'1'='1", "/api/db/brands?fuel=Petrol%3B%20DROP%20TABLE%20engines",
                     "/api/db/brands?decade=2010%20OR%201=1", "/api/db/brands?decade=2015", "/api/db/brands?decade=1",
                     "/api/db/models?brand=", "/api/db/models?brand=BMW%22%3B",
                     "/api/db/versions?model=1%20OR%201=1", "/api/db/versions?model=-1", "/api/db/car?id=10%20UNION%20SELECT%201",
                     "/api/db/car?id=", "/api/db/car?id=123456789"]:
            self.assertEqual(self.get(path)[0], 400, path)
        self.assertEqual(self.get("/api/db/meta")[1]["versions"], 3)  # tables intact

    def test_brand_text_that_looks_like_sql_is_just_text(self):
        # allowed characters can still look odd; bound parameters mean they only ever match literally
        for brand in ["BMW%20or%201", "BMW'%20--", "BMW'%20OR%20'1'%3D'1"]:
            status, body = self.get("/api/db/models?brand=" + brand)
            self.assertTrue(status == 400 or (status, body) == (200, []), brand)  # rejected, or matched literally (nothing)

    def test_unknown_car_404(self):
        self.assertEqual(self.get("/api/db/car?id=99999")[0], 404)

    def test_database_is_read_only(self):
        with self.assertRaises(sqlite3.OperationalError):
            server.db().execute("DELETE FROM engines")

    def test_missing_database_is_503(self):
        with mock.patch.object(server, "DB_PATH", Path("/nonexistent/cars.db")), mock.patch.object(server, "_local", threading.local()):
            server._local.db = None
            self.assertEqual(self.get("/api/db/meta")[0], 503)


if __name__ == "__main__":
    unittest.main()
