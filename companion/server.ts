// ETS2 Phone Nav: читає файл спільної пам'яті плагіна, роздає стан на телефон.
//
//   GET /                   — веб-клієнт (web/)
//   GET /events             — Server-Sent Events зі станом (~10 Гц, лише при зміні)
//   GET /api/state          — поточний стан JSON (для налагодження)
//   GET /api/route          — повна лінія поточного маршруту
//   GET /tiles/<name>.pmtiles — тайли карти з mapdata/out/tiles (з підтримкою HTTP Range)
//
// Без залежностей: Node ≥ 23.6 запускає .ts напряму. Працює на macOS і Windows.
// Запуск: node companion/server.ts [--port 8420]

import { openSync, readSync, readFileSync, existsSync, statSync, fstatSync, closeSync, createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces, homedir } from "node:os";
import { join, extname, normalize, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { toLngLat } from "../web/projection.js";
import { latestWallet } from "./save.ts";
import { coatOfArms } from "./coats.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// той самий шлях, що й у плагіні (plugin/src/plugin.cpp)
const DEFAULT_SHM = process.platform === "win32"
	? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ets2-phone-nav", "ets2-phone-nav.shm")
	: "/tmp/ets2-phone-nav.shm";
const SHM_PATH = process.env.ETS2NAV_SHM || DEFAULT_SHM;
const LAYOUT_PATH = join(ROOT, "companion", "layout.json");
const WEB_DIR = join(ROOT, "web");
const MAPDATA = join(ROOT, "mapdata", "out");
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8420;
const POLL_MS = 50;
const PUSH_MS = 100;
const STALE_MS = 3000;

// Файли тайлів, які віддаємо як /tiles/<ключ>.pmtiles (генерує scripts/setup-mapdata.sh)
const TILES: Record<string, string> = {
	world: join(MAPDATA, "tiles", "world.pmtiles"),
	ets2: join(MAPDATA, "tiles", "ets2.pmtiles"),
	ats: join(MAPDATA, "tiles", "ats.pmtiles"),
};

// Розібрані парсером дані карти — звідси координати компаній і міст призначення
const PARSED: Record<string, { dir: string; prefix: string }> = {
	eut2: { dir: join(MAPDATA, "ets2"), prefix: "europe" },
	ats: { dir: join(MAPDATA, "ats"), prefix: "usa" },
};

type Field = { offset: number; type: "u32" | "s32" | "f32" | "f64" | "u64" | "s64" | "str"; len: number };
type Layout = { magic: number; version: number; size: number; seq: number; seq_end: number; fields: Record<string, Field> };

const layout: Layout = JSON.parse(readFileSync(LAYOUT_PATH, "utf8"));
const buf = Buffer.alloc(layout.size);
const decoder = new TextDecoder();

type Snapshot = Record<string, unknown>;
type Status = "no-game" | "old-plugin" | "stale" | "paused" | "live";
type State = { status: Status; data: Snapshot | null; tiles: string[] };

const availableTiles = Object.keys(TILES).filter((k) => existsSync(TILES[k]));

let fd: number | null = null;
let lastSeq = -1;
let lastSeqChange = 0;
let state: State = { status: "no-game", data: null, tiles: availableTiles };

// ---------- дані карти: де саме точка призначення ----------

type Point = { x: number; y: number };
const places = new Map<string, { companies: Map<string, Point>; cities: Map<string, Point> } | null>();

function placesFor(game: string) {
	if (places.has(game)) return places.get(game)!;
	const p = PARSED[game];
	let result = null;
	if (p && existsSync(join(p.dir, `${p.prefix}-companies.json`))) {
		const companies = new Map<string, Point>();
		for (const c of JSON.parse(readFileSync(join(p.dir, `${p.prefix}-companies.json`), "utf8"))) {
			companies.set(`${c.cityToken}.${c.token}`, { x: c.x, y: c.y });
		}
		const cities = new Map<string, Point>();
		for (const c of JSON.parse(readFileSync(join(p.dir, `${p.prefix}-cities.json`), "utf8"))) {
			cities.set(c.token, { x: c.x, y: c.y });
		}
		result = { companies, cities };
		console.log(`мапдані ${game}: ${companies.size} компаній, ${cities.size} міст`);
	}
	places.set(game, result);
	return result;
}

function destination(d: Snapshot): Point | null {
	if (!d.job_active || !d.job_dst_city_id) return null;
	const p = placesFor(String(d.game_id));
	if (!p) return null;
	return p.companies.get(`${d.job_dst_city_id}.${d.job_dst_company_id}`) ?? p.cities.get(String(d.job_dst_city_id)) ?? null;
}

// ---------- маршрут (router/router.ts) ----------
//
// Прокладаємо, коли з'явилось нове призначення або вантажівка кілька секунд
// їде далеко від лінії маршруту. Прогрес (індекс найближчої точки) рахуємо тут,
// щоб клієнт малював лише залишок шляху. Саму лінію клієнт бере з /api/route.

const ROUTER = process.env.ETS2NAV_ROUTER ?? "http://127.0.0.1:8430";
const OFF_ROUTE_M = 600; // у «картографічних» метрах (≈ 30 м у світі гри)
const OFF_ROUTE_MS = 3000;
const ROUTE_RETRY_MS = 5000;

type LngLat = [number, number];
// dir — BranchType із навігатора: 0 прямо, 1–4 ліво, 11–14 право, 21–28 коло, 29 з'їзд з кола, −1 злиття, −3 прибуття, −4 пором
type Step = { dir: number; lonLat: LngLat; exit?: number; text?: string; at: number /* метри від початку маршруту */ };
type RouteInfo = {
	id: number; key: string; coords: LngLat[]; distance: number; duration: number;
	cum: number[]; // cum[i] — метри від початку маршруту до coords[i]
	steps: Step[];
};
type Maneuver = { dir: number; exit: number | null; text: string | null; dist: number; then_dir: number | null };
type RouteStatus = "none" | "pending" | "ok" | "error" | "no-router";

let route: RouteInfo | null = null;
let routeStatus: RouteStatus = "none";
let routeError = "";
let routeBusy = false;
let routeLastRequest = 0;
let routeLastKey = "";
let routeProgress = 0;
let routeAlong = 0; // метри від початку маршруту до проєкції вантажівки
let offRouteSince = 0;
let routeSeq = 0;
let maneuver: Maneuver | null = null;

// Метри тут — «картографічні» (у проєкції на реальну географію). Для ETS2 це ≈ ігрові
// метри, які показує GPS гри (масштаб світу ~1:19 уже врахований проєкцією).
function metersBetween(a: LngLat, b: LngLat): number {
	const k = Math.cos((a[1] * Math.PI) / 180) * 111320;
	return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * 110540);
}

