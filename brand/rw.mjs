import { createRequire } from "node:module"; const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync } from "node:fs";
const [, , src, dst, w, h, scale] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(scale||1) });
const svg = readFileSync(src, "utf8").replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`);
await p.setContent(`<html><body style="margin:0">${svg}</body></html>`); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(700);
await p.screenshot({ path: dst, omitBackground: true, clip: { x: 0, y: 0, width: +w, height: +h } }); await b.close();
