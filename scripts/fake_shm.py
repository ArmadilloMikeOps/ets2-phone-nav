#!/usr/bin/env python3
"""Імітатор плагіна: пише правдоподібний стан (рейс з-під Будапешта в Реймс),
щоб розробляти companion і веб-клієнт без запущеної гри.

    python3 -I scripts/fake_shm.py [--game ats] [--path F] [--route] [--events] [--fast N]
    ETS2NAV_SHM=/tmp/ets2-phone-nav-fake.shm node companion/server.ts --port 8421

  --route   їхати вздовж справжнього маршруту від маршрутизатора (router/router.ts, порт 8430),
            а не навпростець полями — щоб перевіряти лінію маршруту й підказки поворотів
  --events  за розкладом підкидати події: штраф (20 с), аварія + штраф за зіткнення (35 с),
            платна дорога (50 с), далі по колу
  --fast N  прискорення руху вздовж маршруту (за замовчуванням 8×, щоб маневри йшли частіше)

За замовчуванням пише в /tmp/ets2-phone-nav-fake.shm, а не у файл гри:
обрізати файл, який гра тримає через mmap, означає покласти гру (SIGBUS).
"""
import json
import math
import struct
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAYOUT = json.loads((ROOT / "companion" / "layout.json").read_text())
FMT = {"u32": "<I", "s32": "<i", "f32": "<f", "f64": "<d", "u64": "<Q", "s64": "<q"}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


PATH = arg("--path", "/tmp/ets2-phone-nav-fake.shm")
game = "ats" if arg("--game") == "ats" else "eut2"
FOLLOW_ROUTE = "--route" in sys.argv
EVENTS = "--events" in sys.argv
FAST = float(arg("--fast", "8"))

buf = bytearray(LAYOUT["size"])
struct.pack_into("<II", buf, 0, LAYOUT["magic"], LAYOUT["version"])


def put(name, value):
    f = LAYOUT["fields"][name]
    if f["type"] == "str":
        raw = value.encode("utf-8")[: f["len"] - 1]
        buf[f["offset"] : f["offset"] + f["len"]] = raw + b"\0" * (f["len"] - len(raw))
    else:
        struct.pack_into(FMT[f["type"]], buf, f["offset"], value)


START = (28320.0, 17146.6)
static = {
    "game_id": game,
    "game_name": "Euro Truck Simulator 2 (fake)" if game == "eut2" else "American Truck Simulator (fake)",
    "paused": 0,
    "local_scale": 19.0,
    "fuel_capacity": 800.0,
    "fuel_avg": 0.32,
    "odometer": 48213.0,
    "truck_brand": "Scania", "truck_name": "S 2024e",
    "job_active": 1,
    "job_income": 48210,
    "job_planned_km": 1452,
    "job_cargo_mass": 18400.0,
    "job_cargo_units": 1,
    "job_cargo": "Мед",
    "job_src_city": "Budapest", "job_src_company": "Posped",
    "job_dst_city": "Reims", "job_dst_company": "Kaarfor",
    "job_src_city_id": "budapest", "job_src_company_id": "posped",
    "job_dst_city_id": "reims", "job_dst_company_id": "kaarfor",
}
for k, v in static.items():
    put(k, v)

wear = {"wear_engine": 0.03, "wear_transmission": 0.02, "wear_cabin": 0.05, "wear_chassis": 0.04, "wear_wheels": 0.07}
cargo_damage = 0.004
event_seq = 0


def heading_of(dx, dz):
    # курс SDK: частки оберту, 0 = північ (−z), проти год. стрілки
    bearing = math.degrees(math.atan2(dx, -dz)) % 360
    return 1 - bearing / 360


# ---------- траєкторія ----------