// відстань від точки p до відрізка ab і частка t уздовж відрізка (рівнопроміжна проєкція — на таких відстанях досить)
function distToSegment(p: LngLat, a: LngLat, b: LngLat): { dist: number; t: number } {
	const k = Math.cos((p[1] * Math.PI) / 180) * 111320;
	const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * 110540;
	const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * 110540;
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
	return { dist: Math.hypot(ax + t * dx, ay + t * dy), t };
}

// найближчий відрізок маршруту: спершу у вікні біля попереднього прогресу, далі — по всьому маршруту
function locateOnRoute(p: LngLat, coords: LngLat[], from: number): { index: number; dist: number; t: number } {
	const scan = (lo: number, hi: number) => {
		let best = { index: lo, dist: Infinity, t: 0 };
		for (let i = Math.max(0, lo); i < Math.min(coords.length - 1, hi); i++) {
			const d = distToSegment(p, coords[i], coords[i + 1]);
			if (d.dist < best.dist) best = { index: i, dist: d.dist, t: d.t };
		}
		return best;
	};
	const near = scan(from - 20, from + 400);
	return near.dist <= OFF_ROUTE_M ? near : scan(0, coords.length);
}

function buildRoute(key: string, r: { coords: LngLat[]; distance: number; duration: number; steps?: Omit<Step, "at">[] }): RouteInfo {
	const cum = [0];
	for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + metersBetween(r.coords[i - 1], r.coords[i]));
	// прив'язуємо кожен маневр до найближчої точки лінії, рухаючись лише вперед
	const steps: Step[] = [];
	let from = 0;
	for (const s of r.steps ?? []) {
		let best = from, bestD = Infinity;
		for (let i = from; i < r.coords.length; i++) {
			const d = metersBetween(s.lonLat, r.coords[i]);
			if (d < bestD) { bestD = d; best = i; }
		}
		steps.push({ ...s, at: cum[best] });
		from = best;
	}
	return { id: ++routeSeq, key, coords: r.coords, distance: r.distance, duration: r.duration, cum, steps };
}

