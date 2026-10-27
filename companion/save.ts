// Читання гаманця й кредиту з останнього збереження гри.
//
// Telemetry SDK грошей не передає, тож беремо їх зі збереження (game.sii):
//   - знаходимо найсвіжіший game.sii у теках профілів (Steam Cloud і локальні);
//   - розшифровуємо формат ScsC: AES-256-CBC з публічно відомим ключем SCS
//     (той самий, що в SII_Decrypt) + zlib;
//   - розбираємо двійковий формат BSII (або текстовий SiiNunit, якщо в config.cfg g_save_format "2")
//     і дістаємо одиниці `bank` і `bank_loan`.
// Збереження пишуться лише при автозбереженні/збереженні, тому companion між ними
// додає до балансу ігрові події (доставки, штрафи, платні дороги) — див. server.ts.

import { createDecipheriv } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export type Wallet = {
	money: number;          // money_account — може бути від'ємним (овердрафт)
	loan: number;           // сума залишків за всіма позиками
	loan_original: number;  // скільки позичено спочатку
	loan_limit: number;     // ліміт кредиту банку
	loans: number;          // кількість позик
	saved_at: number;       // mtime збереження, мс
	file: string;
};

const SCS_KEY = Buffer.from("2a5fcb1791d22fb60245b3d8369ed0b2c27371563fbf1f3c9edf6b11825a5d0a", "hex");
const STEAM_APP = { eut2: "227300", ats: "270880" } as const;
const GAME_DIR = { eut2: "Euro Truck Simulator 2", ats: "American Truck Simulator" } as const;

// ---------- де шукати збереження ----------

function steamUserdataDirs(): string[] {
	const dirs = process.platform === "win32"
		? ["C:\\Program Files (x86)\\Steam\\userdata", "C:\\Program Files\\Steam\\userdata"]
		: process.platform === "darwin"
			? [join(homedir(), "Library/Application Support/Steam/userdata")]
			: [join(homedir(), ".steam/steam/userdata"), join(homedir(), ".local/share/Steam/userdata")];
	if (process.env.ETS2NAV_STEAM_USERDATA) dirs.unshift(process.env.ETS2NAV_STEAM_USERDATA);
	return dirs.filter((d) => existsSync(d));
}

function localProfileDirs(game: keyof typeof GAME_DIR): string[] {
	const base = process.platform === "win32"
		? join(homedir(), "Documents", GAME_DIR[game])
		: process.platform === "darwin"
			? join(homedir(), "Library/Application Support", GAME_DIR[game])
			: join(homedir(), ".local/share", GAME_DIR[game]);
	return ["profiles", "steam_profiles"].map((p) => join(base, p)).filter((d) => existsSync(d));
}

function safeList(dir: string): string[] {
	try { return readdirSync(dir); } catch { return []; }
}

/** усі game.sii гри: <profiles>/<профіль>/save/<слот>/game.sii */
function findSaves(game: keyof typeof GAME_DIR): string[] {
	const profileRoots = [
		...steamUserdataDirs().flatMap((u) => safeList(u).map((acc) => join(u, acc, STEAM_APP[game], "remote", "profiles"))),
		...localProfileDirs(game),
	].filter((d) => existsSync(d));
	const out: string[] = [];
	for (const root of profileRoots) {
		for (const prof of safeList(root)) {
			const saveDir = join(root, prof, "save");
			for (const slot of safeList(saveDir)) {
				const f = join(saveDir, slot, "game.sii");
				if (existsSync(f)) out.push(f);
			}
		}
	}
	return out;
}

// ---------- розшифровка й розбір ----------

function decode(raw: Buffer): Buffer {
	const sig = raw.toString("latin1", 0, 4);
	if (sig === "ScsC") {
		// ScsC: сигнатура(4) HMAC(32) IV(16) розмір(4) дані
		const d = createDecipheriv("aes-256-cbc", SCS_KEY, raw.subarray(36, 52));
		return inflateSync(Buffer.concat([d.update(raw.subarray(56)), d.final()]));
	}
	return raw; // уже BSII або текст
}

type Units = Map<string, Record<string, unknown>[]>;

// BSII: блоки «опис структури» (тип 0) і «дані» (тип = id структури).
// Розміри типів значень — за форматом SCS (той самий набір, що розбирає SII_Decrypt);
// масиви мають тип на 1 більший за елемент.
const FIXED: Record<number, number> = {
	0x03: 8, 0x05: 4, 0x07: 8, 0x09: 12, 0x11: 12, 0x17: 16, 0x19: 32,
	0x25: 4, 0x27: 4, 0x29: 2, 0x2b: 2, 0x2f: 4, 0x31: 8, 0x33: 8, 0x35: 1, 0x37: 4,
};
const ARRAYS = new Set([0x02, 0x04, 0x06, 0x08, 0x0a, 0x12, 0x18, 0x1a, 0x26, 0x28, 0x2a, 0x2c, 0x32, 0x34, 0x36, 0x3a, 0x3c, 0x3e]);
const WANTED = new Set(["bank", "bank_loan"]);

