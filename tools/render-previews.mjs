#!/usr/bin/env node
// Renders the theme preview images in docs/screenshots/ from themes.js.
//
//   node tools/render-previews.mjs
//
// Needs Node 18+ and a Chromium/Chrome binary (set CHROME=/path/to/binary to override).
// All values shown are placeholders (RFC 5737 / RFC 6598 documentation ranges); nothing is read
// from the machine it runs on.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "screenshots");
const { THEMES, THEME_ORDER } = await import(pathToFileURL(join(root, "themes.js")).href);

const CHROME = process.env.CHROME ?? "chromium";
const WIDTH = 330; // matches the extension's default widget width

// Placeholder data.
const ROWS = [
  { g: 0, k: "Wi-Fi", v: "HomeNetwork" },
  { g: 0, k: "Link", v: "↓ 866  ↑ 780 Mbps" },
  { g: 0, k: "Local IP", v: "192.168.1.42", s: "Automatic" },
  { g: 0, k: "Gateway", v: "192.168.1.1" },
  { g: 1, k: "Public IP", v: "203.0.113.42" },
  { g: 1, k: "Location", v: "Amsterdam, Netherlands", s: "Example Broadband" },
  { g: 2, k: "Proxy", v: "Off", dot: "off" },
  { g: 2, k: "VPN", v: "Tailscale", dot: "on" },
  { g: 2, k: "Profile", v: "user@example.com · example.ts.net" },
  { g: 2, k: "Tailscale", v: "100.64.0.12" },
  { g: 2, k: "Exit node", v: "exit-node-1 · 100.64.0.7" },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function backdrop(t) {
  const light = t.card && luminance(t.card.rgb) > 0.6;
  return light
    ? "linear-gradient(135deg, #8fa3c2 0%, #5d7194 55%, #3d4c69 100%)"
    : "linear-gradient(135deg, #43557a 0%, #232c42 55%, #12151f 100%)";
}

function widget(t) {
  const right = t.defaultAlign === "right";
  const c = t.card;
  const font = t.font ?? "Inter, 'Noto Sans', sans-serif";
  const keyW = t.font ? 80 : 62;
  const card = c
    ? `background:rgba(${c.rgb.join(",")},${c.alpha});border:1px solid ${c.border};padding:14px 18px 16px;`
    : "padding:6px 4px;";

  let html = "";
  let prev = -1;
  for (const r of ROWS) {
    if (prev >= 0 && r.g !== prev) html += `<div style="height:1px;background:${t.divider}"></div>`;
    prev = r.g;
    const glyph = r.dot ? (t.hollowOff && r.dot !== "on" ? "○" : "●") : "";
    const dot = r.dot
      ? `<div style="width:12px;font-size:9px;padding-top:3px;color:${r.dot === "on" ? t.on : t.off}">${glyph}</div>`
      : "";
    const key = `<div style="width:${keyW}px;flex:none;font-size:11px;padding-top:1px;color:${t.dim}">${r.k}</div>`;
    const val =
      `<div style="flex:1;text-align:${right ? "right" : "left"}">` +
      `<div style="font-size:13px;font-weight:700;color:${t.text}">${esc(r.v)}</div>` +
      (r.s ? `<div style="font-size:11px;color:${t.dim};margin-top:1px">${esc(r.s)}</div>` : "") +
      `</div>`;
    html += `<div style="display:flex;gap:12px">${right ? val + dot + key : key + dot + val}</div>`;
  }

  const head =
    `<div style="display:flex;gap:8px;align-items:center;${right ? "justify-content:flex-end;" : ""}">` +
    `<div style="${right ? "" : "flex:1;"}font-size:10px;font-weight:700;letter-spacing:2.4px;color:${t.dim}">NETWORK</div>` +
    `<div style="font-size:10px;color:${t.on}">●</div></div>`;

  return `<div style="width:${WIDTH}px;${card}display:flex;flex-direction:column;gap:11px;font-family:${font}">${head}${html}</div>`;
}

const page = (inner, w, h, bodyStyle = "") =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${w}px;height:${h}px;${bodyStyle}">${inner}</body>`;

function single(id) {
  const t = THEMES[id];
  const label = `<div style="position:absolute;left:22px;bottom:18px;font:13px sans-serif;color:rgba(255,255,255,.8)">${esc(t.name)}</div>`;
  return page(
    `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)">${widget(t)}</div>${label}`,
    560,
    560,
    `background:${backdrop(t)};position:relative;overflow:hidden;`,
  );
}

function overview() {
  const cols = 4;
  const cellW = 470;
  const cellH = 520;
  const rows = Math.ceil(THEME_ORDER.length / cols);
  const cells = THEME_ORDER.map((id) => {
    const t = THEMES[id];
    return (
      `<div style="width:${cellW}px;height:${cellH}px;background:${backdrop(t)};position:relative;overflow:hidden">` +
      `<div style="position:absolute;left:50%;top:48%;transform:translate(-50%,-50%)">${widget(t)}</div>` +
      `<div style="position:absolute;left:18px;bottom:14px;font:13px sans-serif;color:rgba(255,255,255,.8)">${esc(t.name)}</div></div>`
    );
  }).join("");
  return page(`<div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px)">${cells}</div>`, cols * cellW, rows * cellH);
}

function shoot(html, outFile, w, h, tmp) {
  const htmlFile = join(tmp, "page.html");
  writeFileSync(htmlFile, html);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--screenshot=${outFile}`,
      `--window-size=${w},${h}`,
      pathToFileURL(htmlFile).href,
    ],
    { stdio: "ignore" },
  );
}

mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "gnet-previews-"));
try {
  for (const id of THEME_ORDER) {
    shoot(single(id), join(outDir, `${id}.png`), 560, 560, tmp);
    console.log(`rendered ${id}`);
  }
  const cols = 4;
  shoot(overview(), join(outDir, "overview.png"), cols * 470, Math.ceil(THEME_ORDER.length / cols) * 520, tmp);
  console.log("rendered overview");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