// наступний «справжній» маневр попереду (прямо через перехрестя не показуємо)
function nextManeuver(rt: RouteInfo, along: number): Maneuver | null {
	const ahead = rt.steps.filter((s) => s.dir !== 0 && s.at > along + 10);
	const next = ahead[0];
	if (!next) return null;
	const then = ahead[1] && ahead[1].at - next.at < 1000 ? ahead[1].dir : null;
	return { dir: next.dir, exit: next.exit ?? null, text: next.text ?? null, dist: next.at - along, then_dir: then };
}

async function requestRoute(d: Snapshot, key: string) {
	routeBusy = true;
	routeLastRequest = Date.now();
	routeLastKey = key;
	if (!route || route.key !== key) routeStatus = "pending";
	try {
		const res = await fetch(`${ROUTER}/route`, {
			method: "POST",
			body: JSON.stringify({
				game: d.game_id, x: d.pos_x, y: d.pos_y, z: d.pos_z, heading: d.heading,
				dstCityId: d.job_dst_city_id, dstCompanyId: d.job_dst_company_id,
			}),
			signal: AbortSignal.timeout(30000),
		});
		const r = await res.json();
		if (r.ok && r.coords.length > 1) {
			route = buildRoute(key, r);
			routeStatus = "ok";
			routeProgress = 0;
			routeAlong = 0;
			offRouteSince = 0;
		} else {
			routeStatus = "error";
			routeError = r.error ?? "порожній маршрут";
		}
	} catch (e) {
		routeStatus = "no-router";
		routeError = String((e as Error).message ?? e);
	} finally {
		routeBusy = false;
	}
}

function updateRoute(d: Snapshot, live: boolean) {
	if (!d.job_active || !d.job_dst_company_id) {
		route = null;
		routeStatus = "none";
		routeLastKey = "";
		maneuver = null;
		return;
	}
	const key = `${d.game_id}:${d.job_dst_city_id}.${d.job_dst_company_id}`;
	const truck = toLngLat(String(d.game_id), Number(d.pos_x), Number(d.pos_z)) as LngLat;

	let need = !route || route.key !== key;
	if (route && route.key === key) {
		const at = locateOnRoute(truck, route.coords, routeProgress);
		if (at.dist <= OFF_ROUTE_M) {
			routeProgress = at.index;
			routeAlong = route.cum[at.index] + at.t * (route.cum[at.index + 1] - route.cum[at.index]);
			offRouteSince = 0;
			maneuver = nextManeuver(route, routeAlong);
		} else {
			offRouteSince ||= Date.now();
			need = Date.now() - offRouteSince > OFF_ROUTE_MS;
			maneuver = null; // з маршруту з'їхали — стара підказка вводить в оману
		}
	} else {
		maneuver = null;
	}
	const freshKey = key !== routeLastKey;
	if (live && need && !routeBusy && (freshKey || Date.now() - routeLastRequest > ROUTE_RETRY_MS)) {
		void requestRoute(d, key);
	}
}

