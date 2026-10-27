// Панелі поверх карти можна перетягувати пальцем; позиції запам'ятовуються окремо
// для альбомної й портретної орієнтації (у частках розміру карти — витримують поворот і зміну екрана).
// Подвійний дотик по панелі — повернути її на стандартне місце.
//
// Перетягування починається лише після зсуву > 8 px, тож звичайні натискання на кнопки
// всередині панелей працюють як раніше. Захоплення вказівника — теж лише після цього порогу:
// якби захоплювали одразу, click приходив би на панель, а не на кнопку.

const THRESHOLD = 8;
const DOUBLE_TAP_MS = 320;

function orientation() {
  return window.innerWidth > window.innerHeight ? "landscape" : "portrait";
}
function storageKey() {
  return "panels-" + orientation();
}
function load() {
  try { return JSON.parse(localStorage.getItem(storageKey()) || "{}"); } catch { return {}; }
}
function save(all) {
  try { localStorage.setItem(storageKey(), JSON.stringify(all)); } catch { /* приватний режим */ }
}

/** container — батько з position: relative; panels — { id: element } */
export function initDraggable(container, panels) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function place(el, x, y) {
    const W = container.clientWidth, H = container.clientHeight;
    el.style.left = clamp(x, 0, Math.max(0, W - el.offsetWidth)) + "px";
    el.style.top = clamp(y, 0, Math.max(0, H - el.offsetHeight)) + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = "none";
  }
  function resetStyle(el) {
    for (const p of ["left", "top", "right", "bottom", "transform"]) el.style[p] = "";
  }
  function applyAll() {
    const saved = load();
    const W = container.clientWidth, H = container.clientHeight;
    if (!W || !H) return; // вкладка ще не має розміру
    for (const [id, el] of Object.entries(panels)) {
      const p = saved[id];
      if (p) place(el, p.x * W, p.y * H);
      else resetStyle(el);
    }
  }

  for (const [id, el] of Object.entries(panels)) {
    el.classList.add("draggable");
    let start = null;
    let dragging = false;
    let lastTap = 0;

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const r = el.getBoundingClientRect(), c = container.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left - c.left, top: r.top - c.top, pid: e.pointerId };
      dragging = false;
    });

    el.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.pid) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) < THRESHOLD) return;
        dragging = true;
        el.classList.add("dragging");
        try { el.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
      }
      place(el, start.left + dx, start.top + dy);
      e.preventDefault();
    });

    const finish = (e) => {
      if (!start || e.pointerId !== start.pid) return;
      if (dragging) {
        el.classList.remove("dragging");
        const all = load();
        all[id] = { x: parseFloat(el.style.left) / container.clientWidth, y: parseFloat(el.style.top) / container.clientHeight };
        save(all);
        // натискання, з якого почалось перетягування, не повинно спрацювати як клік по кнопці
        el.addEventListener("click", (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
        lastTap = 0;
      } else if (e.type === "pointerup") {
        const now = Date.now();
        if (now - lastTap < DOUBLE_TAP_MS) {
          const all = load();
          delete all[id];
          save(all);
          resetStyle(el);
          el.classList.add("reset-flash");
          setTimeout(() => el.classList.remove("reset-flash"), 400);
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
      start = null;
      dragging = false;
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  }

  // розміри з'являються, коли вкладку показано; повтор — після повороту/зміни розміру
  const ro = new ResizeObserver(() => applyAll());
  ro.observe(container);
  window.addEventListener("orientationchange", () => setTimeout(applyAll, 250));
  applyAll();
}
