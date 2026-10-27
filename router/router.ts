// ETS2 Phone Nav router: прокладає маршрут від вантажівки до компанії призначення.
//
// Обгортка над кодом навігатора truckermudgeon/maps (GPL-3):
//   - readGraphAndMapData        — граф доріг + R-дерева доріг/префабів
//   - calculateFromNodeAndDirection — з якого вузла й у який бік стартуємо
//   - findRoute (A*)             — сам маршрут
//   - getLineString              — лінія по вигинах доріг і перехресть
// Імпорти — за абсолютними шляхами з клону, бо пакет navigation не експортує ці модулі.
//
// Запуск (з каталогу клону, щоб знайшлися його залежності; scripts/start.* роблять це самі):
//   cd <клон trucksim-maps> && node --import tsx <цей репозиторій>/router/router.ts
//
//   POST /route  {game, x, y, z, heading, dstCityId, dstCompanyId}
//     → {ok, distance, duration, coords: [[lng, lat], ...], steps} | {ok: false, error}
//   GET  /health → {ready, maps}
//
// Змінні середовища: TRUCKSIM_MAPS (шлях до клону), ETS2NAV_ROUTER_PORT (8430),
// ETS2NAV_ROUTER_HOST (127.0.0.1; у WSL під Windows теж 127.0.0.1 — Windows бачить його через localhost).

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
// де шукати клон truckermudgeon/maps (його кладе scripts/setup-mapdata.sh)
const TSM = process.env.TRUCKSIM_MAPS
	?? [join(ROOT, ".trucksim-maps"), join(homedir(), ".trucksim-maps"), join(homedir(), "Projects", "trucksim-maps")]
		.find((d) => existsSync(join(d, "packages")))
	?? join(ROOT, ".trucksim-maps");
const PORT = Number(process.env.ETS2NAV_ROUTER_PORT ?? 8430);
const HOST = process.env.ETS2NAV_ROUTER_HOST ?? "127.0.0.1";
const DATA: Record<string, { dir: string; map: "europe" | "usa" }> = {
	eut2: { dir: join(ROOT, "mapdata", "out", "ets2"), map: "europe" },
	ats: { dir: join(ROOT, "mapdata", "out", "ats"), map: "usa" },
};

// на Windows import() не приймає «C:\…» — лише file:// URL
const mod = (p: string) => import(pathToFileURL(join(TSM, "packages", p)).href);
const { fromDir } = await mod("libs/io/index.ts");
const { readGraphAndMapData } = await mod("apis/navigation/infra/lookups/graph-and-map.ts");
const { calculateFromNodeAndDirection } = await mod("apis/navigation/domain/actor/generate-routes.ts");
const { findRoute } = await mod("libs/map/routing.ts");
const { getLineString } = await mod("libs/map/linestring.ts");
const { calculateSteps } = await mod("apis/navigation/domain/actor/guidance.ts");
const { ItemType, Ets2SelectableDlcs, AtsSelectableDlcs, toEts2DlcGuards, toAtsDlcGuards } = await mod("libs/map/constants.ts");
const { fromEts2CoordsToWgs84, fromAtsCoordsToWgs84 } = await mod("libs/map/projections.ts");

type Loaded = {
	gm: any;
	ctx: any;
	lookups: { ferriesByUid: Map<bigint, unknown>; companiesByPrefab: Map<bigint, unknown> };
	companies: Map<string, any>;
	toLngLat: (p: [number, number]) => [number, number];
};
const loaded = new Map<string, Loaded>();

function load(game: string): Loaded | null {
	if (loaded.has(game)) return loaded.get(game)!;
	const d = DATA[game];
	if (!d || !existsSync(join(d.dir, `${d.map}-graph.json`))) return null;

	const t0 = Date.now();
	console.log(`завантажую дані ${d.map}…`);
	const gm = readGraphAndMapData(fromDir(d.dir), d.map);
	const { tsMapData, graphData } = gm;
	const l: Loaded = {
		gm,
		ctx: {
			nodeLUT: tsMapData.nodes,
			graph: graphData.graph,
			enabledDlcGuards: d.map === "usa" ? toAtsDlcGuards(AtsSelectableDlcs) : toEts2DlcGuards(Ets2SelectableDlcs),
			map: d.map,
		},
		lookups: {
			ferriesByUid: new Map([...tsMapData.ferries.values()].map((f: any) => [f.uid, { ...f, type: ItemType.Ferry }])),
			companiesByPrefab: new Map([...tsMapData.companies.values()].map((c: any) => [c.prefabUid, c])),
		},
		companies: new Map([...tsMapData.companies.values()].map((c: any) => [`${c.cityToken}.${c.token}`, c])),
		toLngLat: d.map === "usa" ? fromAtsCoordsToWgs84 : fromEts2CoordsToWgs84,
	};
	loaded.set(game, l);
	console.log(`дані ${d.map} готові за ${((Date.now() - t0) / 1000).toFixed(1)} с: ${graphData.graph.size} вузлів графа`);
	return l;
}

type RouteRequest = { game: string; x: number; y: number; z: number; heading: number; dstCityId: string; dstCompanyId: string; withXY?: boolean };