// ---------- сповіщення: штрафи, аварії, доставки ----------
//
// Ігрові події приходять від плагіна (event_seq/event_id/…). Окремої події «аварія» в SDK
// немає, тож ловимо стрибок пошкодження вантажівки чи вантажу; дрібні прирости, що йдуть
// один за одним (удар, скрегіт об відбійник), збираємо у вікні й показуємо одним сповіщенням.

type Alert = { seq: number; kind: "good" | "bad" | "info"; title: string; text: string };
let alert: Alert | null = null;
let alertSeq = 0;
let lastEventSeq: number | null = null;
let lastGameId = "";

const OFFENCES: Record<string, string> = {
	crash: "зіткнення",
	avoid_sleeping: "ігнорування відпочинку",
	wrong_way: "їзда по зустрічній",
	speeding_camera: "камера швидкості",
	no_lights: "їзда без фар",
	red_signal: "проїзд на червоне",
	speeding: "перевищення швидкості",
	avoid_weighing: "оминання зважування",
	illegal_trailer: "заборонений причіп",
	avoid_inspection: "оминання перевірки",
	illegal_border_crossing: "незаконний перетин кордону",
	hard_shoulder_violation: "їзда узбіччям",
	damaged_vehicle_usage: "несправна вантажівка",
	generic: "порушення",
};

const DAMAGE_STEP = 0.002; // приріст пошкодження за кадр, що вважаємо ударом (0,2 %)
const DAMAGE_WINDOW_MS = 1500;
const WEAR_KEYS = ["wear_engine", "wear_transmission", "wear_cabin", "wear_chassis", "wear_wheels"] as const;
let prevWear: number[] | null = null;
let prevCargo: number | null = null;
let hit: { since: number; truck: number; cargo: number } | null = null;

function money(d: Snapshot, amount: number) {
	const cur = d.game_id === "ats" ? "$" : "€";
	return `${Math.abs(Math.round(amount)).toLocaleString("uk-UA")} ${cur}`;
}

function raise(kind: Alert["kind"], title: string, text: string) {
	alert = { seq: ++alertSeq, kind, title, text };
	console.log(`сповіщення: ${title} — ${text}`);
}

// ---------- гаманець і кредит (зі збереження гри, див. save.ts) ----------

const moneyEvents: { t: number; amount: number }[] = [];

function walletFor(d: Snapshot) {
	const { wallet, error } = latestWallet(String(d.game_id));
	if (!wallet) return error ? { error } : null;
	// збереження відстає від гри: додаємо грошові події, що сталися після нього
	const after = moneyEvents.filter((e) => e.t > wallet.saved_at);
	const delta = after.reduce((s, e) => s + e.amount, 0);
	return {
		money: wallet.money + delta,
		money_saved: wallet.money,
		adjusted: after.length > 0,
		loan: wallet.loan,
		loan_original: wallet.loan_original,
		loan_limit: wallet.loan_limit,
		loans: wallet.loans,
		saved_at: wallet.saved_at,
		error,
	};
}

