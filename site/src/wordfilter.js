// A small filter for names people type on their phones (reactions, draft picks, duet posts, requests),
// so slurs and obvious abuse never show on the site or the TV. App stores ask for one (Apple 1.2).
// It is deliberately short and blunt: whole words only, after folding case, accents and common
// look-alike characters ("4" -> a, "$" -> s), so ordinary names ("Dickens", "Scunthorpe") pass.
// The host can still remove anything that slips through, and anyone can report a name or photo.
const FOLD = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i", "|": "i" };
const WORDS = new Set([
  // slurs
  "nigger", "nigga", "niggas", "niggers", "faggot", "faggots", "fag", "fags", "dyke", "tranny", "retard", "retards",
  "spic", "spics", "chink", "chinks", "kike", "kikes", "wetback", "gook", "coon", "raghead", "towelhead",
  // sexual and abusive
  "cunt", "cunts", "whore", "whores", "slut", "sluts", "rape", "rapist", "pedo", "pedophile", "molester",
  "cum", "jizz", "dildo", "blowjob", "handjob", "anal", "porn", "pussy", "cock", "cocks", "tits", "twat",
  "fuck", "fucker", "fucking", "motherfucker", "shit", "bitch", "bitches", "asshole", "bastard", "nazi", "hitler", "kkk",
]);
// Run together with no spaces these are still unmistakable ("fuckyou", "dumbfaggot").
const INSIDE = ["nigger", "nigga", "faggot", "motherfucker", "fuck", "pedophile"]; // not "cunt" (Scunthorpe) or "rapist" (therapist)

const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[013457@$!|]/g, (c) => FOLD[c] || c);

export function objectionable(s) {
  const f = fold(s);
  const words = f.split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => WORDS.has(w) || WORDS.has(w.replace(/(.)\1+/g, "$1")))) return true;
  const joined = words.join("");
  return INSIDE.some((w) => joined.includes(w));
}
