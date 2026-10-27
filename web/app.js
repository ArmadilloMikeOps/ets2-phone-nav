// ETS2 Phone Nav — веб-клієнт для iPhone. Отримує стан через SSE (/events) і малює три вкладки.
// Потребує сучасного Safari (ES-модулі, WebGL2 для карти — iOS 15+).

import { updateMap, setMode, getMode, zoomBy } from "./map.js";
import { initDraggable } from "./drag.js";

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  // ---------- одиниці за грою ----------

  var UNITS = {
    eut2: { speed: "км/год", speedK: 3.6, dist: "км", distK: 1, fuel: "л", fuelK: 1, money: "€", mass: "т", massK: 0.001, cons: "л/100 км", consK: 100, imperial: false },
    ats:  { speed: "mph", speedK: 2.23694, dist: "mi", distK: 0.621371, fuel: "gal", fuelK: 0.264172, money: "$", mass: "lb", massK: 2.20462, cons: "mpg", consK: null, imperial: true }
  };
  var U = UNITS.eut2;

  function fmtInt(n) {
    // toLocaleString у старому Safari ігнорує локаль — розділяємо тисячі самі
    var s = String(Math.round(Math.abs(n)));
    var out = "";
    while (s.length > 3) { out = " " + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? "−" : "") + s + out;
  }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function speedOf(ms) { return Math.max(0, Math.round(Math.abs(ms) * U.speedK)); }

  function distOf(km) {
    var v = km * U.distK;
    return v >= 10 ? fmtInt(v) : v.toFixed(1);
  }

  // короткі відстані для підказок: метри/кілометри або фути/милі
  function shortDist(m) {
    if (U.imperial) {
      var ft = m * 3.28084;
      if (ft < 1000) return Math.max(50, Math.round(ft / 50) * 50) + " ft";
      var mi = m / 1609.34;
      return (mi < 10 ? mi.toFixed(1) : String(Math.round(mi))) + " mi";
    }
    if (m < 1000) return Math.max(10, Math.round(m / (m < 300 ? 10 : 50)) * (m < 300 ? 10 : 50)) + " м";
    var km = m / 1000;
    return (km < 10 ? km.toFixed(1).replace(".", ",") : String(Math.round(km))) + " км";
  }

  function duration(min) {
    if (!isFinite(min)) return "—";
    var sign = min < 0 ? "−" : "";
    min = Math.abs(Math.round(min));
    var d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d > 0) return sign + d + " д " + h + " год";
    if (h > 0) return sign + h + " год " + m + " хв";
    return sign + m + " хв";
  }

  var DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  function gameClock(min) {
    var d = Math.floor(min / 1440) % 7, h = Math.floor((min % 1440) / 60), m = min % 60;
    return DAYS[d] + " " + pad2(h) + ":" + pad2(m);
  }

  function gearLabel(g) {
    if (g > 0) return String(g);
    if (g < 0) return "R" + (-g);
    return "N";
  }

  function set(id, text) { var el = $(id); if (el.textContent !== text) el.textContent = text; }
  function show(id, on) { $(id).hidden = !on; }
  function toggleClass(el, cls, on) {
    if (on) el.classList.add(cls); else el.classList.remove(cls); // старий Safari не знає toggle(cls, force)
  }

  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватний режим */ } }

  // ---------- вкладки ----------

  var pages = $("pages");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tabs button"));
  var order = tabs.map(function (b) { return b.getAttribute("data-tab"); });

  function markTab(i) {
    tabs.forEach(function (b, j) { toggleClass(b, "active", i === j); });
    storageSet("tab", order[i]);
  }
  function goTo(tab) {
    var i = Math.max(0, order.indexOf(tab));
    pages.scrollLeft = i * pages.clientWidth;
    markTab(i);
  }
  tabs.forEach(function (b) {
    b.addEventListener("click", function () { goTo(b.getAttribute("data-tab")); });
  });
  window.addEventListener("resize", function () { goTo(storageGet("tab") || "nav"); });
  goTo(storageGet("tab") || "nav");

  // ---------- статус і сповіщення ----------

  function setStatus(text, error) {
    var el = $("status");
    el.hidden = !text;
    el.textContent = text || "";
    toggleClass(el, "error", !!error);
  }

  var alertTimer = 0;
  var lastAlertSeq = null;
  function showAlert(a) {
    var el = $("alert");
    el.className = "alert alert-" + a.kind;
    set("alert-title", a.title);
    set("alert-text", a.text);
    el.hidden = false;
    if (a.kind === "bad") {
      // спалах рамки екрана, щоб помітити краєм ока
      document.body.classList.remove("flash");
      void document.body.offsetWidth;
      document.body.classList.add("flash");
    }
    clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { el.hidden = true; }, a.kind === "bad" ? 9000 : 6000);
  }
  $("alert").addEventListener("click", function () { $("alert").hidden = true; });

  // ---------- підказка маневру ----------
  // dir — BranchType з навігатора truckermudgeon/maps:
  // 0 прямо; 1–4 ліворуч (плавно, звичайно, різко, розворот); 11–14 праворуч;
  // 21–28 коло (BR, R, TR, T, TL, L, BL, B); 29 з'їзд з кола; −1 злиття; −2 старт; −3 прибуття; −4 пором

  var TURN_ANGLE = { 0: 0, 1: -45, 2: -90, 3: -135, 11: 45, 12: 90, 13: 135, 29: 45, "-1": 0, "-2": 0 };
  var ROUND_ANGLE = { 21: 135, 22: 90, 23: 45, 24: 0, 25: -45, 26: -90, 27: -135, 28: 180 };

  function maneuverText(m) {
    switch (m.dir) {
      case 0: return "Прямо";
      case 1: return "Тримайтеся ліворуч";
      case 2: return "Поверніть ліворуч";
      case 3: return "Різко ліворуч";
      case 4: return "Розворот";
      case 11: return "Тримайтеся праворуч";
      case 12: return "Поверніть праворуч";
      case 13: return "Різко праворуч";
      case 14: return "Розворот";
      case 29: return "З'їзд з кола";
      case -1: return "Злиття з потоком";
      case -3: return "Прибуття";
      case -4: return "Пором";
    }
    if (m.dir >= 21 && m.dir <= 28) return "На колі: " + (m.exit ? m.exit + "-й з'їзд" : "з'їзд");
    return "Маневр";
  }

  function rad(a) { return a * Math.PI / 180; }
  function arrowHead(x, y, angle) {
    // трикутник із вершиною в (x, y), спрямований під кутом angle (0 = вгору)
    var s = 7, a = rad(angle);
    function pt(dx, dy) {
      return (x + dx * Math.cos(a) - dy * Math.sin(a)).toFixed(1) + "," + (y + dx * Math.sin(a) + dy * Math.cos(a)).toFixed(1);
    }
    return '<path d="M' + pt(0, -2) + " L" + pt(-s, s + 2) + " L" + pt(s, s + 2) + ' Z" fill="currentColor"/>';
  }

  function maneuverIcon(dir) {
    var stroke = 'fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"';
    var body;
    if (dir === -3) {
      body = '<path d="M24 44 C24 44 10 28 10 19 a14 14 0 0 1 28 0 C38 28 24 44 24 44 Z" fill="currentColor"/>' +
             '<circle cx="24" cy="19" r="5" fill="#0b0d10"/>';
    } else if (dir === -4) {
      body = '<path d="M8 30 L40 30 L35 39 L13 39 Z" fill="currentColor"/><path d="M16 30 V20 H32 V30" ' + stroke + "/>" +
             '<path d="M6 44 q4 -3 8 0 t8 0 t8 0 t8 0 t8 0" fill="none" stroke="currentColor" stroke-width="2.5"/>';
    } else if (dir === 4 || dir === 14) {
      var right = dir === 14;
      body = right
        ? '<path d="M18 44 V20 a7 7 0 0 1 14 0 V28" ' + stroke + "/>" + arrowHead(32, 38, 180)
        : '<path d="M30 44 V20 a7 7 0 0 0 -14 0 V28" ' + stroke + "/>" + arrowHead(16, 38, 180);
    } else if (dir >= 21 && dir <= 28) {
      var a = rad(ROUND_ANGLE[dir]);
      var ex = 24 + 9 * Math.sin(a), ey = 22 - 9 * Math.cos(a);
      var tx = 24 + 19 * Math.sin(a), ty = 22 - 19 * Math.cos(a);
      body = '<circle cx="24" cy="22" r="9" fill="none" stroke="currentColor" stroke-width="3.5" opacity="0.55"/>' +
             '<path d="M24 46 V31" ' + stroke + "/>" +
             '<path d="M' + ex.toFixed(1) + " " + ey.toFixed(1) + " L" + tx.toFixed(1) + " " + ty.toFixed(1) + '" ' + stroke + "/>" +
             arrowHead(tx, ty, ROUND_ANGLE[dir]);
    } else {
      var ang = TURN_ANGLE[dir] !== undefined ? TURN_ANGLE[dir] : 0;
      var len = 15, bx = 24, by = 26;
      var x2 = bx + len * Math.sin(rad(ang)), y2 = by - len * Math.cos(rad(ang));
      body = '<path d="M24 46 V' + by + " L" + x2.toFixed(1) + " " + y2.toFixed(1) + '" ' + stroke + "/>" + arrowHead(x2, y2, ang);
      if (dir === -1) body += '<path d="M10 46 Q12 32 22 28" fill="none" stroke="currentColor" stroke-width="3" opacity="0.55"/>';
    }
    return '<svg viewBox="0 0 48 48" width="100%" height="100%">' + body + "</svg>";
  }

  var lastIconKey = "";
  function renderManeuver(m) {
    show("maneuver", !!m);
    if (!m) return;
    var key = m.dir + ":" + (m.then_dir === null ? "" : m.then_dir);
    if (key !== lastIconKey) {
      $("man-icon").innerHTML = maneuverIcon(m.dir);
      $("man-then").innerHTML = m.then_dir === null ? "" : "потім " + '<span class="man-then-icon">' + maneuverIcon(m.then_dir) + "</span>";
      lastIconKey = key;
    }
    set("man-dist", shortDist(m.dist));
    set("man-text", maneuverText(m));
    toggleClass($("maneuver"), "soon", m.dist < 400);
  }

  // ---------- герби міст (сервер шукає їх у Wikidata й кешує) ----------

  var coatUrls = {};      // "гра:місто" → url | null
  var coatShown = {};     // id <img> → "гра:місто", що вже показано
  function setCoat(imgId, game, city) {
    var img = $(imgId);
    var key = game + ":" + city;
    if (!city) { img.hidden = true; coatShown[imgId] = ""; return; }
    if (coatShown[imgId] === key) return;
    coatShown[imgId] = key;
    img.hidden = true;
    function apply(url) {
      if (coatShown[imgId] !== key) return; // місто вже змінилось
      if (!url) return;
      img.onload = function () { img.hidden = false; };
      img.onerror = function () { img.hidden = true; };
      img.src = url;
    }
    if (key in coatUrls) { apply(coatUrls[key]); return; }
    fetch("api/coa?game=" + encodeURIComponent(game) + "&city=" + encodeURIComponent(city))
      .then(function (r) { return r.json(); })
      .then(function (j) { coatUrls[key] = j.url; apply(j.url); }, function () { /* без герба */ });
  }

  // ---------- фінанси (зі збереження гри + події після нього) ----------

  function savedAt(ms) {
    var t = new Date(ms);
    return pad2(t.getHours()) + ":" + pad2(t.getMinutes());
  }
  // гра пише автозбереження приблизно раз на 5 хв їзди — показуємо, наскільки свіжі цифри
  function ago(ms) {
    var min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return "щойно";
    if (min < 60) return min + " хв тому";
    var h = Math.floor(min / 60);
    return h < 24 ? h + " год тому" : Math.floor(h / 24) + " д тому";
  }
  function renderFinance(w) {
    show("finance", !!w && w.money !== undefined);
    if (!w || w.money === undefined) return;
    set("fin-money", (w.adjusted ? "≈ " : "") + fmtInt(w.money) + " " + U.money);
    $("fin-money").className = "big " + (w.money < 0 ? "bad" : "");
    set("fin-money-sub", "збереження " + ago(w.saved_at) + " (" + savedAt(w.saved_at) + ")" + (w.adjusted ? " + події після нього" : ""));
    if (w.loans > 0) {
      set("fin-loan", fmtInt(w.loan) + " " + U.money);
      set("fin-loan-sub", "з " + fmtInt(w.loan_original) + " " + U.money + " · ліміт " + fmtInt(w.loan_limit) + " " + U.money);
    } else {
      set("fin-loan", "немає");
      set("fin-loan-sub", w.loan_limit > 0 ? "доступно до " + fmtInt(w.loan_limit) + " " + U.money : "");
    }
  }

  // ---------- рендер ----------

  function render(s) {
    var d = s.data;
    if (s.status === "old-plugin") {
      setStatus("У грі стара версія плагіна — запусти install-plugin.sh і перезапусти гру", true);
      return;
    }
    if (s.status === "no-game" || !d) {
      setStatus("Гру не запущено або плагін не працює");
      return;
    }
    setStatus(s.status === "stale" ? "Немає даних від гри (меню?)" : s.status === "paused" ? "Пауза" : "");

    U = UNITS[d.game_id] || UNITS.eut2;

    var speed = speedOf(d.speed);
    var limit = d.nav_speed_limit > 0.5 ? speedOf(d.nav_speed_limit) : 0;
    var over = limit > 0 && speed > limit + 2;
    var cruise = d.cruise > 0.5 ? speedOf(d.cruise) : 0;

    // --- навігація ---
    var mapShown = updateMap($("map"), d, s.tiles || []);
    syncMapButtons();
    show("map-empty", !mapShown);

    var routeText = {
      pending: "Прокладаю маршрут…",
      error: "Маршрут не прокладено: " + (d.route_error || ""),
      "no-router": "Маршрутизатор не запущено"
    }[d.route_status];
    show("nav-route", !!routeText);
    set("nav-route", routeText || "");
    renderManeuver(d.maneuver);

    var hasNav = d.job_active && d.nav_distance > 0;
    set("nav-dist", hasNav ? distOf(d.nav_distance / 1000) : "—");
    set("nav-dist-unit", hasNav ? U.dist : "");
    set("nav-eta", hasNav ? duration(d.nav_time / 60) : "—");
    if (d.job_active && d.job_delivery_time > 0) {
      var left = d.job_delivery_time - d.game_time;
      var margin = left - (hasNav ? d.nav_time / 60 : 0);
      set("nav-margin", duration(margin));
      $("nav-margin").className = "mid " + (margin < 0 ? "bad" : margin < 60 ? "" : "good");
    } else {
      set("nav-margin", "—");
      $("nav-margin").className = "mid";
    }
    set("nav-city", d.job_active ? d.job_dst_city : "Немає завдання");
    set("nav-company", d.job_active ? d.job_dst_company : "");
    show("nav-limit", limit > 0);
    set("nav-limit-val", String(limit));
    set("nav-speed", String(speed));
    set("nav-speed-unit", U.speed);
    toggleClass($("nav-speed"), "over", over);
    show("nav-cruise", cruise > 0);
    set("nav-cruise", "Круїз " + cruise);
    set("nav-clock", gameClock(d.game_time));
    set("nav-rest", d.next_rest_stop > 0 ? "Відпочинок через " + duration(d.next_rest_stop) : "");

    // --- вантаж ---
    show("cargo-none", !d.job_active);
    show("cargo-job", !!d.job_active);
    if (d.job_active) {
      set("cargo-name", d.job_cargo);
      show("cargo-special", !!d.job_special);
      set("cargo-src-city", d.job_src_city);
      set("cargo-src-company", d.job_src_company);
      set("cargo-dst-city", d.job_dst_city);
      set("cargo-dst-company", d.job_dst_company);
      var mass = d.job_cargo_mass * U.massK;
      set("cargo-mass", (U.mass === "т" ? mass.toFixed(1) : fmtInt(mass)) + " " + U.mass + (d.job_cargo_units > 1 ? " · " + d.job_cargo_units + " од." : ""));
      set("cargo-income", fmtInt(d.job_income) + " " + U.money);
      set("cargo-planned", d.job_planned_km > 0 ? distOf(d.job_planned_km) + " " + U.dist : "—");
      set("cargo-deadline", d.job_delivery_time > 0 ? duration(d.job_delivery_time - d.game_time) : "—");
      var dmg = d.job_cargo_damage * 100;
      set("cargo-damage", dmg.toFixed(1) + " %");
      $("cargo-damage").className = "big " + (dmg >= 5 ? "bad" : dmg > 0 ? "" : "good");
      set("cargo-income-ico", U.money === "$" ? "💵" : "💶");
      setCoat("cargo-src-coa", d.game_id, d.job_src_city_id);
      setCoat("cargo-dst-coa", d.game_id, d.job_dst_city_id);
    }
    renderFinance(d.wallet);

    // --- поворотники: зелене блимання країв екрана (аварійка — обидва) ---
    show("blinker-left", !!(d.blinker_left || d.hazard));
    show("blinker-right", !!(d.blinker_right || d.hazard));

    // --- прилади ---
    set("dash-speed", String(speed));
    set("dash-speed-unit", U.speed);
    toggleClass($("dash-speed"), "over", over);
    show("dash-limit", limit > 0);
    set("dash-limit-val", String(limit));
    show("dash-cruise", cruise > 0);
    set("dash-cruise", "Круїз " + cruise);
    show("dash-pbrake", !!d.parking_brake);
    set("dash-gear", gearLabel(d.gear));
    set("dash-rpm", fmtInt(d.rpm));
    $("dash-rpm-bar").style.width = Math.min(100, (d.rpm / 2500) * 100) + "%";
    var fuelPct = d.fuel_capacity > 0 ? (d.fuel / d.fuel_capacity) * 100 : 0;
    set("dash-fuel", fmtInt(d.fuel * U.fuelK) + " / " + fmtInt(d.fuel_capacity * U.fuelK) + " " + U.fuel);
    $("dash-fuel-bar").style.width = Math.min(100, fuelPct) + "%";
    toggleClass($("dash-fuel-bar"), "low", !!d.fuel_warning);
    set("dash-range", distOf(d.fuel_range) + " " + U.dist);
    if (U.consK) {
      set("dash-avg", d.fuel_avg > 0 ? (d.fuel_avg * U.consK).toFixed(1) + " " + U.cons : "—");
    } else {
      set("dash-avg", d.fuel_avg > 0 ? (0.621371 / (d.fuel_avg * 0.264172)).toFixed(1) + " " + U.cons : "—");
    }
    set("dash-odo", fmtInt(d.odometer * U.distK) + " " + U.dist);
    var wear = Math.max(d.wear_engine, d.wear_transmission, d.wear_cabin, d.wear_chassis, d.wear_wheels) * 100;
    set("dash-wear", wear.toFixed(0) + " %");
    $("dash-wear").className = "big " + (wear >= 10 ? "bad" : "");
    set("dash-truck", [d.truck_brand, d.truck_name].filter(Boolean).join(" "));

    // --- сповіщення (штраф, аварія, доставка…) — перше побачене вважаємо історією ---
    var a = d.alert;
    if (a && lastAlertSeq !== null && a.seq !== lastAlertSeq) showAlert(a);
    lastAlertSeq = a ? a.seq : 0;
  }

  // ---------- панелі поверх карти: перетягування пальцем ----------

  initDraggable(document.querySelector(".page-map"), {
    info: document.querySelector(".nav-info"),
    side: document.querySelector(".overlay.nav-side"),
    maneuver: $("maneuver"),
    buttons: document.querySelector(".map-buttons")
  });
  if (storageGet("panels-hint") !== "seen") {
    setTimeout(function () {
      showAlert({ kind: "info", title: "Панелі можна пересувати", text: "Перетягніть пальцем; подвійний дотик повертає на місце" });
      storageSet("panels-hint", "seen");
    }, 1500);
  }

  // ---------- кнопки карти ----------

  $("map-zoom-in").addEventListener("click", function () { zoomBy(1); });
  $("map-zoom-out").addEventListener("click", function () { zoomBy(-1); });
  $("map-mode").addEventListener("click", function () {
    setMode(getMode() === "overview" ? "follow" : "overview");
    syncMapButtons();
  });
  $("map-recenter").addEventListener("click", function () {
    setMode("follow");
    syncMapButtons();
  });
  // режим змінюється й сам (дотик до карти, автоповернення) — звіряємо кнопки з кожним кадром стану
  function syncMapButtons() {
    var m = getMode();
    toggleClass($("map-mode"), "active", m === "overview");
    $("map-recenter").hidden = m === "follow";
  }

  // ---------- зв'язок ----------

  var es = new EventSource("events");
  es.onmessage = function (e) { render(JSON.parse(e.data)); };
  es.onerror = function () { setStatus("Немає зв'язку з Mac — перепідключаюсь…", true); };

  // ---------- щоб екран не гас ----------

  function keepAwake(cb) {
    if (!("wakeLock" in navigator)) { cb(false); return; }
    navigator.wakeLock.request("screen").then(function () { cb(true); }, function () { cb(false); });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") keepAwake(function () {});
  });
  keepAwake(function (ok) {
    if (!ok && storageGet("wake-hint") !== "seen") show("wake-hint", true);
  });
  $("wake-hint-close").addEventListener("click", function () {
    show("wake-hint", false);
    storageSet("wake-hint", "seen");
  });
})();