function updateAlerts(d: Snapshot) {
	// перша прочитана подія або зміна гри — це історія, а не новина
	const ev = Number(d.event_seq);
	if (lastEventSeq === null || d.game_id !== lastGameId) {
		lastEventSeq = ev;
		lastGameId = String(d.game_id);
		prevWear = prevCargo = null;
	} else if (ev !== lastEventSeq) {
		lastEventSeq = ev;
		const amount = Number(d.event_revenue);
		switch (d.event_id) {
			case "player.fined": {
				const offence = OFFENCES[String(d.event_detail)] ?? String(d.event_detail || "порушення");
				raise("bad", `Штраф ${money(d, amount)}`, offence[0].toUpperCase() + offence.slice(1));
				break;
			}
			case "job.delivered":
				raise("good", "Вантаж доставлено", `+${money(d, amount)}, +${d.event_xp} XP`);
				break;
			case "job.cancelled":
				raise("bad", "Завдання скасовано", `штраф ${money(d, amount)}`);
				break;
			case "player.tollgate.paid":
				raise("info", "Платна дорога", money(d, amount));
				break;
		}
		// для гаманця між збереженнями: дохід (+) або штраф/оплата (−), з часом події
		if (["player.fined", "job.delivered", "job.cancelled", "player.tollgate.paid"].includes(String(d.event_id))) {
			moneyEvents.push({ t: Date.now(), amount });
			if (moneyEvents.length > 200) moneyEvents.shift();
		}
	}

	// пошкодження: сума приростів по кожному вузлу вантажівки (удар б'є по кабіні, а не по
	// «найгіршому» вузлу) + приріст пошкодження вантажу
	const wear = WEAR_KEYS.map((k) => Number(d[k]) || 0);
	const cargo = d.job_active ? Number(d.job_cargo_damage) || 0 : 0;
	if (prevWear !== null && prevCargo !== null) {
		const dt = wear.reduce((sum, w, i) => sum + Math.max(0, w - prevWear![i]), 0);
		const dc = Math.max(0, cargo - prevCargo);
		if (dt >= DAMAGE_STEP || dc >= DAMAGE_STEP || (hit && (dt > 0 || dc > 0))) {
			hit ??= { since: Date.now(), truck: 0, cargo: 0 };
			hit.truck += dt;
			hit.cargo += dc;
		}
	}
	prevWear = wear; // ремонт зменшує знос — просто приймаємо нове значення як базу
	prevCargo = cargo;
	if (hit && Date.now() - hit.since > DAMAGE_WINDOW_MS) {
		const parts = [];
		if (hit.truck >= 0.0005) parts.push(`вантажівка +${(hit.truck * 100).toFixed(1)} %`);
		if (hit.cargo >= 0.0005) parts.push(`вантаж +${(hit.cargo * 100).toFixed(1)} %`);
		if (parts.length) raise("bad", "Аварія", `Пошкодження: ${parts.join(", ")}`);
		hit = null;
	}
}

// ---------- читання shm ----------

const TORN = Symbol("torn");
const OLD = Symbol("old-plugin");

function closeShm() {
	if (fd !== null) closeSync(fd);
	fd = null;
}

function readShm(): Snapshot | null | typeof TORN | typeof OLD {
	// Файл могли видалити й створити заново (перезапуск гри, імітатор) —
	// тоді відкритий дескриптор указує на старий inode, і ми читали б застиглі дані.
	const st = existsSync(SHM_PATH) ? statSync(SHM_PATH) : null;
	if (!st || st.size < 8) {
		closeShm();
		return null;
	}
	if (fd !== null && fstatSync(fd).ino !== st.ino) closeShm();
	if (fd === null) fd = openSync(SHM_PATH, "r");
	try {
		readSync(fd, buf, 0, layout.size, 0);
	} catch {
		closeShm();
		return null;
	}
	if (buf.readUInt32LE(0) !== layout.magic) return null;
	if (buf.readUInt32LE(4) !== layout.version || st.size < layout.size) return OLD;
	const seq = buf.readUInt32LE(layout.seq);
	if (seq % 2 !== 0 || seq !== buf.readUInt32LE(layout.seq_end)) return TORN; // кадр саме пишеться — пропускаємо

	if (seq !== lastSeq) {
		lastSeq = seq;
		lastSeqChange = Date.now();
	}

	const out: Snapshot = {};
	for (const [name, f] of Object.entries(layout.fields)) {
		switch (f.type) {
			case "u32": out[name] = buf.readUInt32LE(f.offset); break;
			case "s32": out[name] = buf.readInt32LE(f.offset); break;
			case "f32": out[name] = buf.readFloatLE(f.offset); break;
			case "f64": out[name] = buf.readDoubleLE(f.offset); break;
			case "u64": out[name] = Number(buf.readBigUInt64LE(f.offset)); break;
			case "s64": out[name] = Number(buf.readBigInt64LE(f.offset)); break;
			case "str": {
				const end = buf.indexOf(0, f.offset);
				out[name] = decoder.decode(buf.subarray(f.offset, end < 0 || end > f.offset + f.len ? f.offset + f.len : end));
				break;
			}
		}
	}
	const dest = destination(out);
	out.dest_x = dest?.x ?? null;
	out.dest_y = dest?.y ?? null;
	return out;
}