function parseBsii(b: Buffer): Units {
	let o = 8; // "BSII" + версія
	const u8 = () => b[o++];
	const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
	const str = () => { const n = u32(); const s = b.toString("utf8", o, o + n); o += n; return s; };
	const id = () => { const n = u8(); o += n === 0xff ? 8 : 8 * n; };

	function value(t: number, keep: boolean): unknown {
		switch (t) {
			case 0x01: return str();
			case 0x05: { const v = b.readFloatLE(o); o += 4; return v; }
			case 0x25: { const v = b.readInt32LE(o); o += 4; return v; }
			case 0x27: case 0x2f: { const v = b.readUInt32LE(o); o += 4; return v; }
			case 0x31: { const v = Number(b.readBigInt64LE(o)); o += 8; return v; }
			case 0x33: { const v = Number(b.readBigUInt64LE(o)); o += 8; return v; }
			case 0x35: return u8() !== 0;
			case 0x39: case 0x3b: case 0x3d: id(); return null;
		}
		if (FIXED[t] !== undefined) { o += FIXED[t]; return null; }
		if (ARRAYS.has(t)) {
			const n = u32();
			const arr: unknown[] = [];
			for (let i = 0; i < n; i++) { const v = value(t - 1, keep); if (keep) arr.push(v); }
			return keep ? arr : n;
		}
		throw new Error(`BSII: невідомий тип 0x${t.toString(16)} на ${o}`);
	}

	const structs = new Map<number, { name: string; fields: [number, string][] }>();
	const units: Units = new Map();
	while (o < b.length) {
		const type = u32();
		if (type === 0) {
			if (!u8()) break; // маркер кінця
			const sid = u32();
			const name = str();
			const fields: [number, string][] = [];
			for (;;) {
				const vt = u32();
				if (vt === 0) break;
				fields.push([vt, str()]);
				if (vt === 0x37) { const n = u32(); for (let i = 0; i < n; i++) { u32(); str(); } }
			}
			structs.set(sid, { name, fields });
			continue;
		}
		const s = structs.get(type);
		if (!s) throw new Error(`BSII: немає опису структури ${type} на ${o}`);
		id();
		const keep = WANTED.has(s.name);
		const rec: Record<string, unknown> = {};
		for (const [vt, f] of s.fields) { const v = value(vt, keep); if (keep) rec[f] = v; }
		if (keep) {
			if (!units.has(s.name)) units.set(s.name, []);
			units.get(s.name)!.push(rec);
		}
	}
	return units;
}

// текстовий SiiNunit (g_save_format "2"): нам вистачає простих «ключ: значення» у блоках bank/bank_loan
function parseText(t: string): Units {
	const units: Units = new Map();
	const re = /^\s*(bank|bank_loan)\s*:\s*\S+\s*\{([\s\S]*?)^\s*\}/gm;
	for (const m of t.matchAll(re)) {
		const rec: Record<string, unknown> = {};
		for (const line of m[2].split("\n")) {
			const kv = /^\s*([a-z_]+)\s*:\s*(\S+)/.exec(line);
			if (kv) rec[kv[1]] = /^-?\d+$/.test(kv[2]) ? Number(kv[2]) : kv[2];
		}
		if (!units.has(m[1])) units.set(m[1], []);
		units.get(m[1])!.push(rec);
	}
	return units;
}

function readWallet(file: string): Wallet {
	const data = decode(readFileSync(file));
	const head = data.toString("latin1", 0, 8);
	const units = head.startsWith("BSII") ? parseBsii(data)
		: head.startsWith("SiiNunit") ? parseText(data.toString("utf8"))
		: (() => { throw new Error(`невідомий формат збереження: ${JSON.stringify(head)}`); })();
	const bank = units.get("bank")?.[0];
	if (!bank) throw new Error("у збереженні немає bank");
	const loans = units.get("bank_loan") ?? [];
	return {
		money: Number(bank.money_account) || 0,
		loan: loans.reduce((s, l) => s + (Number(l.amount) || 0), 0),
		loan_original: loans.reduce((s, l) => s + (Number(l.original_amount) || 0), 0),
		loan_limit: Number(bank.loan_limit) || 0,
		loans: loans.length,
		saved_at: statSync(file).mtimeMs,
		file,
	};
}

// ---------- кеш: перечитуємо лише коли з'явилось новіше збереження ----------

const cache = new Map<string, { file: string; mtime: number; wallet: Wallet | null; error: string | null }>();
let lastScan = new Map<string, number>();

export function latestWallet(game: string): { wallet: Wallet | null; error: string | null } {
	if (game !== "eut2" && game !== "ats") return { wallet: null, error: null };
	// пошук файлів — не частіше ніж раз на 10 с
	const now = Date.now();
	const prev = cache.get(game);
	if (prev && now - (lastScan.get(game) ?? 0) < 10_000) return prev;
	lastScan.set(game, now);

	const saves = findSaves(game);
	if (!saves.length) {
		const r = { file: "", mtime: 0, wallet: null, error: "збережень гри не знайдено" };
		cache.set(game, r);
		return r;
	}
	const newest = saves.map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0];
	if (prev && prev.file === newest.f && prev.mtime === newest.m) return prev;
	try {
		const r = { file: newest.f, mtime: newest.m, wallet: readWallet(newest.f), error: null };
		cache.set(game, r);
		return r;
	} catch (e) {
		const r = { file: newest.f, mtime: newest.m, wallet: prev?.wallet ?? null, error: String((e as Error).message ?? e) };
		cache.set(game, r);
		return r;
	}
}
