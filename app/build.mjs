// Builds the app's web files into www/ (Capacitor copies www/ into the iPhone and Android projects).
//
//   www/index.html   the app's own first screen: pick a bar, reminders (shell/index.html)
//   www/remind.js    bar list + local-notification reminders (shell/remind.js)
//   www/venue.html   the singer page, made from site/src/index.html, the same page as okenight.com/<bar>/
//
// venue.html runs from inside the app (capacitor://localhost or https://localhost), so before anything else
// its head script sets window.OKE_VENUE from the bar picked on the first screen, turns on app mode
// (OKE_APP: no tips, no bar pitch) and adds <base href="https://okenight.com/<bar>/">, so the page's
// relative calls (api/plays, api/art, ...) and links go to the site, exactly as on the web. The site's
// scripts (fun.js, bingo.js, ...) are inlined, so they ship inside the app instead of loading from the site.
//
// Run: npm run build (or npm run check to build and check the result). Then npx cap sync.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SITE_SRC = join(here, "..", "site", "src"), SHELL = join(here, "shell"), OUT = join(here, "www");
const SITE = "https://okenight.com";

const read = (p) => readFileSync(p, "utf8");
// A script's text, safe inside <script>...</script>.
const inlineJs = (code) => code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
copyFileSync(join(SHELL, "index.html"), join(OUT, "index.html"));
copyFileSync(join(SHELL, "remind.js"), join(OUT, "remind.js"));
copyFileSync(join(SITE_SRC, "pwa", "mark-96.png"), join(OUT, "mark-96.png")); // logo on the first screen

// Firebase (push): the config files from the Firebase console, kept out of git. Put them in app/firebase/, or
// pass them base64-encoded in FIREBASE_IOS_PLIST_B64 / FIREBASE_ANDROID_JSON_B64 (GitHub Actions secrets).
// The iPhone one rides in www/ and a build step copies it next to the app (ios/App/App.xcodeproj, "Firebase config").
// Without them the app builds and runs normally, just without push.
const FB = join(here, "firebase");
const fbFile = (name, envName) => {
  if (process.env[envName]) return Buffer.from(process.env[envName], "base64");
  return existsSync(join(FB, name)) ? readFileSync(join(FB, name)) : null;
};
const iosPlist = fbFile("GoogleService-Info.plist", "FIREBASE_IOS_PLIST_B64");
const androidJson = fbFile("google-services.json", "FIREBASE_ANDROID_JSON_B64");
if (iosPlist) writeFileSync(join(OUT, "GoogleService-Info.plist"), iosPlist);
if (androidJson) writeFileSync(join(here, "android", "app", "google-services.json"), androidJson);
console.log("Firebase push config: iPhone " + (iosPlist ? "yes" : "no") + ", Android " + (androidJson ? "yes" : "no"));

let page = read(join(SITE_SRC, "index.html"));

// 1. App head: venue, app mode and the <base>, first thing in <head> so every URL after it uses the site.
const HEAD = `<script>
// Oke Night app: this page lives inside the app; the bar comes from the app's first screen (www/index.html).
(function () {
  var v = null; try { v = JSON.parse(localStorage.getItem("oke_app_venue") || "null"); } catch (e) {}
  if (!v || !/^\\/[a-z0-9-]+\\/$/.test(v.path || "")) { location.replace("index.html?pick=1"); v = { slug: "demo", name: "Demo Night", path: "/demo/" }; }
  window.OKE_APP = true; window.OKE_SITE = ${JSON.stringify(SITE)}; window.OKE_VENUE = v;
  window.OKE_APP_HOME = new URL("index.html", location.href).href;
  document.write('<base href="${SITE}' + v.path + '">');
})();
</script>`;
if (!page.includes("<head>")) throw new Error("site/src/index.html has no <head>");
page = page.replace("<head>", "<head>\n" + HEAD);

// 2. Drop web-only bits: the install manifest, home-screen icon and service worker (the app is installed).
page = page.replace(/<link rel="(manifest|apple-touch-icon)"[^>]*>\n?/g, "");
page = page.replace(/<script>\n?[^<]*serviceWorker\.register[^<]*<\/script>\n?/g, "");

// 3. Inline the site's own scripts.
page = page.replace(/<script src="\/([a-z_]+\.js)"><\/script>/g, (m, f) => {
  const p = join(SITE_SRC, f);
  if (!existsSync(p)) throw new Error("missing script " + f);
  return "<script>\n// " + f + " (inlined from site/src by app/build.mjs)\n" + inlineJs(read(p)) + "\n</script>";
});

// 4. App glue at the end: bar list + reminders, the logo and "Change" go back to the app's first screen,
//    and an offline note.
const TAIL = `<script>
${inlineJs(read(join(SHELL, "remind.js")))}
</script>
<script>
(function () {
  var home = window.OKE_APP_HOME;
  document.querySelectorAll('a.logo, a#where').forEach(function (a) { a.href = home + "?pick=1"; });
  if (window.OkeApp) window.OkeApp.refresh();
  var note = document.createElement("p");
  note.id = "app-offline"; note.hidden = true; note.setAttribute("role", "status");
  note.textContent = "You’re offline. Songs and reactions come back when you’re online.";
  note.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));margin:0;padding:10px 14px;border-radius:12px;background:#2d1b36;color:#f6ecf8;font-size:16px;z-index:50;text-align:center";
  document.body.appendChild(note);
  var sync = function () { note.hidden = navigator.onLine !== false; };
  window.addEventListener("online", sync); window.addEventListener("offline", sync); sync();
})();
</script>
</body>`;
page = page.replace(/<\/body>(?![\s\S]*<\/body>)/, TAIL);
writeFileSync(join(OUT, "venue.html"), page);

// Checks: every inline script parses and nothing still loads from the site root by mistake.
if (process.argv.includes("--check")) {
  let bad = 0;
  for (const f of ["index.html", "venue.html"]) {
    const h = read(join(OUT, f));
    let n = 0;
    for (const m of h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      n++;
      try { new vm.Script(m[1]); } catch (e) { console.error(f + " script " + n + ": " + e.message); bad++; }
    }
    const rooted = [...h.matchAll(/<script[^>]+src="\/[^"]*"/g)].map((m) => m[0]);
    if (rooted.length) { console.error(f + ": scripts still load from the site root: " + rooted.join(", ")); bad++; }
    console.log(f + ": " + n + " inline scripts");
  }
  if (bad) process.exit(1);
}
console.log("www/ built");