function poll() {
	const data = readShm();
	if (data === TORN) return; // наступна спроба за POLL_MS
	if (data === OLD) {
		state = { status: "old-plugin", data: null, tiles: availableTiles };
		return;
	}
	if (data === null) {
		state = { status: "no-game", data: null, tiles: availableTiles };
		return;
	}
	const paused = data.paused === 1;
	const stale = !paused && Date.now() - lastSeqChange > STALE_MS;
	const status = stale ? "stale" : paused ? "paused" : "live";
	updateRoute(data, status === "live");
	data.route_id = route?.id ?? null;
	data.route_progress = routeProgress;
	data.route_status = routeStatus;
	data.route_error = routeStatus === "error" || routeStatus === "no-router" ? routeError : null;
	data.maneuver = maneuver;
	updateAlerts(data);
	data.alert = alert;
	data.wallet = walletFor(data);
	state = { status, data, tiles: availableTiles };
}

// ---------- SSE ----------

const clients = new Set<ServerResponse>();
let lastPushed = "";

function push() {
	const json = JSON.stringify(state);
	if (json === lastPushed) return;
	lastPushed = json;
	for (const res of clients) res.write(`data: ${json}\n\n`);
}

setInterval(poll, POLL_MS);
setInterval(push, PUSH_MS);
// keep-alive, щоб iOS/роутер не рвали тихе з'єднання
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 15000);

// ---------- HTTP ----------

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
};

// pmtiles читає архів шматками через Range-запити
function serveRange(req: IncomingMessage, res: ServerResponse, file: string) {
	const size = statSync(file).size;
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
	const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "max-age=3600" };
	if (!m) {
		res.writeHead(200, { ...headers, "Content-Length": size });
		createReadStream(file).pipe(res);
		return;
	}
	let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
	let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
	start = Math.max(0, start);
	end = Math.min(end, size - 1);
	if (start > end) {
		res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
		return;
	}
	res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
	createReadStream(file, { start, end }).pipe(res);
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://x");

	if (url.pathname === "/events") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(`retry: 1000\ndata: ${JSON.stringify(state)}\n\n`);
		clients.add(res);
		req.on("close", () => clients.delete(res));
		return;
	}

	if (url.pathname === "/api/state") {
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
		res.end(JSON.stringify(state, null, 2));
		return;
	}

	if (url.pathname === "/api/coa") {
		const game = url.searchParams.get("game") ?? "";
		const city = url.searchParams.get("city") ?? "";
		coatOfArms(MAPDATA, game, city).then(
			(u) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }); res.end(JSON.stringify({ url: u })); },
			() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ url: null })); },
		);
		return;
	}

	if (url.pathname === "/api/route") {
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
		res.end(JSON.stringify(route ? { id: route.id, coords: route.coords, distance: route.distance, duration: route.duration } : null));
		return;
	}

	const tile = /^\/tiles\/(\w+)\.pmtiles$/.exec(url.pathname);
	if (tile) {
		const file = TILES[tile[1]];
		if (!file || !existsSync(file)) {
			res.writeHead(404).end("no tiles");
			return;
		}
		serveRange(req, res, file);
		return;
	}

	const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	const file = normalize(join(WEB_DIR, rel));
	if (!file.startsWith(WEB_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
	res.end(readFileSync(file));
});

server.listen(PORT, "0.0.0.0", () => {
	const ips = Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && i.family === "IPv4" && !i.internal)
		.map((i) => i!.address);
	console.log(`ETS2 Phone Nav слухає порт ${PORT}`);
	for (const ip of ips) console.log(`  на iPhone відкрий:  http://${ip}:${PORT}`);
	console.log(`  налагодження:       http://localhost:${PORT}/api/state`);
	console.log(`  тайли карти:        ${availableTiles.join(", ") || "немає (див. mapdata/)"}`);
});
