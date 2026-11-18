// lockup.mjs <svgdir>: horizontal "Oke Night" wordmark lockups next to each icon (font embedded, OFL Audiowide)
import { readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[2];
const font = readFileSync(new URL("./font/audiowide.woff2", import.meta.url)).toString("base64");
const V = {
  "a-headliner": { c1: "#19e6ff", c2: "#c4ff2e", frame: "#19e6ff", accent: "#ff3fb8", iris: "#c4ff2e", ring: "#19e6ff", bg: "#060a18" },
  "b-encore": { c1: "#ff5c9d", c2: "#f5b84a", frame: "#ff5c9d", accent: "#f5b84a", iris: "#c4ff2e", ring: "#4de8ff", bg: "#170d1c" },
  "c-belter": { c1: "#19e6ff", c2: "#c4ff2e", frame: "#9b5cff", accent: "#ff3fb8", iris: "#c4ff2e", ring: "#19e6ff", bg: "#0a0618" },
};
for (const [k, c] of Object.entries(V)) {
  const src = readFileSync(`${dir}/${k}.svg`, "utf8");
  const defs = src.match(/<defs>([\s\S]*?)<\/defs>/)[1];
  const body = src.split("</defs>")[1].replace("</svg>", "");
  const R = 62, cx = 640, cy = 262, circ = 2 * Math.PI * R;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1640 520" width="1640" height="520">
<defs>${defs}<style>@font-face{font-family:"OkeWord";src:url(data:font/woff2;base64,${font}) format("woff2");}</style>
<clipPath id="disc"><circle cx="512" cy="512" r="470"/></clipPath></defs>
<g filter="url(#glow)" fill="${c.bg}" stroke="${c.frame}" stroke-width="7" stroke-linejoin="round">
  <path d="M520 132 H1100 l22 -22 H1300 l22 22 H1590 l24 24 V364 l-24 24 H1240 l-22 22 H880 l-22 -22 H520 l-24 -24 V156 Z"/></g>
<g filter="url(#glow)" stroke-linecap="round"><path d="M600 352 H820" stroke="${c.frame}" stroke-width="6" opacity=".7"/><path d="M1380 352 H1540" stroke="${c.accent}" stroke-width="8"/></g>
<svg x="10" y="10" width="500" height="500" viewBox="0 0 1024 1024"><g clip-path="url(#disc)">${body}</g>
  <circle cx="512" cy="512" r="470" fill="none" stroke="${c.frame}" stroke-width="16" filter="url(#glow)"/></svg>
<g filter="url(#glow)">
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${c.ring}" stroke-width="7" stroke-dasharray="${circ * 0.21} ${circ * 0.04}" transform="rotate(-80 ${cx} ${cy})"/>
  <path d="M${cx + R * Math.cos(-0.45)} ${cy + R * Math.sin(-0.45)} A${R} ${R} 0 0 1 ${cx + R * Math.cos(0.45)} ${cy + R * Math.sin(0.45)}" fill="none" stroke="${c.accent}" stroke-width="9" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="${R * 0.66}" fill="${c.bg}" stroke="${c.iris}" stroke-width="15"/>
  <circle cx="${cx + 11}" cy="${cy - 11}" r="8" fill="${c.iris}"/></g>
<text x="712" y="316" font-family="OkeWord, Audiowide, sans-serif" font-size="156" filter="url(#glow)"><tspan fill="${c.c1}">ke</tspan><tspan dx="44" fill="${c.c2}">Night</tspan></text>
</svg>`;
  writeFileSync(`${dir}/${k}-wordmark.svg`, svg);
}