path = None  # [(x, z), ...] у світі гри
if FOLLOW_ROUTE:
    req = json.dumps({
        "game": game, "x": START[0], "y": 0, "z": START[1], "heading": heading_of(-20, -6),
        "dstCityId": "reims", "dstCompanyId": "kaarfor", "withXY": True,
    }).encode()
    with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8430/route", data=req), timeout=60) as r:
        res = json.load(r)
    if not res.get("ok"):
        sys.exit(f"маршрутизатор: {res.get('error')}")
    path = [tuple(p) for p in res["xy"]]
    print(f"їду маршрутом: {len(path)} точок, {res['distance'] / 1000:.0f} км світу, прискорення {FAST}×")
    START = path[0]

cum = [0.0]
if path:
    for i in range(1, len(path)):
        cum.append(cum[-1] + math.dist(path[i - 1], path[i]))


def position(t, speed):
    """позиція і курс на час t (с) при швидкості speed (м/с світу)"""
    if not path:
        x, z = START[0] - t * 20, START[1] - t * 6
        return x, z, heading_of(-20, -6)
    s = (t * speed * FAST) % cum[-1]
    lo, hi = 0, len(cum) - 1
    while lo < hi - 1:  # двійковий пошук відрізка
        mid = (lo + hi) // 2
        if cum[mid] <= s:
            lo = mid
        else:
            hi = mid
    (x1, z1), (x2, z2) = path[lo], path[lo + 1]
    seg = cum[lo + 1] - cum[lo] or 1
    k = (s - cum[lo]) / seg
    return x1 + (x2 - x1) * k, z1 + (z2 - z1) * k, heading_of(x2 - x1, z2 - z1)


def fire(event_id, amount, detail="", xp=0):
    global event_seq
    event_seq += 1
    put("event_id", event_id)
    put("event_detail", detail)
    put("event_revenue", amount)
    put("event_xp", xp)
    put("event_seq", event_seq)
    print(f"подія: {event_id} {detail} {amount}")


# ---------- цикл ----------

seq = 0
t0 = time.time()
game_time0 = 3 * 1440 + 14 * 60 + 25  # Чт 14:25
nav0 = 1_347_028.0
next_event = 20.0

with open(PATH, "wb") as fh:
    fh.write(buf)

print(f"fake {game} → {PATH}; Ctrl+C щоб зупинити")
while True:
    t = time.time() - t0
    speed = 22.0 + 2.5 * math.sin(t / 6)  # ~80 км/год з коливанням
    x, z, heading = position(t, speed)
    put("pos_x", x)
    put("pos_z", z)
    put("heading", heading)
    put("speed", speed)
    put("cruise", 22.2 if int(t / 20) % 2 == 0 else 0.0)
    put("rpm", 1100 + 300 * math.sin(t / 3))
    put("gear", 12)
    put("fuel", 412.0 - t * 0.05)
    put("fuel_range", 1180.0 - t * 0.15)
    put("fuel_warning", 0)
    put("parking_brake", 0)
    put("nav_distance", max(0.0, nav0 - t * speed * 19))
    put("nav_time", max(0.0, (nav0 - t * speed * 19) / 19.3))
    put("nav_speed_limit", 22.22 if int(t / 15) % 2 == 0 else 19.44)
    put("game_time", game_time0 + int(t * 19 / 60))
    put("next_rest_stop", 312 - int(t * 19 / 60))
    put("job_delivery_time", game_time0 + 26 * 60)

    if EVENTS and t >= next_event:
        phase = int(next_event) % 45
        if phase == 20:
            fire("player.fined", -300, "speeding")
        elif phase == 35:
            wear["wear_cabin"] += 0.021  # удар: кабіна +2,1 %, вантаж +3 %
            cargo_damage += 0.03
            fire("player.fined", -1500, "crash")
        else:
            fire("player.tollgate.paid", -12)
        next_event += 15

    for k, v in wear.items():
        put(k, v)
    put("job_cargo_damage", cargo_damage)

    seq += 2
    struct.pack_into("<I", buf, LAYOUT["seq"], seq)
    struct.pack_into("<I", buf, LAYOUT["seq_end"], seq)
    with open(PATH, "r+b") as fh:
        fh.write(buf)
    time.sleep(0.05)
