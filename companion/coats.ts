// Герби міст: шукаємо місто у Wikidata (за англійською назвою з даних гри в межах його країни,
// властивість P94 — зображення герба) і віддаємо посилання на мініатюру з Wikimedia Commons.
// Результати (і промахи) кешуються у mapdata/out/coats-<гра>.json — Wikidata питаємо раз на місто.
// Потрібен інтернет; без нього герба просто не буде.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = "ets2-phone-nav (https://github.com/godamisha-ops/ets2-phone-nav)";
const PREFIX: Record<string, string> = { eut2: "europe", ats: "usa" };

type Entry = { file: string | null; at: number };
type GameCache = { path: string; entries: Record<string, Entry>; cities: Map<string, { name: string; country: string }> | null };

// токен країни гри → елемент Wikidata. Поле `code` у даних гри — міжнародний автомобільний код
// (F, H, D…), а не ISO, тож зіставляємо самі; таблицю звірено з мітками Wikidata.
const COUNTRY_QID: Record<string, string> = {
	albania: "Q222", austria: "Q40", belgium: "Q31", bosnia: "Q225", bulgaria: "Q219", croatia: "Q224",
	czech: "Q213", denmark: "Q35", estonia: "Q191", finland: "Q33", france: "Q142", germany: "Q183",
	greece: "Q41", hungary: "Q28", iceland: "Q189", italy: "Q38", kosovo: "Q1246", latvia: "Q211",
	lithuania: "Q37", luxembourg: "Q32", macedonia: "Q221", montenegro: "Q236", netherlands: "Q55",
	norway: "Q20", poland: "Q36", portugal: "Q45", romania: "Q218", russia: "Q159", serbia: "Q403",
	slovakia: "Q214", slovenia: "Q215", spain: "Q29", sweden: "Q34", switzerland: "Q39", turkey: "Q43",
	uk: "Q145",
};

const caches = new Map<string, GameCache>();
const inflight = new Map<string, Promise<string | null>>();

function gameCache(mapdata: string, game: string): GameCache | null {
	const prefix = PREFIX[game];
	if (!prefix) return null;
	let c = caches.get(game);
	if (!c) {
		const path = join(mapdata, `coats-${game}.json`);
		let entries: Record<string, Entry> = {};
		try { if (existsSync(path)) entries = JSON.parse(readFileSync(path, "utf8")); } catch { /* зіпсований кеш — почнемо заново */ }
		c = { path, entries, cities: null };
		caches.set(game, c);
	}
	if (!c.cities) {
		const dir = join(mapdata, game === "ats" ? "ats" : "ets2");
		const citiesFile = join(dir, `${prefix}-cities.json`);
		if (!existsSync(citiesFile)) return c;
		c.cities = new Map();
		for (const city of JSON.parse(readFileSync(citiesFile, "utf8"))) {
			// ATS: «країна» — штат; шукаємо в межах США
			c.cities.set(city.token, { name: city.name, country: game === "ats" ? "Q30" : COUNTRY_QID[city.countryToken] ?? "" });
		}
	}
	return c;
}

const thumb = (file: string) =>
	`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=128`;

async function queryWikidata(name: string, country: string): Promise<string | null> {
	const q = `SELECT ?coa WHERE {
		SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch";
			mwapi:search "${name.replace(/["\\]/g, "")}"; mwapi:language "en". ?item wikibase:apiOutputItem mwapi:item.
			?ord wikibase:apiOrdinal true. }
		?item wdt:P17 wd:${country}; wdt:P94 ?coa.
	} ORDER BY ?ord LIMIT 1`;
	const res = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
		headers: { "User-Agent": UA, Accept: "application/sparql-results+json" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Wikidata ${res.status}`);
	const b = (await res.json()).results.bindings[0];
	return b ? decodeURIComponent(String(b.coa.value).split("/").pop()!) : null;
}

/** URL мініатюри герба або null (немає в Wikidata / немає інтернету / невідоме місто) */
export async function coatOfArms(mapdata: string, game: string, cityToken: string): Promise<string | null> {
	const c = gameCache(mapdata, game);
	if (!c) return null;
	const hit = c.entries[cityToken];
	if (hit) return hit.file ? thumb(hit.file) : null;
	const city = c.cities?.get(cityToken);
	if (!city || !city.country) return null;

	const key = `${game}:${cityToken}`;
	if (!inflight.has(key)) {
		inflight.set(key, (async () => {
			try {
				const file = await queryWikidata(city.name, city.country);
				c.entries[cityToken] = { file, at: Date.now() }; // промах теж кешуємо
				writeFileSync(c.path, JSON.stringify(c.entries, null, 1));
				return file;
			} catch {
				return null; // мережа — не кешуємо, спробуємо наступного разу
			} finally {
				inflight.delete(key);
			}
		})());
	}
	const file = await inflight.get(key)!;
	return file ? thumb(file) : null;
}