function route(req: RouteRequest) {
	const l = load(req.game);
	if (!l) return { ok: false, error: `немає даних маршрутизації для ${req.game}` };
	const { gm, ctx, lookups } = l;

	const company = l.companies.get(`${req.dstCityId}.${req.dstCompanyId}`);
	if (!company) return { ok: false, error: `компанію ${req.dstCityId}.${req.dstCompanyId} не знайдено` };
	let toNodeUid: bigint = company.nodeUid;
	if (!gm.graphData.graph.has(toNodeUid)) {
		const node = gm.tsMapData.nodes.get(toNodeUid);
		toNodeUid = gm.graphNodeRTree.findClosest(node.x, node.y).node.uid;
	}

	const truck = {
		position: { X: req.x, Y: req.y, Z: req.z },
		orientation: { heading: req.heading, pitch: 0, roll: 0 },
	};
	const sink = { publish() {} };
	const { fromNodeUid, direction, allowRetryInOppositeDirection } = calculateFromNodeAndDirection(truck, gm, sink);

	const t0 = Date.now();
	let r = findRoute(fromNodeUid, toNodeUid, direction, "fastest", ctx);
	if (!r.success && (allowRetryInOppositeDirection || r.numIters === 1)) {
		r = findRoute(fromNodeUid, toNodeUid, direction === "forward" ? "backward" : "forward", "fastest", ctx);
	}
	if (!r.success) return { ok: false, error: "маршрут не знайдено" };

	// r.route[0] — сам стартовий вузол; однакові вузли поспіль бувають у вироджених
	// ділянках — пропускаємо, як guidance.ts у навігаторі. Лінію будуємо попарно,
	// щоб одна «погана» пара не зламала весь маршрут (тоді — прямий відрізок).
	const points: [number, number][] = [];
	const uids: bigint[] = r.route.map((n: any) => n.nodeUid);
	let failed = 0;
	for (let i = 1; i < uids.length; i++) {
		if (uids[i] === uids[i - 1]) continue;
		try {
			points.push(...getLineString([uids[i - 1], uids[i]], gm.tsMapData, lookups));
		} catch {
			failed++;
			for (const uid of [uids[i - 1], uids[i]]) {
				const n = gm.tsMapData.nodes.get(uid);
				if (n) points.push([n.x, n.y]);
			}
		}
	}
	if (failed) console.warn(`  ${failed} ділянок замінено прямими відрізками`);
	const coords: [number, number][] = [];
	const xy: [number, number][] = []; // ті самі точки в ігрових координатах (для імітатора fake_shm.py)
	for (const p of points) {
		const [lng, lat] = l.toLngLat(p);
		const q: [number, number] = [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
		const last = coords.at(-1);
		if (!last || last[0] !== q[0] || last[1] !== q[1]) {
			coords.push(q);
			xy.push([Number(p[0].toFixed(2)), Number(p[1].toFixed(2))]);
		}
	}
	// підказки: маневри з навігатора (guidance.ts). Прибуття додаємо самі — guidance його не дає.
	const steps: { dir: number; lonLat: [number, number]; exit?: number; text?: string }[] = [];
	try {
		for (const s of calculateSteps(r.route, gm.tsMapData, gm.signRTree, gm.roundaboutData)) {
			const m = s.maneuver;
			steps.push({
				dir: m.direction,
				lonLat: [Number(m.lonLat[0].toFixed(6)), Number(m.lonLat[1].toFixed(6))],
				...(m.roundaboutExitNumber ? { exit: m.roundaboutExitNumber } : {}),
				...(m.banner?.text ? { text: m.banner.text } : {}),
			});
		}
	} catch (e) {
		console.warn("  підказки не пораховано:", (e as Error).message);
	}
	const end = coords.at(-1);
	if (end) steps.push({ dir: -3 /* ARRIVE */, lonLat: end, text: company.token });

	console.log(`маршрут → ${req.dstCityId}.${req.dstCompanyId}: ${(r.distance / 1000).toFixed(0)} км, ${coords.length} точок, ${steps.length} маневрів, ${Date.now() - t0} мс`);
	return { ok: true, distance: r.distance, duration: r.duration, coords, steps, ...(req.withXY ? { xy } : {}) };
}

// ---------- HTTP ----------

createServer((req, res) => {
	const send = (code: number, body: unknown) => {
		res.writeHead(code, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (req.method === "GET" && req.url === "/health") {
		send(200, { ready: true, maps: [...loaded.keys()] });
		return;
	}
	if (req.method === "POST" && req.url === "/route") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			try {
				send(200, route(JSON.parse(body)));
			} catch (e) {
				console.error(e);
				send(200, { ok: false, error: String((e as Error).message ?? e) });
			}
		});
		return;
	}
	send(404, { ok: false, error: "not found" });
}).listen(PORT, HOST, () => {
	console.log(`ETS2 Phone Nav router слухає ${HOST}:${PORT}; клон truckermudgeon/maps: ${TSM}`);
	load("eut2"); // прогріваємо одразу, щоб перший маршрут не чекав
});
