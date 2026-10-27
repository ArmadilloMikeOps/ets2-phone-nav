// Герби міст: шукаємо місто у Wikidata (за англійською назвою з даних гри в межах його країни,
// властивість P94 — зображення герба) і віддаємо посилання на мініатюру з Wikimedia Commons.
// Результати (і промахи) кешуються у mapdata/out/coats-<гра>.json — Wikidata питаємо раз на місто.
// Потрібен інтернет; без нього герба просто не буде.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = "ets2-phone-nav (https://github.com/ArmadilloMikeOps/ets2-phone-nav)";
const PREFIX: Record<string, string> = { eut2: "europe", ats: "usa" };

type Entry = { file: string | null; at: number };
type City = { name: string; country: string; state?: string };
type GameCache = { path: string; entries: Record<string, Entry>; cities: Map<string, City> | null };

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
		// ATS: «країни» гри — штати; їхні коди (CA, NV…) — суфікси ISO 3166-2, шукаємо місто в межах штату
		const stateCode = new Map<string, string>();
		const countriesFile = join(dir, `${prefix}-countries.json`);
		if (game === "ats" && existsSync(countriesFile)) {
			for (const k of JSON.parse(readFileSync(countriesFile, "utf8"))) stateCode.set(k.token, k.code);
		}
		c.cities = new Map();
		for (const city of JSON.parse(readFileSync(citiesFile, "utf8"))) {
			c.cities.set(city.token, game === "ats"
				? { name: city.name, country: "Q30", state: stateCode.get(city.countryToken) }
				: { name: city.name, country: COUNTRY_QID[city.countryToken] ?? "" });
		}
	}
	return c;
}

const thumb = (file: string) =>
	`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=128`;

// Європа: герб (P94). США: у міст рідко бувають герби — беремо герб, інакше печатку (P158), інакше прапор (P41),
// і шукаємо в межах штату (P131* → P300 «US-CA»), бо однакових назв міст у США багато.
async function queryWikidata(city: City): Promise<string | null> {
	const search = `SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch";
			mwapi:search "${city.name.replace(/["\\]/g, "")}"; mwapi:language "en". ?item wikibase:apiOutputItem mwapi:item.
			?ord wikibase:apiOrdinal true. }`;
	const q = city.state
		? `SELECT ?coa ?seal ?flag WHERE {
		${search}
		?item wdt:P17 wd:${city.country}; wdt:P131* ?st. ?st wdt:P300 "US-${city.state}".
		OPTIONAL { ?item wdt:P94 ?coa } OPTIONAL { ?item wdt:P158 ?seal } OPTIONAL { ?item wdt:P41 ?flag }
		FILTER(BOUND(?coa) || BOUND(?seal) || BOUND(?flag))
	} ORDER BY ?ord LIMIT 1`
		: `SELECT ?coa WHERE {
		${search}
		?item wdt:P17 wd:${city.country}; wdt:P94 ?coa.
	} ORDER BY ?ord LIMIT 1`;
	const res = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
		headers: { "User-Agent": UA, Accept: "application/sparql-results+json" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Wikidata ${res.status}`);
	const b = (await res.json()).results.bindings[0];
	const img = b && (b.coa ?? b.seal ?? b.flag);
	return img ? decodeURIComponent(String(img.value).split("/").pop()!) : null;
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
				const file = await queryWikidata(city);
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
