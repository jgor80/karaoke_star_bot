// The "scrambled network code" used for rate limits (privacy.html): a daily hash of the visitor's network.
//
// - IP_SALT is a Worker secret (Settings > Variables and Secrets, type Secret). With it, nobody who reads this
//   public repo can turn a stored hash back into an IP address by trying every address. Without it, it
//   falls back to the old public prefix, so nothing breaks before the secret is set.
// - IPv6 phones get a whole /64 block from their carrier and can pick any address in it, so the hash uses
//   the first four groups (the network) instead of the full address.
export function networkOf(ip) {
  ip = String(ip || "").trim();
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [], b = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export async function networkHash(env, req, scope, day) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  if (!ip) return null;
  const salt = (env && env.IP_SALT) || "oke-night";
  const d = new TextEncoder().encode(salt + "|" + scope + "|" + networkOf(ip) + "|" + day);
  const h = await crypto.subtle.digest("SHA-256", d);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
