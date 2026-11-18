// Generates the Oke Night singing cyclops robot logo variations as SVG.
import { writeFileSync, mkdirSync } from "node:fs";
const out = process.argv[2] || "./out";
mkdirSync(out, { recursive: true });

const glow = (id, sd) => `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">
  <feGaussianBlur in="SourceGraphic" stdDeviation="${sd}" result="b"/>
  <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

// eighth / beamed notes
const note = (x, y, s, c, rot = 0) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" filter="url(#glow)">
  <ellipse cx="0" cy="0" rx="22" ry="16" transform="rotate(-22)" fill="${c}"/>
  <path d="M19 -6 V-92 q8 22 34 34 q8 6 6 26" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></g>`;
const notes2 = (x, y, s, c, rot = 0) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" filter="url(#glow)">
  <ellipse cx="0" cy="0" rx="20" ry="15" transform="rotate(-22)" fill="${c}"/>
  <ellipse cx="62" cy="-14" rx="20" ry="15" transform="rotate(-22 62 -14)" fill="${c}"/>
  <path d="M18 -6 V-86 L80 -100 V-20" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M18 -86 L80 -100" stroke="${c}" stroke-width="16" stroke-linecap="round"/></g>`;

// the shared "bot eye" (same DNA as GafferBot / PennantBot): segmented ring, lime iris ring, dark pupil, highlight, accent arc
const eye = ({ cx, cy, r = 100, ring, iris, accent, pupil, lookX = 0, lookY = 0, sw = 1 }) => {
  const R = r, ir = r * 0.68, pr = r * 0.42;
  const circ = 2 * Math.PI * R;
  return `<g filter="url(#glow)">
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${ring}" stroke-width="${8 * sw}" stroke-dasharray="${circ * 0.21} ${circ * 0.04}" transform="rotate(-80 ${cx} ${cy})" stroke-linecap="round"/>
  <path d="M${cx + R * Math.cos(-0.45)} ${cy + R * Math.sin(-0.45)} A${R} ${R} 0 0 1 ${cx + R * Math.cos(0.45)} ${cy + R * Math.sin(0.45)}" fill="none" stroke="${accent}" stroke-width="${10 * sw}" stroke-linecap="round" transform="translate(${R * 0.0} 0)"/>
  <circle cx="${cx}" cy="${cy}" r="${ir}" fill="${pupil}" stroke="${iris}" stroke-width="${22 * sw}"/>
  <circle cx="${cx + lookX}" cy="${cy + lookY}" r="${pr * 0.9}" fill="${pupil}" stroke="${pupil}" stroke-width="2"/>
  <circle cx="${cx + lookX + pr * 0.42}" cy="${cy + lookY - pr * 0.42}" r="${r * 0.12}" fill="${iris}"/></g>`;
};

const mic = ({ x, y, rot, body, grille, dark, s = 1, hand }) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" filter="url(#glow)">
  <path d="M-20 52 L-14 230 Q0 244 14 230 L20 52 Z" fill="${dark}" stroke="${body}" stroke-width="12" stroke-linejoin="round"/>
  <rect x="-34" y="40" width="68" height="22" rx="8" fill="${dark}" stroke="${body}" stroke-width="11"/>
  <circle cx="0" cy="0" r="50" fill="${dark}" stroke="${body}" stroke-width="13"/>
  <g stroke="${grille}" stroke-width="7" stroke-linecap="round" opacity=".95">
    <path d="M-30 -22 H30 M-38 0 H38 M-30 22 H30"/><path d="M-12 -40 V40 M12 -40 V40" opacity=".6"/></g>
  ${hand ? `<g stroke="${hand}" stroke-linecap="round" stroke-linejoin="round"><rect x="-40" y="108" width="80" height="86" rx="26" fill="${dark}" stroke-width="11"/><path d="M-24 136 H24 M-24 164 H24" stroke-width="8"/><path d="M-40 128 q-26 -6 -24 -34" fill="none" stroke-width="11"/></g>` : ""}</g>`;

const bgSquare = (a, b) => `<radialGradient id="bg" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;

const wrap = (inner, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>${glow("glow", 7)}${glow("soft", 16)}${defs}</defs>
${inner}
</svg>`;

// ---------- A: Headliner (straight from the GafferBot family: navy, cyan HUD ring, lime eye, magenta accent) ----------
function headliner({ ring = true } = {}) {
  const C = { cyan: "#19e6ff", lime: "#c4ff2e", green: "#3dff8a", pink: "#ff3fb8", gold: "#ffb02e", dark: "#060a18" };
  const hud = ring ? `<g filter="url(#glow)" fill="none" stroke="${C.cyan}">
    <circle cx="512" cy="512" r="440" stroke-width="12"/>
    <circle cx="512" cy="512" r="400" stroke-width="3" opacity=".55" stroke-dasharray="70 22"/>
    <path d="M512 52 v34 M512 938 v34 M52 512 h34 M938 512 h34" stroke-width="5" opacity=".7"/>
    <g stroke-width="9" opacity=".75"><path d="M168 360 h40 M160 390 h40 M168 420 h40" /><path d="M816 604 h40 M824 634 h40 M816 664 h40"/></g></g>` : "";
  const inner = `<rect width="1024" height="1024" fill="url(#bg)"/>${hud}
  <!-- antenna -->
  <g filter="url(#glow)"><path d="M512 312 V236" stroke="${C.cyan}" stroke-width="12" stroke-linecap="round"/><circle cx="512" cy="220" r="20" fill="${C.pink}"/></g>
  <!-- ear pods -->
  <g filter="url(#glow)" fill="none" stroke="${C.cyan}" stroke-width="13" stroke-linejoin="round">
    <path d="M300 410 h-30 a14 14 0 0 0 -14 14 v104 a14 14 0 0 0 14 14 h30"/><path d="M724 410 h30 a14 14 0 0 1 14 14 v104 a14 14 0 0 1 -14 14 h-30"/></g>
  <!-- head, segmented like GafferBot's -->
  <rect x="304" y="316" width="416" height="356" rx="104" fill="${C.dark}" stroke="${C.green}" stroke-width="22" stroke-dasharray="58 12" filter="url(#glow)"/>
  ${eye({ cx: 512, cy: 452, r: 104, ring: C.cyan, iris: C.lime, accent: C.pink, pupil: C.dark, lookX: -6, lookY: -6 })}
  <!-- singing mouth -->
  <g filter="url(#glow)"><path d="M458 584 h108 a54 46 0 0 1 -108 0 z" fill="${C.dark}" stroke="${C.pink}" stroke-width="13" stroke-linejoin="round"/>
  <path d="M488 618 q24 -14 48 0" fill="none" stroke="${C.pink}" stroke-width="9" stroke-linecap="round" opacity=".8"/></g>
  ${mic({ x: 646, y: 640, rot: 34, body: C.gold, grille: C.gold, dark: C.dark, s: 0.92, hand: C.cyan })}
  ${note(250, 340, 1.05, C.pink, -8)}${notes2(746, 262, 0.92, C.lime, 6)}${note(236, 640, 0.7, C.cyan, 10)}
  `;
  return wrap(inner, bgSquare("#0d1630", "#03060f"));
}

// ---------- B: Encore (Oke Night colours: plum, hot pink, gold, with the lime bot eye) ----------
function encore({ arms = true, bg = true, halo = true, notes = true } = {}) {
  const C = { pink: "#ff5c9d", gold: "#f5b84a", lime: "#c4ff2e", cyan: "#4de8ff", dark: "#170d1c", ink: "#2b1433" };
  const tube = (d) => `<path d="${d}" fill="none" stroke="${C.pink}" stroke-width="34" stroke-linecap="round" filter="url(#glow)"/><path d="${d}" fill="none" stroke="${C.ink}" stroke-width="11" stroke-linecap="round"/>`;
  // waving hand: palm + three fingers + thumb
  const wave = (x, y, r) => `<g transform="translate(${x} ${y}) rotate(${r})" filter="url(#glow)" stroke="${C.pink}" stroke-linecap="round" fill="${C.ink}">
    <path d="M-20 -30 V-82 M6 -36 V-94 M30 -30 V-80" stroke-width="20"/><path d="M-36 4 l-34 -26" stroke-width="20"/>
    <rect x="-40" y="-40" width="82" height="76" rx="30" stroke-width="16"/></g>`;
  const leftArm = arms ? tube("M262 520 C170 560 120 500 140 400") + wave(146, 380, -14) : "";
  const rightArm = arms ? tube("M770 548 C870 620 820 830 650 832") : "";
  const inner = `${bg ? '<rect width="1024" height="1024" fill="url(#bg)"/>' : ""}
  ${halo ? '<circle cx="512" cy="500" r="330" fill="url(#halo)"/>' : ""}
  <g transform="rotate(-7 512 520)">
  <g filter="url(#glow)"><path d="M512 286 V214" stroke="${C.gold}" stroke-width="16" stroke-linecap="round"/>
    <path d="M512 168 l14 28 31 4 -23 21 6 31 -28 -15 -28 15 6 -31 -23 -21 31 -4z" fill="${C.gold}" stroke="${C.gold}" stroke-width="6" stroke-linejoin="round"/></g>
  ${leftArm}
  <g filter="url(#glow)" fill="${C.ink}" stroke="${C.pink}" stroke-width="18" stroke-linejoin="round">
    <rect x="236" y="408" width="56" height="150" rx="26"/><rect x="732" y="408" width="56" height="150" rx="26"/></g>
  <rect x="282" y="290" width="460" height="400" rx="132" fill="${C.ink}" stroke="${C.pink}" stroke-width="28" filter="url(#glow)"/>
  ${eye({ cx: 512, cy: 450, r: 118, ring: C.cyan, iris: C.lime, accent: C.gold, pupil: C.dark, lookX: -8, lookY: -10, sw: 1.25 })}
  <g filter="url(#glow)"><path d="M446 590 h132 a66 58 0 0 1 -132 0 z" fill="${C.dark}" stroke="${C.gold}" stroke-width="16" stroke-linejoin="round"/>
    <path d="M482 632 q30 -16 60 0" fill="none" stroke="${C.pink}" stroke-width="12" stroke-linecap="round"/></g>
  </g>
  ${rightArm}
  ${mic({ x: 676, y: 670, rot: 32, body: C.gold, grille: C.gold, dark: C.dark, s: 1.08, hand: C.pink })}
  ${notes ? note(arms ? 250 : 206, arms ? 210 : 300, arms ? 1.05 : 1.2, C.gold, -10) + notes2(782, 240, 1.0, C.pink, 8) : ""}
  `;
  return wrap(inner, bgSquare("#3a1636", "#120914") + `<radialGradient id="halo"><stop offset="0" stop-color="#ff5c9d" stop-opacity=".22"/><stop offset="1" stop-color="#ff5c9d" stop-opacity="0"/></radialGradient>`);
}

// ---------- C: Belter (head back, headphones, mic on a stand, spotlight) ----------
function belter() {
  const C = { cyan: "#19e6ff", lime: "#c4ff2e", pink: "#ff3fb8", gold: "#ffb02e", violet: "#9b5cff", dark: "#0a0618" };
  const inner = `<rect width="1024" height="1024" fill="url(#bg)"/>
  <path d="M512 -40 L170 1024 H854 Z" fill="url(#beam)"/>
  <g transform="rotate(10 512 470)">
  <!-- headphones -->
  <g filter="url(#glow)" fill="none" stroke="${C.cyan}" stroke-linecap="round">
    <path d="M286 450 V400 a226 200 0 0 1 452 0 V450" stroke-width="22"/></g>
  <g filter="url(#glow)" fill="${C.dark}" stroke="${C.cyan}" stroke-width="16"><rect x="240" y="400" width="74" height="150" rx="30"/><rect x="710" y="400" width="74" height="150" rx="30"/></g>
  <rect x="300" y="300" width="424" height="370" rx="110" fill="${C.dark}" stroke="${C.violet}" stroke-width="22" filter="url(#glow)"/>
  ${eye({ cx: 512, cy: 440, r: 106, ring: C.cyan, iris: C.lime, accent: C.pink, pupil: C.dark, lookX: 2, lookY: -22 })}
  <g filter="url(#glow)"><ellipse cx="512" cy="600" rx="50" ry="40" fill="${C.dark}" stroke="${C.pink}" stroke-width="14"/>
    <path d="M490 622 q22 -14 44 0" fill="none" stroke="${C.pink}" stroke-width="9" stroke-linecap="round"/></g>
  </g>
  <!-- sound waves -->
  <g filter="url(#glow)" fill="none" stroke="${C.lime}" stroke-width="11" stroke-linecap="round">
    <path d="M760 640 q34 30 28 76"/><path d="M800 610 q56 50 44 128" opacity=".75"/></g>
  <!-- stand mic -->
  <g filter="url(#glow)">
    <path d="M512 790 V990" stroke="${C.gold}" stroke-width="16" stroke-linecap="round"/>
    <rect x="470" y="690" width="84" height="120" rx="42" fill="${C.dark}" stroke="${C.gold}" stroke-width="15"/>
    <path d="M486 726 h52 M486 752 h52 M486 778 h52" stroke="${C.gold}" stroke-width="8" stroke-linecap="round"/></g>
  ${note(210, 260, 1.1, C.pink, -12)}${notes2(770, 210, 0.95, C.lime, 8)}${note(170, 610, 0.75, C.cyan, 8)}
  `;
  return wrap(inner, bgSquare("#1d1240", "#05040d") + `<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9b5cff" stop-opacity=".35"/><stop offset="1" stop-color="#9b5cff" stop-opacity="0"/></linearGradient>`);
}

const files = { "a-headliner": headliner(), "a-headliner-noring": headliner({ ring: false }), "b-encore": encore(), "b-encore-fg": encore({ bg: false }), "b-encore-mark": encore({ bg: false, halo: false, notes: false }), "c-belter": belter() };
for (const [k, v] of Object.entries(files)) writeFileSync(`${out}/${k}.svg`, v);
console.log(Object.keys(files).join(" "));
