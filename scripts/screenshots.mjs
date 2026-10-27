// Скриншоти для документації: Chromium-браузер без вікна через DevTools-протокол (CDP),
// екран iPhone 17 Pro в альбомній орієнтації (874×402 pt, ×3), чекаємо, поки карта справді відмалюється.
//
//   node scripts/screenshots.mjs [--url http://localhost:8421] [--out docs/screenshots] [--browser "/шлях/до/Chrome"]
//   кадри: node scripts/screenshots.mjs nav:"#nav" cargo:"#cargo" overview:"?view=overview#nav"
//
// Звичайний --screenshot у headless-режимі тут не годиться: потік /events ніколи не закривається,
// сторінка «не довантажується», і знімок виходить без карти.
// Сторінку відкриваємо з ?screenshot — без підказок першого запуску.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg("--url", "http://localhost:8421");
const OUT = arg("--out", "docs/screenshots");
const BROWSER = arg("--browser", [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((p) => existsSync(p)));
const PORT = 9333;
const SHOTS = process.argv.slice(2).filter((a) => /^[\w-]+:/.test(a) && !a.startsWith("--"))
	.map((a) => { const i = a.indexOf(":"); return [a.slice(0, i), a.slice(i + 1)]; });
if (!SHOTS.length) SHOTS.push(["nav", "#nav"], ["cargo", "#cargo"], ["dash", "#dash"]);

const profile = mkdtempSync(join(tmpdir(), "ets2nav-shots-"));
const browser = spawn(BROWSER, [
	"--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--hide-scrollbars", "--window-size=874,402", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForBrowser() {
	for (let i = 0; i < 50; i++) {
		try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); }
	}
	throw new Error("браузер не відповідає");
}

function cdp(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let id = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	};
	const ready = new Promise((r) => (ws.onopen = r));
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const msgId = ++id;
		pending.set(msgId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
		ws.send(JSON.stringify({ id: msgId, method, params }));
	});
	return { ready, send, close: () => ws.close() };
}

try {
	await waitForBrowser();
	mkdirSync(OUT, { recursive: true });
	for (const [name, suffix] of SHOTS) {
		const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
		const c = cdp(target.webSocketDebuggerUrl);
		await c.ready;
		await c.send("Emulation.setDeviceMetricsOverride", { width: 874, height: 402, deviceScaleFactor: 3, mobile: true });
		const url = BASE + (suffix.startsWith("?") ? suffix.replace(/^\?/, "?screenshot&") : "/?screenshot" + suffix);
		await c.send("Page.navigate", { url });
		// чекаємо, поки на карті з'являться об'єкти й вона закінчить вантажити тайли (або вкладка без карти)
		for (let i = 0; i < 60; i++) {
			const r = await c.send("Runtime.evaluate", {
				expression: `(() => { const m = window.__navMap; if (!m) return false;
					return m.loaded() && m.queryRenderedFeatures().length > 50; })()`,
				returnByValue: true,
			});
			if (r.result.value) break;
			await sleep(500);
		}
		await sleep(2500); // плавна камера доїжджає, герби довантажуються
		const shot = await c.send("Page.captureScreenshot", { format: "png" });
		const file = join(OUT, `${name}.png`);
		writeFileSync(file, Buffer.from(shot.data, "base64"));
		console.log(`${file}  ←  ${url}`);
		c.close();
		await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
	}
} finally {
	browser.kill();
	await sleep(300);
	rmSync(profile, { recursive: true, force: true });
}
