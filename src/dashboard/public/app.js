"use strict";
/* global ethers */

// Dashboard: reads everything on-chain through a read-only JSON-RPC proxy,
// plus oracle status and simulator telemetry from the demo process.

const REFRESH_MS = 1500;
const INTERVAL = 900;

// ---------------------------------------------------------------------------
// Formatting and DOM helpers (all dynamic text goes through textContent)
// ---------------------------------------------------------------------------

const kwh = (wh, digits = 2) => (Number(wh) / 1000).toFixed(digits);
const usd = (units, digits = 2) => {
  const v = Number(units) / 1e6;
  return v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(digits)}`;
};
const perKwh = (units) => `$${(Number(units) / 1e6).toFixed(3)}`;
const hhmm = (ts) => new Date(Number(ts) * 1000).toISOString().slice(11, 16);
const span = (t0) => `${hhmm(t0)}–${hhmm(Number(t0) + INTERVAL) === "00:00" ? "24:00" : hhmm(Number(t0) + INTERVAL)}`;
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function status(kind, label) {
  return h("span", { class: "status" }, h("span", { class: `icon ${kind}`, "aria-hidden": "true" }), label);
}

function setText(id, text) {
  document.getElementById(id).textContent = text;
}

function setTable(id, columns, rows, emptyText) {
  const table = document.getElementById(id);
  table.replaceChildren(
    h("thead", null, h("tr", null, columns.map((c) => h("th", c.num ? { class: "num" } : null, c.label)))),
    h(
      "tbody",
      null,
      rows.length
        ? rows.map((r) => h("tr", null, r.map((cell, i) => h("td", columns[i].num ? { class: "num" } : null, cell))))
        : h("tr", null, h("td", { colspan: String(columns.length), class: "muted" }, emptyText || "Nothing yet")),
    ),
  );
}

function who(p, fallbackAddress) {
  if (!p) return h("span", { class: "who" }, fallbackAddress ? shortAddr(fallbackAddress) : "?");
  return h("span", { class: "who" }, p.id, h("span", { class: "sub" }, p.label.split(" · ")[1] || p.role));
}

const tooltip = document.getElementById("tooltip");
function showTooltip(x, y, title, rows) {
  tooltip.replaceChildren(
    h("div", { class: "tt-title" }, title),
    ...rows.map((r) =>
      h(
        "div",
        { class: "tt-row" },
        r.color ? h("span", { class: "key-line", style: `background:${r.color}` }) : null,
        h("span", { class: "tt-value" }, r.value),
        h("span", { class: "tt-label" }, r.label),
      ),
    ),
  );
  tooltip.hidden = false;
  const pad = 14;
  const { width, height } = tooltip.getBoundingClientRect();
  const left = x + pad + width > window.innerWidth ? x - pad - width : x + pad;
  const top = Math.min(window.innerHeight - height - 4, Math.max(4, y - height / 2));
  tooltip.style.left = `${Math.max(4, left)}px`;
  tooltip.style.top = `${top}px`;
}
function hideTooltip() {
  tooltip.hidden = true;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

// ---------------------------------------------------------------------------
// Chain state, rebuilt incrementally from events
// ---------------------------------------------------------------------------

const state = {
  nextBlock: 0,
  intervals: new Map(), // intervalStart -> { exp, imp } (Wh)
  lastReading: new Map(), // participant id -> reading
  minted: 0n,
  burned: 0n,
  listings: new Map(), // id -> listing
  trades: [],
  blockTimes: new Map(),
  hoverIdx: null,
  pointer: null, // last pointer position over the flow chart, to restore the tooltip after a refresh
};

async function main() {
  const cfg = await (await fetch("/api/config")).json();
  const d = cfg.deployment;
  const provider = new ethers.JsonRpcProvider(`${location.origin}/rpc`, d.chainId, { staticNetwork: true });
  const token = new ethers.Contract(d.contracts.energyToken, cfg.abis.EnergyToken, provider);
  const market = new ethers.Contract(d.contracts.marketplace, cfg.abis.EnergyMarketplace, provider);
  const stable = new ethers.Contract(d.contracts.stablecoin, cfg.abis.MockStablecoin, provider);
  const people = d.participants;
  const byAddr = new Map();
  for (const p of people) {
    byAddr.set(p.wallet.toLowerCase(), p);
    byAddr.set(p.meter.toLowerCase(), p);
  }
  const person = (addr) => byAddr.get(String(addr).toLowerCase());
  renderLegend();
  // Bars are re-created on every refresh, so hide the income tooltip from the persistent container.
  const incomeRoot = document.getElementById("income-chart");
  incomeRoot.addEventListener("pointerleave", hideTooltip);
  incomeRoot.addEventListener("pointermove", (ev) => {
    if (!ev.target.classList || !ev.target.classList.contains("bar")) hideTooltip();
  });

  async function blockTime(n) {
    if (!state.blockTimes.has(n)) state.blockTimes.set(n, provider.getBlock(n).then((b) => b.timestamp));
    return state.blockTimes.get(n);
  }

  async function syncEvents() {
    const latest = await provider.getBlockNumber();
    if (latest < state.nextBlock) return;
    const from = state.nextBlock;
    const q = (c, name) => c.queryFilter(c.filters[name](), from, latest);
    const [readings, minted, burned, created, repriced, cancelled, trades] = await Promise.all([
      q(token, "ReadingSettled"),
      q(token, "CreditsMinted"),
      q(token, "CreditsBurned"),
      q(market, "ListingCreated"),
      q(market, "ListingPriceUpdated"),
      q(market, "ListingCancelled"),
      q(market, "Trade"),
    ]);
    const times = new Map(
      await Promise.all(
        [...new Set([...created, ...trades].map((e) => e.blockNumber))].map(async (n) => [n, await blockTime(n)]),
      ),
    );

    for (const e of readings) {
      const t = Number(e.args.intervalStart);
      const slot = state.intervals.get(t) || { exp: 0, imp: 0 };
      slot.exp += Number(e.args.exportedWh);
      slot.imp += Number(e.args.importedWh);
      state.intervals.set(t, slot);
      const p = person(e.args.meter);
      if (p) {
        state.lastReading.set(p.id, {
          intervalStart: t,
          exportedWh: Number(e.args.exportedWh),
          importedWh: Number(e.args.importedWh),
          nonce: Number(e.args.nonce),
        });
      }
    }
    for (const e of minted) state.minted += e.args.amountWh;
    for (const e of burned) state.burned += e.args.amountWh;
    // Apply marketplace events in chain order so listing state stays exact.
    const marketEvents = [...created, ...repriced, ...cancelled, ...trades].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
    );
    for (const e of marketEvents) {
      const id = e.args.listingId.toString();
      if (e.eventName === "ListingCreated") {
        state.listings.set(id, {
          id,
          seller: e.args.seller,
          amountWh: e.args.amountWh,
          remainingWh: e.args.amountWh,
          price: e.args.pricePerKwh,
          at: times.get(e.blockNumber),
          active: true,
        });
      } else if (e.eventName === "ListingPriceUpdated") {
        state.listings.get(id).price = e.args.newPricePerKwh;
      } else if (e.eventName === "ListingCancelled") {
        const l = state.listings.get(id);
        l.remainingWh = 0n;
        l.active = false;
      } else {
        const l = state.listings.get(id);
        l.remainingWh -= e.args.amountWh;
        if (l.remainingWh === 0n) l.active = false;
        state.trades.push({
          id,
          seller: e.args.seller,
          buyer: e.args.buyer,
          amountWh: e.args.amountWh,
          price: e.args.pricePerKwh,
          cost: e.args.cost,
          at: times.get(e.blockNumber),
        });
      }
    }
    state.nextBlock = latest + 1;
  }

  async function refresh() {
    const [demo, oracle] = await Promise.all([
      fetch("/api/demo").then((r) => r.json()),
      fetch("/api/oracle").then((r) => r.json()),
      syncEvents(),
    ]);
    const [block, paused, balances] = await Promise.all([
      provider.getBlock("latest"),
      token.paused(),
      Promise.all(people.map((p) => Promise.all([token.balanceOf(p.wallet), stable.balanceOf(p.wallet)]))),
    ]);

    renderHeader(demo, block, paused);
    renderKpis(oracle, cfg.tariffs);
    renderFlowChart(demo);
    renderIncome(people);
    renderMeters(people, demo);
    renderBalances(people, balances);
    renderListings(person);
    renderTrades(person);
    renderScenarios(demo.scenarios);
    renderOracle(oracle, person);
  }

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await refresh();
    } catch (err) {
      console.error(err);
      const chip = document.getElementById("chip-phase");
      chip.replaceChildren(status("critical", "Disconnected — is the demo running?"));
    } finally {
      busy = false;
    }
  };
  await tick();
  setInterval(tick, REFRESH_MS);
  window.addEventListener("resize", () => renderFlowChart(state.lastDemo));
}

// ---------------------------------------------------------------------------
// Header and KPI tiles
// ---------------------------------------------------------------------------

function renderHeader(demo, block, paused) {
  const done = demo.phase === "complete";
  setText("sim-time", done ? "24:00" : demo.intervalIndex >= 0 ? hhmm(block.timestamp) : "--:--");
  setText("sim-date", `${demo.simDate} (UTC)`);
  const pct = Math.round(((demo.intervalIndex + 1) / demo.intervalsTotal) * 100);
  document.getElementById("day-meter-fill").style.width = `${Math.max(0, pct)}%`;
  document.getElementById("day-meter").setAttribute("aria-valuenow", String(pct));
  const phase = { starting: ["warning", "Starting"], running: ["good", "Simulating"], complete: ["good", "Day complete"] }[demo.phase];
  document.getElementById("chip-phase").replaceChildren(status(phase[0], phase[1]));
  document.getElementById("chip-token").replaceChildren(paused ? status("warning", "Token paused") : status("good", "Token active"));
  setText("chip-block", `Block ${block.number}`);
}

function renderKpis(oracle, tariffs) {
  const tradedWh = state.trades.reduce((a, t) => a + t.amountWh, 0n);
  const tradedCost = state.trades.reduce((a, t) => a + t.cost, 0n);
  setText("kpi-minted", `${kwh(state.minted, 1)} kWh`);
  setText("kpi-minted-sub", `${state.intervals.size} intervals settled`);
  setText("kpi-traded", `${kwh(tradedWh, 1)} kWh`);
  setText("kpi-traded-sub", `${state.trades.length} trades · ${usd(tradedCost)} volume`);
  setText("kpi-burned", `${kwh(state.burned, 1)} kWh`);
  setText("kpi-burned-sub", `${kwh(state.minted - state.burned, 2)} kWh of credits outstanding`);
  setText("kpi-price", tradedWh > 0n ? perKwh((tradedCost * 1000n) / tradedWh) : "–");
  setText("kpi-price-sub", `vs grid retail $${tariffs.gridRetailUsdPerKwh.toFixed(2)} · feed-in $${tariffs.feedInUsdPerKwh.toFixed(2)}`);
  const st = oracle.stats;
  setText("kpi-oracle", `${st.settled} settled`);
  const sub = document.getElementById("kpi-oracle-sub");
  sub.replaceChildren(
    status(st.rejected ? "critical" : "good", `${st.rejected} rejected`),
    " · ",
    status(st.queued ? "warning" : "good", `${st.queued} queued`),
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const SERIES = [
  { key: "exp", label: "Verified export", color: "var(--series-1)" },
  { key: "imp", label: "Grid import", color: "var(--series-2)" },
];

function renderLegend() {
  document
    .getElementById("flow-legend")
    .replaceChildren(
      ...SERIES.map((sr) =>
        h("span", { class: "legend-item" }, h("span", { class: "key-line", style: `background:${sr.color}` }), sr.label),
      ),
    );
}

function renderFlowChart(demo) {
  if (!demo) return;
  state.lastDemo = demo;
  const root = document.getElementById("flow-chart");
  const W = Math.max(320, root.clientWidth || 600);
  const H = 240;
  const m = { l: 40, r: 64, t: 10, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const day = demo.dayStart;
  const points = [];
  for (let i = 0; i < 96; i++) {
    const v = state.intervals.get(day + i * INTERVAL);
    if (v) points.push({ i, t: day + i * INTERVAL, exp: v.exp / 1000, imp: v.imp / 1000 });
  }
  const yMax = niceMax(Math.max(0.5, ...points.map((p) => Math.max(p.exp, p.imp))));
  const x = (i) => m.l + ((i + 0.5) / 96) * pw;
  const y = (v) => m.t + ph - (v / yMax) * ph;

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Verified export and grid import per interval" });
  for (let k = 0; k <= 4; k++) {
    const v = (yMax / 4) * k;
    svg.append(s("line", { class: k === 0 ? "baseline" : "gridline", x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }));
    svg.append(s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(yMax < 2 ? 2 : 1)));
  }
  for (let hr = 0; hr <= 24; hr += 3) {
    svg.append(s("text", { x: m.l + (hr / 24) * pw, y: H - 6, "text-anchor": "middle" }, `${String(hr).padStart(2, "0")}:00`));
  }
  if (!points.length) {
    svg.append(s("text", { x: m.l + pw / 2, y: m.t + ph / 2, "text-anchor": "middle" }, "Waiting for the first readings…"));
    root.replaceChildren(svg);
    return;
  }

  for (const sr of SERIES) {
    const d = points.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p[sr.key]).toFixed(1)}`).join("");
    svg.append(s("path", { d, fill: "none", style: `stroke:${sr.color}`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  // Direct labels at the line ends, only when they don't collide.
  const last = points[points.length - 1];
  const ends = SERIES.map((sr) => ({ sr, y: y(last[sr.key]) }));
  if (Math.abs(ends[0].y - ends[1].y) >= 14) {
    for (const e of ends) svg.append(s("text", { x: x(last.i) + 8, y: e.y + 4, class: "cat-label" }, e.sr.key === "exp" ? "Export" : "Import"));
  }

  // Crosshair + tooltip layer (hover, and arrow keys when focused).
  const cross = s("g", { visibility: "hidden" });
  const crossLine = s("line", { class: "crosshair", y1: m.t, y2: m.t + ph });
  const dots = SERIES.map((sr) => s("circle", { r: 4, style: `fill:${sr.color}; stroke: var(--surface-1)`, "stroke-width": 2 }));
  cross.append(crossLine, ...dots);
  svg.append(cross);
  const lastIdx = last.i;
  const show = (idx, clientX, clientY) => {
    const p = points.find((q) => q.i === idx);
    if (!p) return;
    state.hoverIdx = idx;
    cross.setAttribute("visibility", "visible");
    crossLine.setAttribute("x1", x(idx));
    crossLine.setAttribute("x2", x(idx));
    SERIES.forEach((sr, k) => {
      dots[k].setAttribute("cx", x(idx));
      dots[k].setAttribute("cy", y(p[sr.key]));
    });
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    showTooltip(
      clientX ?? rect.left + x(idx) * scale,
      clientY ?? rect.top + m.t * scale + 40,
      `${span(p.t)} UTC`,
      SERIES.map((sr) => ({ color: sr.color, value: `${p[sr.key].toFixed(2)} kWh`, label: sr.label })),
    );
  };
  const hit = s("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent" });
  hit.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const idx = Math.min(lastIdx, Math.max(points[0].i, Math.round(((px - m.l) / pw) * 96 - 0.5)));
    state.pointer = { x: ev.clientX, y: ev.clientY };
    show(idx, ev.clientX, ev.clientY);
  });
  hit.addEventListener("pointerleave", () => {
    state.hoverIdx = null;
    state.pointer = null;
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  svg.append(hit);
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("focus", () => show(state.hoverIdx ?? lastIdx));
  svg.addEventListener("blur", () => {
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  svg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const cur = state.hoverIdx ?? lastIdx;
    show(Math.min(lastIdx, Math.max(points[0].i, cur + (ev.key === "ArrowLeft" ? -1 : 1))));
  });
  const hadFocus = root.contains(document.activeElement);
  root.replaceChildren(svg);
  if (hadFocus) svg.focus();
  else if (state.pointer && state.hoverIdx !== null) show(Math.min(state.hoverIdx, lastIdx), state.pointer.x, state.pointer.y);
}

function renderIncome(people) {
  const root = document.getElementById("income-chart");
  const prosumers = people.filter((p) => p.role === "prosumer");
  const rows = prosumers.map((p) => {
    const mine = state.trades.filter((t) => t.seller.toLowerCase() === p.wallet.toLowerCase());
    const revenue = mine.reduce((a, t) => a + t.cost, 0n);
    const soldWh = mine.reduce((a, t) => a + t.amountWh, 0n);
    return { p, revenue: Number(revenue) / 1e6, soldWh, avg: soldWh > 0n ? (revenue * 1000n) / soldWh : null };
  });
  const W = Math.max(320, root.clientWidth || 480);
  const rowH = 40;
  const m = { l: 76, r: 64, t: 4, b: 22 };
  const H = m.t + rows.length * rowH + m.b;
  const pw = W - m.l - m.r;
  const xMax = niceMax(Math.max(0.5, ...rows.map((r) => r.revenue)));
  const x = (v) => m.l + (v / xMax) * pw;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Peer-to-peer income per prosumer" });
  for (let k = 0; k <= 4; k++) {
    const v = (xMax / 4) * k;
    svg.append(s("line", { class: k === 0 ? "baseline" : "gridline", x1: x(v), x2: x(v), y1: m.t, y2: H - m.b }));
    svg.append(s("text", { x: x(v), y: H - 6, "text-anchor": "middle" }, `$${v.toFixed(xMax < 2 ? 2 : 1)}`));
  }
  rows.forEach((r, k) => {
    const cy = m.t + k * rowH + rowH / 2;
    const thick = 20;
    svg.append(s("text", { x: m.l - 8, y: cy - 2, "text-anchor": "end", class: "cat-label" }, r.p.id));
    svg.append(s("text", { x: m.l - 8, y: cy + 12, "text-anchor": "end" }, `${r.p.pvKw} kW${r.p.batteryKwh ? " + batt" : ""}`));
    const len = x(r.revenue) - m.l;
    if (len > 0.5) {
      const rad = Math.min(4, len);
      const x0 = m.l;
      const x1 = m.l + len;
      const y0 = cy - thick / 2;
      const d = `M${x0},${y0}H${x1 - rad}Q${x1},${y0} ${x1},${y0 + rad}V${y0 + thick - rad}Q${x1},${y0 + thick} ${x1 - rad},${y0 + thick}H${x0}Z`;
      const bar = s("path", { d, class: "bar", style: "fill: var(--series-1)", tabindex: "0" });
      const tip = (cx, cy2) =>
        showTooltip(cx, cy2, r.p.label, [
          { value: `$${r.revenue.toFixed(2)}`, label: "earned" },
          { value: `${kwh(r.soldWh)} kWh`, label: "sold" },
          { value: r.avg === null ? "–" : `${perKwh(r.avg)}/kWh`, label: "average price" },
        ]);
      bar.addEventListener("pointermove", (ev) => tip(ev.clientX, ev.clientY));
      bar.addEventListener("pointerleave", hideTooltip);
      bar.addEventListener("focus", () => {
        const b = bar.getBoundingClientRect();
        tip(b.right, b.top + b.height / 2);
      });
      bar.addEventListener("blur", hideTooltip);
      svg.append(bar);
    }
    svg.append(s("text", { x: x(r.revenue) + 6, y: cy + 4, class: "value-label" }, `$${r.revenue.toFixed(2)}`));
  });
  root.replaceChildren(svg);
}

// ---------------------------------------------------------------------------
// Tables and panels
// ---------------------------------------------------------------------------

function oracleStatusNode(st, code) {
  if (st === "settled") return status("good", "Settled");
  if (st === "queued") return status("warning", "Queued");
  return h("span", { class: "who" }, status("critical", "Rejected"), code ? h("span", { class: "sub" }, code) : null);
}

function renderMeters(people, demo) {
  const rows = people.map((p) => {
    const r = state.lastReading.get(p.id);
    const live = demo.households[p.id];
    return [
      who(p),
      r ? span(r.intervalStart) : "–",
      live ? (live.pvWh / 250).toFixed(2) : "–",
      live ? (live.loadWh / 250).toFixed(2) : "–",
      p.batteryKwh ? (live ? `${live.batterySocKwh.toFixed(1)} / ${p.batteryKwh}` : "–") : "—",
      r ? r.exportedWh.toLocaleString() : "–",
      r ? r.importedWh.toLocaleString() : "–",
      r ? String(r.nonce) : "–",
      live ? oracleStatusNode(live.oracleStatus) : "–",
    ];
  });
  setTable(
    "meters-table",
    [
      { label: "Meter" },
      { label: "Interval (UTC)" },
      { label: "PV kW", num: true },
      { label: "Load kW", num: true },
      { label: "Battery kWh", num: true },
      { label: "Export Wh", num: true },
      { label: "Import Wh", num: true },
      { label: "Nonce", num: true },
      { label: "Oracle" },
    ],
    rows,
  );
}

function renderBalances(people, balances) {
  const escrow = new Map();
  for (const l of state.listings.values()) {
    if (!l.active) continue;
    const k = l.seller.toLowerCase();
    escrow.set(k, (escrow.get(k) || 0n) + l.remainingWh);
  }
  const rows = people.map((p, k) => {
    const w = p.wallet.toLowerCase();
    const sold = state.trades.filter((t) => t.seller.toLowerCase() === w);
    const bought = state.trades.filter((t) => t.buyer.toLowerCase() === w);
    const soldWh = sold.reduce((a, t) => a + t.amountWh, 0n);
    const boughtWh = bought.reduce((a, t) => a + t.amountWh, 0n);
    const earned = sold.reduce((a, t) => a + t.cost, 0n);
    const spent = bought.reduce((a, t) => a + t.cost, 0n);
    return [
      who(p),
      p.role,
      kwh(balances[k][0]),
      kwh(escrow.get(w) || 0n),
      usd(balances[k][1]),
      p.role === "prosumer" ? kwh(soldWh) : kwh(boughtWh),
      p.role === "prosumer" ? `+${usd(earned)}` : `-${usd(spent)}`,
    ];
  });
  setTable(
    "balances-table",
    [
      { label: "Participant" },
      { label: "Role" },
      { label: "EKWH in wallet", num: true },
      { label: "EKWH listed", num: true },
      { label: "mUSD", num: true },
      { label: "Sold / bought kWh", num: true },
      { label: "Earned / spent", num: true },
    ],
    rows,
  );
}

function renderListings(person) {
  const open = [...state.listings.values()].filter((l) => l.active).sort((a, b) => (a.price === b.price ? Number(a.id) - Number(b.id) : a.price < b.price ? -1 : 1));
  const escrowWh = open.reduce((a, l) => a + l.remainingWh, 0n);
  setText("listings-sub", `${open.length} open · ${kwh(escrowWh)} kWh in escrow · cheapest first`);
  setTable(
    "listings-table",
    [{ label: "#", num: true }, { label: "Seller" }, { label: "Remaining kWh", num: true }, { label: "Price / kWh", num: true }, { label: "Listed", num: true }],
    open.map((l) => [l.id, who(person(l.seller), l.seller), kwh(l.remainingWh), perKwh(l.price), l.at ? hhmm(l.at) : "–"]),
    "No open listings",
  );
}

function renderTrades(person) {
  const recent = state.trades.slice(-60).reverse();
  setText("trades-sub", `${state.trades.length} trades · most recent first`);
  setTable(
    "trades-table",
    [{ label: "Time", num: true }, { label: "Listing", num: true }, { label: "Seller" }, { label: "Buyer" }, { label: "kWh", num: true }, { label: "Price / kWh", num: true }, { label: "Paid", num: true }],
    recent.map((t) => [
      t.at ? hhmm(t.at) : "–",
      `#${t.id}`,
      (person(t.seller) || {}).id || shortAddr(t.seller),
      (person(t.buyer) || {}).id || shortAddr(t.buyer),
      kwh(t.amountWh),
      perKwh(t.price),
      usd(t.cost),
    ]),
    "No trades yet",
  );
}

function renderScenarios(scenarios) {
  const root = document.getElementById("scenarios");
  if (!scenarios.length) {
    root.replaceChildren(h("p", { class: "muted" }, "The first scenario runs at 09:00 simulated time."));
    return;
  }
  root.replaceChildren(
    ...scenarios.map((sc) => {
      const safe = sc.steps.every((st) => st.blocked);
      return h(
        "div",
        { class: "scenario" },
        h("h3", null, `${hhmm(sc.at)} · ${sc.title} `, safe ? status("good", "handled safely") : status("critical", "NOT handled")),
        h("p", { class: "threat" }, sc.threat),
        ...sc.steps.map((st) =>
          h(
            "div",
            { class: "step" },
            h("span", { class: `icon ${st.blocked ? "good" : "critical"}`, "aria-hidden": "true" }),
            h("span", null, st.action),
            h("span", { class: "result" }, `→ ${st.result}`),
          ),
        ),
      );
    }),
  );
}

function renderOracle(oracle, person) {
  const columns = [{ label: "Chain time", num: true }, { label: "Meter" }, { label: "Interval" }, { label: "Export / import Wh", num: true }, { label: "Decision" }];
  const row = (e) => {
    const p = e.meter ? person(e.meter) : null;
    return [
      hhmm(e.receivedAt),
      p
        ? e.code === "BAD_SIGNATURE" ? `${p.id} (claimed)` : p.id
        : e.meter ? h("span", { class: "who" }, "unregistered", h("span", { class: "sub" }, shortAddr(e.meter))) : "malformed",
      e.intervalStart !== undefined ? span(e.intervalStart) : "–",
      e.exportedWh !== undefined ? `${e.exportedWh.toLocaleString()} / ${e.importedWh.toLocaleString()}` : "–",
      oracleStatusNode(e.status, e.code),
    ];
  };
  setTable("rejections-table", columns, oracle.rejections.slice().reverse().map(row), "No rejected readings");
  setTable("oracle-table", columns, oracle.recent.slice(-80).reverse().map(row), "No readings yet");
}

main().catch((err) => {
  console.error(err);
  document.getElementById("chip-phase").replaceChildren(status("critical", "Could not load /api/config"));
});
