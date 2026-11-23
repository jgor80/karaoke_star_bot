/* Karaoke fun layer: singer badges, nightly dares and the "watch" song.
 * Pure functions over plays rows {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s},
 * sorted by played_at. No dependencies. Exposed as window.KaraokeFun.
 */
(function (global) {
  const key = (s) => (s || "").trim().toLowerCase();
  // Songs from a film, musical, show or game. the karaoke app marks most as "Title Source (film)" / "(musical)",
  // and some as "Artist (Source)" or "Source (Artist)", e.g. "The Beach Boys (Cocktail)", "Toy Story (Randy Newman)".
  // A trailing "(band)" or "(live...)" is just a disambiguation, not a source.
  const SCREEN = /\b(film|musical|movie|soundtrack)\b|\((?!band\)|live\b)[^)]+\)\s*$/i;
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const SPLIT = /\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*/i;
  const isTable = (s) => /^table\s*\d+/i.test((s || "").trim());
  const isGroup = (s) => isTable(s) || SPLIT.test((s || "").trim());
  const decade = (y) => Math.floor(y / 10) * 10;
  const art = (re) => (p) => p.title && re.test(p.artist || "");
  // Hour and minute at the venue (Central time), whatever time zone the phone or TV is set to.
  const VENUE_TZ = (typeof window !== "undefined" && window.OKE_VENUE && window.OKE_VENUE.tz) || "America/Chicago"; // the bar's time zone (venues.js)
  let venueFmt = null;
  const venueHM = (ts) => {
    try {
      venueFmt = venueFmt || new Intl.DateTimeFormat("en-US", { timeZone: VENUE_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" });
      const parts = venueFmt.formatToParts(new Date(ts * 1000)), get = (t) => Number((parts.find((x) => x.type === t) || {}).value);
      return { h: get("hour") % 24, m: get("minute") };
    } catch (e) { const d = new Date(ts * 1000); return { h: d.getHours(), m: d.getMinutes() }; }
  };
  const lateNight = (p) => { const { h, m } = venueHM(p.played_at); return (h === 1 && m >= 30) || (h >= 2 && h < 6); };
  const PUNK = /misfits|green day|the clash|nofx|ramones|blink|sex pistols|^l7$|bad religion|dead kennedys|alkaline trio|front bottoms|ajj/i;
  const BRIT = /^oasis$|^pulp$|^blur$|^the verve$|^suede$|^radiohead$|^the smiths$/i;
  const HYPE_KEYS = ["fire", "micdrop", "encore", "chills", "dance", "keychange"]; // same as OkeAwards.HYPE
  const hypeOf = (c) => HYPE_KEYS.reduce((a, k) => a + (c[k] || 0), 0);
  // ---------- weekly streaks ----------
  // A karaoke week runs Monday to Sunday, so a Saturday party and the Sunday after it are the same week.
  // Streaks count weeks that had karaoke at all, so a week the bar skips doesn't break anyone's streak.
  // Today's date at the bar (YYYY-MM-DD), in its time zone, rolling over at 6 AM so a late night stays one night.
  const barDay = () => { try { return new Date(Date.now() - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: (global.OKE_VENUE && global.OKE_VENUE.tz) || "America/Chicago" }); } catch (e) { return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); } };
  const weekOf = (night) => { const t = Date.parse(night + "T12:00:00Z") / 86400000; return Math.floor((t + 3) / 7); }; // Mon-start week number
  // Consecutive karaoke weeks ending at week w, counting only weeks in mine (a Set of week numbers).
  function runEndingAt(w, mine, weeks) {
    let i = weeks.indexOf(w), n = 0;
    while (i >= 0 && mine.has(weeks[i])) { n++; i--; }
    return n;
  }
  // ---------- genres ----------
  // Artist names (lowercase, leading "the " dropped) per genre. An artist can sit in more than one.
  // Matched against each part of the artist field: "Lady Gaga & Bruno Mars", "Paramore (The Twilight Saga)",
  // "Toy Story (Randy Newman)" are split on & , / feat. and parentheses.
  const G = (s) => new Set(s.split("|").map((x) => clean(x.replace(/\bthe\b/g, " "))));
  const GENRES = [
    { id: "g-country", name: "Honky Tonker", genre: "country", icon: "🤠", artists: G("dolly parton|shania twain|garth brooks|chicks|dixie chicks|carrie underwood|alan jackson|brooks & dunn|zach bryan|kacey musgraves|midland|little big town|lady a|lady antebellum|brad paisley|charlie daniels band|johnny cash|willie nelson|reba mcentire|tim mcgraw|faith hill|keith urban|blake shelton|miranda lambert|kenny rogers|patsy cline|loretta lynn|george strait|luke combs|morgan wallen|chris stapleton|tyler childers|sturgill simpson|lainey wilson|toby keith|trisha yearwood|martina mcbride|billy ray cyrus|sugarland|rascal flatts|florida georgia line|kenny chesney|jason aldean|luke bryan|linda ronstadt|john denver|glen campbell|hank williams|randy newman|dwight yoakam|travis tritt|big & rich|gretchen wilson|orville peck|beyoncé") },
    { id: "g-metal", name: "Headbanger", genre: "metal", icon: "🤘", artists: G("slipknot|lamb of god|killswitch engage|system of a down|tool|ghost|ghost (band)|rob zombie|marilyn manson|ministry|metallica|iron maiden|black sabbath|ozzy osbourne|megadeth|pantera|slayer|korn|disturbed|avenged sevenfold|judas priest|dio|motörhead|faith no more|white zombie|type o negative|deftones|rammstein|nine inch nails|mastodon|gojira|bring me the horizon|five finger death punch|godsmack|static-x|drowning pool|linkin park|evanescence|breaking benjamin|papa roach|limp bizkit|in this moment|spiritbox|sleep token|my life with thrill kill kult") },
    { id: "g-grunge", name: "Flannel Season", genre: "grunge", icon: "🎸", artists: G("nirvana|soundgarden|pearl jam|alice in chains|stone temple pilots|mad season|bush|audioslave|toadies|urge overkill|hole|silverchair|smashing pumpkins|candlebox|temple of dog|screaming trees|foo fighters|mudhoney|l7|veruca salt|live|collective soul|sponge|seven mary three|chris cornell") },
    { id: "g-emo", name: "Emo Phase", genre: "emo & pop punk", icon: "🖤", artists: G("paramore|panic! at disco|blink-182|sum 41|alkaline trio|front bottoms|cursive|my chemical romance|fall out boy|jimmy eat world|taking back sunday|dashboard confessional|brand new|yellowcard|new found glory|simple plan|good charlotte|used|all time low|avril lavigne|plain white t's|ajj|green day|bowling for soup|motion city soundtrack|saves day|thursday|hawthorne heights|mayday parade|pierce veil|sleeping with sirens|twenty one pilots|weezer|the starting line|something corporate|jack's mannequin|state champs|neck deep|modern baseball|mom jeans|tigers jaw|joyce manor|american football|manchester orchestra|bright eyes|mindless self indulgence") },
    { id: "g-hiphop", name: "Bars", genre: "hip-hop & rap", icon: "🎧", artists: G("sir mix-a-lot|salt-n-pepa|outkast|big boi|andré 3000|50 cent|dr. dre|eminem|drake|lil wayne|tyler, creator|black eyed peas|beastie boys|run-dmc|notorious b.i.g.|2pac|tupac|snoop dogg|kanye west|jay-z|missy elliott|lizzo|nelly|coolio|house of pain|kendrick lamar|nicki minaj|cardi b|megan thee stallion|wu-tang clan|cypress hill|vanilla ice|mc hammer|ludacris|death grips|ice cube|n.w.a|naughty by nature|tone loc|young mc|digital underground|kris kross|bone thugs-n-harmony|ja rule|t-pain|flo rida|pitbull|macklemore|post malone|doja cat|lil nas x|childish gambino|busta rhymes|queen latifah|fugees|lauryn hill|a tribe called quest|de la soul|biz markie|dmx|ying yang twins|lil jon|petey pablo|chamillionaire|mims|sean paul|shaggy|kid cudi|travis scott") },
    { id: "g-diva", name: "Pop Royalty", genre: "pop divas", icon: "👑", artists: G("lady gaga|britney spears|madonna|beyoncé|beyonce|chappell roan|olivia rodrigo|taylor swift|miley cyrus|kelly clarkson|tove lo|natasha bedingfield|lily allen|cher|whitney houston|mariah carey|celine dion|céline dion|christina aguilera|katy perry|ariana grande|dua lipa|rihanna|adele|kylie minogue|sabrina carpenter|billie eilish|charli xcx|p!nk|pink|janet jackson|cyndi lauper|shakira|bette midler|gwen stefani|fergie|kesha|carly rae jepsen|demi lovato|selena gomez|hilary duff|jessica simpson|mandy moore|spice girls|destiny's child|tlc|alanis morissette|lorde|lana del rey|sza|doja cat|meghan trainor|ava max|bebe rexha|alexandra burke|olivia dean|sienna spiro|ashe|aurora|kate bush|tina turner|donna summer|gloria gaynor|diana ross|dolly parton|shania twain|amy winehouse|hikaru utada") },
    { id: "g-classic", name: "Classic Rock Radio", genre: "classic rock", icon: "📻", artists: G("queen|fleetwood mac|beatles|who|journey|bon jovi|guns n' roses|def leppard|styx|rush|toto|eagles|tom petty|tom petty and heartbreakers|steve miller band|reo speedwagon|whitesnake|jethro tull|blue öyster cult|creedence clearwater revival|buffalo springfield|pat benatar|eddie money|led zeppelin|rolling stones|aerosmith|ac/dc|kiss|boston|heart|foreigner|lynyrd skynyrd|doors|pink floyd|van halen|bruce springsteen|elton john|billy joel|bonnie tyler|meat loaf|warren zevon|jackson browne|david bowie|kinks|cream|jimi hendrix|janis joplin|santana|zz top|cheap trick|scorpions|poison|mötley crüe|twisted sister|survivor|kansas|bad company|thin lizzy|deep purple|the cars|the police|dire straits|john mellencamp|bob seger|joe walker|joan jett|joan jett & blackhearts|blondie|the pretenders|bryan adams|loverboy|night ranger|europe|asia|yes|genesis|phil collins|peter gabriel|electric light orchestra|supertramp|steely dan|chicago|doobie brothers|jefferson airplane|grateful dead|neil young|crosby, stills & nash|harry nilsson|looking glass|donovan|searchers|beach boys") },
    { id: "g-synth", name: "New Wave Kid", genre: "new wave & synth", icon: "🕺", artists: G("depeche mode|tears for fears|when in rome|real life|corey hart|rockwell|cure|duran duran|a-ha|new order|pet shop boys|eurythmics|human league|soft cell|simple minds|men without hats|talk talk|ultravox|yazoo|erasure|joy division|smiths|morrissey|my life with thrill kill kult|thompson twins|spandau ballet|psychedelic furs|echo & bunnymen|oingo boingo|b-52's|devo|flock of seagulls|naked eyes|wang chung|frankie goes to hollywood|culture club|boy george|dead or alive|alphaville|kajagoogoo|bananarama|cyndi lauper|q lazzarus|waterboys|george michael|wham!|madonna|kate bush|tiffany|belinda carlisle|go-go's") },
    { id: "g-soul", name: "Soul Train", genre: "soul, R&B & oldies", icon: "🎷", artists: G("otis redding|nina simone|bill withers|flamingos|elvis presley|chuck berry|bobby darin|amy winehouse|aretha franklin|marvin gaye|stevie wonder|al green|sam cooke|etta james|ray charles|temptations|supremes|jackson 5|michael jackson|ginuwine|carl thomas|tlc|boyz ii men|usher|destiny's child|en vogue|bruno mars|whitney houston|prince|james brown|smokey robinson|four tops|righteous brothers|ben e. king|drifters|platters|ronettes|shirelles|little richard|buddy holly|ritchie valens|roy orbison|everly brothers|frankie valli|four seasons|dion|bobby boris pickett|sonny & cher|norah jones|alicia keys|john legend|leon bridges|anderson .paak|silk sonic|lauryn hill|erykah badu|d'angelo|maxwell|r. kelly|brian mcknight|joe|jodeci|blackstreet|112|k-ci & jojo|aaliyah|brandy|monica|mary j. blige|ashanti|ciara|beyoncé") },
    { id: "g-ska", name: "Skank Walker", genre: "ska & reggae", icon: "🎺", artists: G("mighty mighty bosstones|specials|sublime|no doubt|reel big fish|less than jake|streetlight manifesto|madness|bob marley|bob marley & wailers|los fabulosos cadillacs|operation ivy|save ferris|interrupters|ub40|toots & maytals|english beat|selecter|goldfinger|aquabats|slightly stoopid|311|dirty heads|rebelution|shaggy|sean paul|inner circle|lady saw|desmond dekker|jimmy cliff|catch 22|big d and kids table|voodoo glow skulls") },
    { id: "g-dance", name: "Dance Floor Filler", genre: "disco & dance", icon: "🪩", artists: G("technotronic|dj casper|emf|abba|trammps|lou bega|bee gees|donna summer|gloria gaynor|kc and sunshine band|village people|chic|cascada|darude|vengaboys|aqua|haddaway|la bouche|real mccoy|c+c music factory|snap!|corona|ace of base|2 unlimited|eiffel 65|daft punk|calvin harris|david guetta|avicii|lmfao|black eyed peas|deee-lite|crystal waters|robin s|cher|kylie minogue|sister sledge|earth, wind & fire|kool & gang|boney m.|baha men|los del río|whigfield|scatman john|alice deejay|rednex|sash!") },
    { id: "g-latin", name: "Viva", genre: "Latin & en español", icon: "💃", artists: G("vicente fernández|los fabulosos cadillacs|selena|shakira|ricky martin|bad bunny|luis miguel|juan gabriel|maná|enrique iglesias|gloria estefan|marc anthony|daddy yankee|j balvin|karol g|los tigres del norte|los ángeles azules|caifanes|café tacvba|soda stereo|héroes del silencio|aventura|romeo santos|pitbull|jennifer lopez|celia cruz|carlos santana|santana|ritchie valens|los lobos|selena quintanilla|thalía|paulina rubio|julieta venegas|natalia lafourcade|peso pluma|grupo frontera|rosalía|los bukis|alejandro fernández|chayanne|luis fonsi|el gran combo|juanes|jesse & joy|camila cabello|becky g|ozuna|maluma") },
    { id: "g-radio", name: "'90s Alt Radio", genre: "'90s & '00s radio rock", icon: "📟", artists: G("eve 6|fastball|matchbox twenty|edwin mccain|sixpence none richer|better than ezra|4 non blondes|chumbawamba|cardigans|creed|3 doors down|nickelback|puddle of mudd|sr-71|hoobastank|sheryl crow|jewel|michelle branch|fray|goo goo dolls|third eye blind|semisonic|vertical horizon|lit|marcy playground|harvey danger|new radicals|smash mouth|sugar ray|barenaked ladies|counting crows|hootie & blowfish|toad wet sprocket|gin blossoms|dishwalla|deep blue something|spin doctors|blind melon|natalie imbruglia|meredith brooks|alanis morissette|everclear|lifehouse|train|vanessa carlton|natasha bedingfield|kelly clarkson|daughtry|switchfoot|staind|seether|default|theory of a deadman|three days grace|shinedown|evanescence|killers|kings of leon|neon trees|maroon 5|jonas brothers|plain white t's|panic! at disco|fountains of wayne|wheatus|bloodhound gang|len|dido|savage garden|stone temple pilots|bush|nine days|tonic|sister hazel|matchbox 20|our lady peace|tal bachman|john farnham|corey hart|michelle branch") },
    { id: "g-weird", name: "Freak Flag", genre: "weird & wonderful", icon: "🦄", artists: G("ween|they might be giants|primus|cake|beck|pixies|violent femmes|wesley willis|mindless self indulgence|bloodhound gang|geese|viagra boys|death grips|tenacious d|weird al yankovic|\"weird al\" yankovic|flight of conchords|lonely island|devo|b-52's|oingo boingo|sparks|talking heads|butthole surfers|dead milkmen|frank zappa|captain beefheart|tiny tim|crash test dummies|presidents of united states of america|rednex|lou bega|gorillaz|aqua|ministry|my life with thrill kill kult|bobby boris pickett|wesley willis fiasco|ajj|cursive") },
    { id: "g-indie", name: "Indie Darling", genre: "indie", icon: "📼", artists: G("ben folds five|ben folds|portishead|postal service|rilo kiley|yeah yeah yeahs|killers|kings of leon|neon trees|nothing but thieves|strokes|arctic monkeys|vampire weekend|modest mouse|death cab for cutie|shins|arcade fire|mgmt|phoenix|cage elephant|white stripes|black keys|interpol|franz ferdinand|bloc party|lcd soundsystem|tame impala|the national|bon iver|fleet foxes|mumford & sons|lumineers|of monsters and men|florence + machine|metric|beach house|mitski|phoebe bridgers|boygenius|japanese breakfast|snail mail|soccer mommy|big thief|wet leg|fontaines d.c.|idles|geese|rex orange county|noah kahan|fiona apple|aurora|pulp|radiohead|blur|oasis|verve|suede|smiths|front bottoms|cursive|neutral milk hotel|pavement|built to spill|sonic youth|pixies|breeders|belle and sebastian|magnetic fields|decemberists|walkmen|cults|young folks|passion pit|foster people|two door cinema club|the 1975|hozier|lorde|fiona apple|chappell roan") },
  ];
  const nameKey = (s) => clean(clean(s).toLowerCase().replace(/\bthe\b/g, " "));
  const artistParts = (a) => (a || "").split(/\s*(?:\(|\)|,|&|\/|\bfeat\.?|\bft\.?|\bx\b|\bwith\b)\s*/i).map(nameKey).filter(Boolean);
  // Some names in the lists are joined with "&" (brooks & dunn); match the whole field too.
  const genreCache = new Map();
  function genresOf(artist) {
    const k = (artist || "").toLowerCase(); if (genreCache.has(k)) return genreCache.get(k);
    const whole = nameKey(artist), parts = artistParts(artist).concat(whole, whole.replace(/\s*\([^)]*\)\s*$/, ""));
    const out = GENRES.filter((g) => parts.some((x) => g.artists.has(x))).map((g) => g.id);
    genreCache.set(k, out); return out;
  }
  const inGenre = (id) => (p) => p.title && genresOf(p.artist).includes(id);

  // Favorite bands: artists credited by part ("Lady Gaga & Bruno Mars" counts for both), screen sources skipped.
  // -> [{name, n, last}] most-sung first, ties to the most recent.
  function favoriteBands(rows, limit) {
    const by = new Map();
    rows.forEach((p) => {
      if (!p.artist || !p.title) return;
      const a = p.artist.trim();
      let names = [a.replace(/\s*\((?:band|live[^)]*)\)\s*$/i, "")];
      const m = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(names[0]);
      if (m) {
        // "Artist (Source)" or "Source (Artist)": drop the side that names a film/musical, else keep the side we know as an artist.
        const film = (x) => /\b(film|musical|movie|soundtrack|saga)\b/i.test(x);
        const inner = m[2], outer = m[1].replace(/\s*\([^)]*\)\s*$/, "");
        names = film(inner) ? [] : film(m[1]) ? [inner] : genresOf(inner).length && !genresOf(outer).length ? [inner] : [outer];
      }
      names.flatMap((n) => n.split(/\s*(?:&|,|\bfeat\.?|\bft\.?)\s*/i)).map(clean).filter(Boolean).forEach((n) => {
        const k = nameKey(n); const e = by.get(k) || { name: n, n: 0, last: 0 }; e.n++; e.last = Math.max(e.last, p.played_at); by.set(k, e);
      });
    });
    return [...by.values()].sort((x, y) => y.n - x.n || y.last - x.last).slice(0, limit || 3);
  }

  const COLOR = /\b(red|blue|black|white|green|pink|gold|golden|purple|yellow|silver|orange)\b/i;

  // ---------- badges ----------
  // Every badge but Debut keeps leveling up, so a weekly regular still has something to chase after a year or more.
  // A ladder lists the count needed for levels 1, 2, 3...; past its end each new level needs `step` more, forever.
  // Levels 1-5 are Bronze, Silver, Gold, Platinum, Diamond; 6 is Legend, then Legend 2, Legend 3...
  // Tuned for one karaoke night a week: Silver in a couple of months, Diamond around 9 months, Legend at about a year.
  // The two "collect them all" badges (decades, genres) top out at Legend once you've sung nearly all of them.
  const TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
  const tierName = (lv) => (lv <= 0 ? "" : lv <= 5 ? TIERS[lv - 1] : "Legend" + (lv > 6 ? " " + (lv - 5) : ""));
  const LADDERS = {
    once:    { at: [1], step: 0 },
    nights:  { at: [3, 8, 16, 26, 40, 52], step: 13 },    // nights sung: Legend after a year of Sundays, then one level a quarter
    streak:  { at: [3, 6, 10, 16, 26, 52], step: 13 },    // weeks in a row
    songs:   { at: [10, 25, 50, 80, 120, 160], step: 40 },
    rare:    { at: [1, 3, 6, 10, 15, 25], step: 10 },     // things that happen now and then (an oldie, a 6-minute song, opening the night)
    often:   { at: [1, 5, 10, 20, 35, 50], step: 15 },    // duets
    genre:   { at: [2, 5, 10, 18, 28, 40], step: 12 },
    artist:  { at: [3, 5, 8, 12, 18, 25], step: 8 },
    repeat:  { at: [2, 3, 5, 8, 12, 18], step: 6 },       // the same song on N nights
    decades: { at: [4, 5, 6, 7, 8, 9], step: 0 },
    genres:  { at: [5, 7, 9, 11, 13, 15], step: 0 },
  };
  const needFor = (ld, lv) => (lv <= ld.at.length ? ld.at[lv - 1] : ld.step ? ld.at[ld.at.length - 1] + (lv - ld.at.length) * ld.step : Infinity);
  const levelOf = (ld, v) => { let lv = 0; while (v >= needFor(ld, lv + 1)) lv++; return lv; };
  // Trackers: made fresh for each person, then called after each of their songs (rows r, index i) with the
  // running value so far. count(hit) counts songs where hit() is true; distinct(f) counts different values of f.
  const count = (hit) => () => { let n = 0; return (r, i, ctx) => (n += hit(r, i, ctx) ? 1 : 0); };
  const distinct = (f) => () => { const s = new Set(); return (r, i, ctx) => { f(r[i], ctx).forEach((x) => s.add(x)); return s.size; }; };
  // The biggest group: songs grouped by group(p), sized by how many different size(p) values (or songs) each has.
  const biggest = (group, size) => () => { const m = new Map(); let best = 0; return (r, i) => { const g = group(r[i]); if (!g) return best;
    const s = m.get(g) || new Set(); s.add(size ? size(r[i]) : i); m.set(g, s); return (best = Math.max(best, s.size)); }; };
  // desc: [line for 1, line for n with {n}] or a single line with {n}
  const B = (id, name, ld, unit, desc, track, extra) => ({ id, name, ld: LADDERS[ld], unit, desc, track, ...(extra || {}) });
  const BADGES = [
    B("debut", "Debut", "once", "songs", ["Sang a first song here"], count(() => true)),
    B("songs", "Setlist", "songs", "songs", ["{n} songs sung here"], count(() => true)),
    B("regular", "Regular", "nights", "nights", ["Sang on {n} different nights"], distinct((p) => [p.night])),
    B("streak3", "Hot Streak", "streak", "weeks in a row", ["Sang {n} karaoke weeks in a row"], () => { const mine = new Set(); let best = 0;
      return (r, i, ctx) => { const w = weekOf(r[i].night); mine.add(w); return (best = Math.max(best, runEndingAt(w, mine, ctx.weeks))); }; }),
    B("hattrick", "Hat Trick", "rare", "nights with 3+ songs", ["3 songs in one night", "3+ songs on {n} different nights"], count((r, i) => {
      let n = 0; for (let j = i; j >= 0 && r[j].night === r[i].night; j--) n++; return n === 3; })),
    B("hopper", "Decade Hopper", "decades", "decades", ["Songs from {n} different decades"], distinct((p) => (p.release_year ? [decade(p.release_year)] : []))),
    B("oldie", "Golden Oldie", "rare", "songs from before 1970", ["Sang a song from before 1970", "{n} songs from before 1970"], count((r, i) => r[i].release_year && r[i].release_year < 1970)),
    B("fresh", "Fresh Ears", "rare", "brand-new songs", ["Sang a song less than 2 years old", "{n} songs less than 2 years old"], count((r, i) => r[i].release_year && Number(r[i].night.slice(0, 4)) - r[i].release_year <= 1)),
    B("marathon", "Marathoner", "rare", "songs over 6 minutes", ["Finished a song over 6 minutes", "Finished {n} songs over 6 minutes"], count((r, i) => r[i].length_s > 360)),
    B("sprint", "Sprinter", "rare", "songs under 2 minutes", ["Sang a song under 2 minutes", "{n} songs under 2 minutes"], count((r, i) => r[i].length_s && r[i].length_s < 120)),
    B("duet", "Duet Partner", "often", "duets", ["Shared the mic with someone", "Shared the mic {n} times"], count((r, i) => isGroup(r[i].singer))),
    // Brought someone new up: a group song that was someone else's first song here (and not yours).
    B("plusone", "Plus One", "rare", "first-timers brought up", ["Got a first-timer up on the mic with you", "Got {n} first-timers up on the mic with you"], count((r, i, ctx) => i > 0 && isGroup(r[i].singer) && ctx.debutRows.has(r[i]))),
    B("broken", "Broken Record", "rare", "repeats", ["Same song twice in one night", "Same song twice in a night, {n} times"], count((r, i) => { if (!r[i].title) return false;
      for (let j = i - 1; j >= 0 && r[j].night === r[i].night; j--) if (key(r[j].title) === key(r[i].title)) return true; return false; })),
    B("signature", "Signature Song", "repeat", "nights for one song", ["Same song on {n} different nights"], biggest((p) => p.title && key(p.title), (p) => p.night)),
    B("loyal", "Superfan", "artist", "songs by one artist", ["Same artist {n} times"], biggest((p) => p.artist && key(p.artist))),
    B("brit", "Britpop Lifer", "genre", "Britpop songs", ["{n} Britpop songs (Oasis, Pulp, Blur…)"], count((r, i) => art(BRIT)(r[i]))),
    B("punk", "Punk Points", "genre", "punk songs", ["{n} punk songs"], count((r, i) => art(PUNK)(r[i]))),
    // Genre badges: songs in the genre. Genre Hopper: songs from different genres.
    ...GENRES.map((g) => B(g.id, g.name, "genre", g.genre + " songs", ["{n} " + g.genre + " songs"], count((r, i) => inGenre(g.id)(r[i])), { genre: true })),
    B("g-hopper", "Genre Hopper", "genres", "genres", ["Songs from {n} different genres"], distinct((p) => (p.title ? genresOf(p.artist) : []))),
    B("owl", "Night Owl", "rare", "songs after 1:30am", ["Sang after 1:30am", "Sang after 1:30am {n} times"], count((r, i) => lateNight(r[i]))),
    B("opener", "Opening Act", "rare", "nights opened", ["Sang the first song of a night", "Opened {n} nights"], count((r, i, ctx) => ctx.firstOf.get(r[i].night) === r[i])),
    B("closer", "Closer", "rare", "nights closed", ["Sang the last song of a night", "Closed {n} nights"], count((r, i, ctx) => ctx.lastOf.get(r[i].night) === r[i] && r[i].night !== ctx.liveNight)),
    // Crowd reactions (live emoji taps on the phone site). ctx.rx(row) -> {reaction: count} for that song.
    B("b-crowd", "Crowd Pleaser", "rare", "songs", ["10 hype reactions on one song", "10+ hype reactions on {n} songs"], count((r, i, ctx) => hypeOf(ctx.rx(r[i])) >= 10)),
    B("b-drop", "Mic Dropper", "rare", "songs", ["3 mic drops on one song", "3+ mic drops on {n} songs"], count((r, i, ctx) => (ctx.rx(r[i]).micdrop || 0) >= 3)),
    B("b-encore", "Encore Earned", "rare", "songs", ["3 encore calls on one song", "3+ encore calls on {n} songs"], count((r, i, ctx) => (ctx.rx(r[i]).encore || 0) >= 3)),
    B("b-tomato", "Tomato Survivor", "rare", "songs", ["Took 3 tomatoes on one song", "Took 3+ tomatoes on {n} songs"], count((r, i, ctx) => (ctx.rx(r[i]).tomato || 0) >= 3)),
    B("trend", "Trendsetter", "often", "songs others picked up", ["Sang a song someone else picked up later", "{n} songs someone else picked up later"], count((r, i, ctx) => r[i].title && ctx.byTitle.get(key(r[i].title)).some((p) => p.played_at > r[i].played_at && key(p.singer) !== key(r[i].singer)))),
  ];
  const BADGE_BY = new Map(BADGES.map((b) => [b.id, b]));
  // The rule for reaching a badge's level, e.g. "Sang on 16 different nights".
  function descAt(b, lv) {
    const n = needFor(b.ld, Math.max(1, lv)), d = b.desc;
    return (n === 1 || d.length === 1 ? d[0] : d[1]).replace("{n}", String(n));
  }
  const labelOf = (b, lv) => (b.ld === LADDERS.once ? b.name : b.name + " · " + tierName(lv));

  // People: solo singer names, plus each part of a duet or group name ("Val and bleacher jeff" -> val, bleacher jeff).
  // Someone who only ever sings in duets still gets leaderboard credit and badges. Parts are only split on
  // clear separators (& , / + "and"), not "n", so a name like "Rock n Roll Rob" stays one person.
  const DUET_SPLIT = /\s*(?:,|&|\/|\band\b|\+)\s*/i;
  function people(plays) {
    const solo = new Map();
    plays.forEach((p) => { const k = key(p.singer); if (k && !isGroup(p.singer)) { if (!solo.has(k)) solo.set(k, { key: k, name: clean(p.singer), rows: [] }); } });
    const add = (k, p, name) => {
      let e = solo.get(k);
      if (!e && name && k.length >= 2) solo.set(k, (e = { key: k, name, rows: [] }));
      if (e && e.rows[e.rows.length - 1] !== p) e.rows.push(p);
    };
    plays.forEach((p) => {
      const k = key(p.singer); if (!k) return;
      if (!isGroup(p.singer)) { add(k, p); return; }
      if (isTable(p.singer)) return;
      // Parts already known as solo singers (any separator), then duet-only people (clear separators only).
      k.split(SPLIT).map((x) => x.trim()).filter(Boolean).forEach((part) => add(part, p));
      clean(p.singer).split(DUET_SPLIT).map((x) => x.trim()).filter(Boolean).forEach((name) => add(key(name), p, name));
    });
    return solo;
  }

  // reax: Map(play uuid -> {reaction: count}) from OkeAwards.reactionIndex(...).bySong (optional)
  function context(plays, liveNight, reax) {
    const firstOf = new Map(), lastOf = new Map(), byTitle = new Map();
    plays.forEach((p) => { if (!firstOf.has(p.night)) firstOf.set(p.night, p); lastOf.set(p.night, p);
      if (p.title) { const k = key(p.title); (byTitle.get(k) || byTitle.set(k, []).get(k)).push(p); } });
    const none = {};
    const weeks = [...new Set(plays.map((p) => weekOf(p.night)))].sort((a, b) => a - b);
    const runAt = (r, i) => runEndingAt(weekOf(r[i].night), new Set(r.slice(0, i + 1).map((p) => weekOf(p.night))), weeks);
    const debutRows = new Set(); people(plays).forEach((e) => { if (e.rows[0]) debutRows.add(e.rows[0]); }); // someone's first song here
    return { firstOf, lastOf, byTitle, liveNight, weeks, runAt, debutRows, rx: (p) => (reax && p.uuid && reax.get(p.uuid)) || none };
  }

  // One earned badge at level lv: {id, name, label ("Regular · Gold"), tier, level, desc, at (row it was first earned),
  // lvAt (row it reached this level), value (count so far), next (count for the next level, null if it tops out), ups}
  function badgeAt(b, t, lv) {
    const next = needFor(b.ld, lv + 1);
    return { id: b.id, name: b.name, label: labelOf(b, lv), tier: b.ld === LADDERS.once ? "" : tierName(lv), level: lv, desc: descAt(b, lv), unit: b.unit,
      at: t.ups[0], lvAt: t.ups[lv - 1], value: t.value, next: isFinite(next) ? next : null, ups: t.ups };
  }
  // -> Map(personKey -> {name, rows, badges: [earned badge, see badgeAt], track: Map(id -> {value, level, ups})})
  function badgesAll(plays, liveNight, reax) {
    const ctx = context(plays, liveNight, reax);
    const ppl = people(plays);
    ppl.forEach((e) => {
      e.badges = []; e.track = new Map();
      BADGES.forEach((b) => {
        const step = b.track(), t = { value: 0, level: 0, ups: [] }; // ups[k] = the row that reached level k + 1
        for (let i = 0; i < e.rows.length; i++) {
          t.value = Math.max(t.value, step(e.rows, i, ctx));
          while (t.value >= needFor(b.ld, t.level + 1)) { t.level++; t.ups.push(e.rows[i]); }
        }
        e.track.set(b.id, t);
        if (t.level) e.badges.push(badgeAt(b, t, t.level));
      });
    });
    return ppl;
  }
  // Total badge levels (Debut left out): the collector score.
  const levelsOf = (e) => (e.badges || []).reduce((a, b) => a + (b.id === "debut" ? 0 : b.level), 0);

  // Badges earned or leveled up on `night`, at the highest level reached that night (Debut left out: everyone gets it).
  // badge.up is true for a level-up of a badge they already had.
  function unlockedOn(ppl, night) {
    const out = [];
    ppl.forEach((e) => e.badges.forEach((b) => { if (b.id === "debut") return;
      let lv = 0; b.ups.forEach((row, k) => { if (row.night === night) lv = k + 1; });
      if (!lv) return;
      const x = badgeAt(BADGE_BY.get(b.id), e.track.get(b.id), lv);
      x.up = b.ups[0].night !== night; x.lvAt = b.ups[lv - 1];
      out.push({ who: e.name, badge: x }); }));
    return out.sort((a, b) => b.badge.lvAt.played_at - a.badge.lvAt.played_at);
  }

  // ---------- dares ----------
  // Each night gets 3 dares picked from the pool by the night's date. First song that meets one claims it.
  const DARES = [
    { id: "oldie", text: "Sing a song from before 1970", test: (p) => p.release_year && p.release_year < 1970 },
    { id: "fresh", text: "Sing something from this year or last", test: (p) => p.release_year && Number(p.night.slice(0, 4)) - p.release_year <= 1 },
    { id: "duet", text: "Grab a partner for a duet", test: (p) => isGroup(p.singer) },
    { id: "newartist", text: "Sing an artist nobody has sung here before", test: (p, ctx) => p.artist && !ctx.pastArtists.has(key(p.artist)) },
    { id: "long", text: "Go the distance: a song over 6 minutes", test: (p) => p.length_s > 360 },
    { id: "screen", text: "Sing a song from a movie or musical", test: (p) => SCREEN.test(p.artist || "") },
    { id: "return", text: "Bring back a song from a past night", test: (p, ctx) => p.title && ctx.pastTitles.has(key(p.title)) },
    { id: "color", text: "Sing a song with a color in the title", test: (p) => COLOR.test(p.title || "") },
    { id: "number", text: "Sing a song with a number in the title", test: (p) => /\d/.test(p.title || "") },
    { id: "short", text: "Speed round: a song under 2½ minutes", test: (p) => p.length_s && p.length_s < 150 },
    { id: "seventies", text: "Take us back to the '70s", test: (p) => p.release_year >= 1970 && p.release_year < 1980 },
    { id: "punk", text: "Start a mosh pit: sing a punk song", test: art(PUNK) },
    { id: "country", text: "Country night: Dolly, Shania, Garth, the Chicks…", test: art(/dolly parton|shania|garth brooks|the chicks|carrie underwood|alan jackson|brooks & dunn|zach bryan|midland/i) },
    { id: "firsttimer", text: "A first-timer takes the mic after 11pm", test: (p, ctx) => !ctx.pastSingers.has(key(p.singer)) && key(p.singer) && (venueHM(p.played_at).h >= 23 || venueHM(p.played_at).h < 6) },
    { id: "table", text: "Get your whole table up there", test: (p) => isTable(p.singer) || (p.singer || "").split(SPLIT).filter(Boolean).length >= 3 },
  ];
  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function daresFor(night) {
    const pool = DARES.slice(); let h = hash("dares:" + night); const out = [];
    while (out.length < 3 && pool.length) { out.push(pool.splice(h % pool.length, 1)[0]); h = hash(String(h)); }
    return out;
  }
  // -> [{id, text, claimedBy: row|null}]
  function daresStatus(plays, night) {
    const past = plays.filter((p) => p.night < night), rows = plays.filter((p) => p.night === night);
    const ctx = { pastArtists: new Set(past.map((p) => key(p.artist)).filter(Boolean)), pastTitles: new Set(past.map((p) => key(p.title)).filter(Boolean)), pastSingers: new Set(past.map((p) => key(p.singer)).filter(Boolean)) };
    return daresFor(night).map((d) => ({ id: d.id, text: d.text, claimedBy: rows.find((p) => key(p.singer) && d.test(p, ctx)) || null }));
  }

  // ---------- the watch ----------
  // The song sung on the most different nights: "will it happen tonight?"
  function watchSong(plays, night) {
    const by = new Map();
    plays.forEach((p) => { if (!p.title) return; const k = key(p.title); const e = by.get(k) || { title: p.title, artist: p.artist, nights: new Set(), rows: [] }; e.nights.add(p.night); e.rows.push(p); by.set(k, e); });
    const w = [...by.values()].filter((e) => e.nights.size >= 2).sort((a, b) => b.nights.size - a.nights.size || b.rows.length - a.rows.length)[0];
    if (!w) return null;
    const allNights = new Set(plays.map((p) => p.night));
    const tonight = w.rows.filter((p) => p.night === night);
    const pastNights = [...w.nights].filter((n) => n !== night).length, totalPast = [...allNights].filter((n) => n !== night).length;
    return { title: w.title, artist: w.artist, pastNights, totalPast, tonight };
  }


  // ---------- one name per person ----------
  // Names are hand-typed into the queue, so the same person shows up as "Scotty 2 Hotty" / "Scotty2hotty",
  // "Bleacher Jeff (fin)" or "Vincent Vega (Bleacher Jeff)". canonicalize() rewrites p.singer to one name per
  // person and keeps the original in p.as_typed. Groups and tables are left alone (their parts are credited in people()).
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  function canonicalize(plays) {
    const counts = new Map(); // norm(base) -> Map(spelling -> n)
    const baseOf = (s) => clean((s || "").replace(/\([^)]*\)/g, " "));
    const parenOf = (s) => { const m = /\(([^)]+)\)/.exec(s || ""); return m ? clean(m[1]) : null; };
    plays.forEach((p) => { const s = clean(p.singer); if (!s || isGroup(s) || /\(/.test(s)) return;
      const k = norm(s); const m = counts.get(k) || new Map(); m.set(s, (m.get(s) || 0) + 1); counts.set(k, m); });
    const display = (k) => { const m = counts.get(k); return m ? [...m.entries()].sort((a, b) => b[1] - a[1] || (b[0] !== b[0].toLowerCase()) - (a[0] !== a[0].toLowerCase()))[0][0] : null; };
    plays.forEach((p) => {
      const s = clean(p.singer); p.as_typed = p.singer;
      if (!s || isGroup(baseOf(s))) return;
      let k = norm(s);
      const par = parenOf(s);
      if (par && !/^not\b/i.test(par)) {
        if (counts.has(norm(par))) k = norm(par);            // "Vincent Vega (Bleacher Jeff)" -> Bleacher Jeff
        else if (counts.has(norm(baseOf(s)))) k = norm(baseOf(s)); // "Bleacher Jeff (fin)" -> Bleacher Jeff
      }
      const d = display(k); if (d) p.singer = d;
    });
    return plays;
  }

  // ---------- season awards (all nights) ----------
  // `isHost` (optional, name -> bool) leaves the host out of the volume awards: most songs, nights and mic time.
  function seasonAwards(plays, ppl, isHost) {
    const out = [], list = [...ppl.values()].filter((e) => e.rows.length);
    const guests = isHost ? list.filter((e) => !isHost(e.name)) : list;
    // Ties go to more songs, then more nights, then more mic time: the same order the site's leaderboards use.
    const secsOf = (e) => e.rows.reduce((a, p) => a + (p.length_s || 0), 0);
    const tie = (a, b) => b.rows.length - a.rows.length || new Set(b.rows.map((p) => p.night)).size - new Set(a.rows.map((p) => p.night)).size || secsOf(b) - secsOf(a);
    const best = (score, min, pool) => (pool || list).filter((e) => (min ? e.rows.length >= min : true)).map((e) => ({ e, v: score(e) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v || tie(a.e, b.e))[0];
    const nightsOf = (e) => new Set(e.rows.map((p) => p.night)).size;
    let w;
    if ((w = best((e) => e.rows.length, 0, guests))) out.push({ id: "s-mvp", label: "Season MVP", who: w.e.name, what: "Most songs of the season", stat: w.v + " songs" });
    if ((w = best(nightsOf, 0, guests)) && w.v > 1) out.push({ id: "s-loyal", label: "Perfect Attendance", who: w.e.name, what: "Showed up and sang the most nights", stat: w.v + " nights" });
    if ((w = best((e) => e.rows.reduce((a, p) => a + (p.length_s || 0), 0), 0, guests))) out.push({ id: "s-mic", label: "Mic Time Champ", who: w.e.name, what: "Most minutes on the mic", stat: Math.round(w.v / 60) + " minutes" });
    if ((w = best(levelsOf))) out.push({ id: "s-badges", label: "Badge Hunter", who: w.e.name, what: "Most badge levels earned", stat: w.v + " badge levels" });
    if ((w = best((e) => new Set(e.rows.filter((p) => p.release_year).map((p) => decade(p.release_year))).size, 3))) out.push({ id: "s-range", label: "Widest Range", who: w.e.name, what: "Songs from the most decades", stat: w.v + " decades" });
    if ((w = best((e) => e.rows.filter((p) => isGroup(p.singer)).length)) && w.v > 1) out.push({ id: "s-duet", label: "Best Duet Partner", who: w.e.name, what: "Shared the mic the most", stat: w.v + " group songs" });
    if ((w = best((e) => { const c = new Map(); e.rows.forEach((p) => { if (p.title) c.set(key(p.title), (c.get(key(p.title)) || 0) + 1); }); return Math.max(0, ...c.values()); })) && w.v > 2) {
      const c = new Map(); w.e.rows.forEach((p) => { if (p.title) c.set(key(p.title), [(c.get(key(p.title)) || [0])[0] + 1, p]); });
      const top = [...c.values()].sort((a, b) => b[0] - a[0])[0][1];
      out.push({ id: "s-onesong", label: "One Song Wonder", who: w.e.name, what: "“" + top.title + "”, again and again", stat: w.v + " times" });
    }
    if ((w = best((e) => { const d = e.rows.filter((p) => p.release_year); return d.length ? Math.round((100 * d.filter((p) => p.release_year < 1980).length) / d.length) : 0; }, 3))) out.push({ id: "s-crate", label: "Crate Digger", who: w.e.name, what: "Highest share of pre-1980 songs (3+ songs)", stat: w.v + "%" });
    const ctx = context(plays, null);
    if ((w = best((e) => e.rows.filter((p) => p.title && ctx.byTitle.get(key(p.title)).some((q) => q.played_at > p.played_at && key(q.singer) !== key(p.singer))).length)) && w.v > 1) out.push({ id: "s-trend", label: "Tastemaker", who: w.e.name, what: "Most songs that others sang later", stat: w.v + " songs" });
    return out;
  }

  // ---------- badge book ----------
  // Every badge, rarest first, with who holds it (highest level first). Collectors rank by total badge levels.
  function badgeBook(ppl) {
    const list = [...ppl.values()].filter((e) => e.rows.length), total = list.length || 1;
    const book = BADGES.filter((b) => b.id !== "debut").map((b) => {
      const held = list.map((e) => ({ name: e.name, b: e.badges.find((x) => x.id === b.id) })).filter((x) => x.b)
        .sort((x, y) => y.b.level - x.b.level || y.b.value - x.b.value || x.b.lvAt.played_at - y.b.lvAt.played_at);
      return { id: b.id, name: b.name, desc: descAt(b, 1), holders: held.map((x) => x.name), top: held.map((x) => ({ name: x.name, tier: x.b.tier, level: x.b.level })),
        pct: Math.round((100 * held.length) / total), maxed: !b.ld.step };
    }).sort((a, b) => a.holders.length - b.holders.length || a.name.localeCompare(b.name));
    const collectors = list.map((e) => ({ name: e.name, n: levelsOf(e), badges: e.badges.filter((b) => b.id !== "debut").length })).filter((x) => x.n).sort((a, b) => b.n - a.n || b.badges - a.badges).slice(0, 10);
    return { book, collectors, singers: list.length };
  }

  // ---------- streaks ----------
  // For one person: {current, best, alive, onTheLine}.
  //  current: weeks in a row up to their latest week. alive: their latest week is the latest karaoke week
  //  (or the one before it while the latest is still this week and they haven't sung yet: onTheLine).
  function streakOf(e, plays) {
    if (!e || !e.rows.length) return { current: 0, best: 0, alive: false, onTheLine: false };
    const weeks = [...new Set(plays.map((p) => weekOf(p.night)))].sort((a, b) => a - b);
    const mine = new Set(e.rows.map((p) => weekOf(p.night)));
    let best = 0, run = 0;
    weeks.forEach((w) => { run = mine.has(w) ? run + 1 : 0; best = Math.max(best, run); });
    const lastW = weekOf(e.rows[e.rows.length - 1].night), latest = weeks[weeks.length - 1];
    const current = runEndingAt(lastW, mine, weeks);
    const thisWeek = weekOf(barDay()); // the bar's own date, so a night past midnight still counts
    const onTheLine = lastW !== latest && weeks.indexOf(lastW) === weeks.length - 2 && latest === thisWeek;
    return { current, best, alive: lastW === latest || onTheLine, onTheLine };
  }
  // Everyone with a live streak of 2+ weeks, longest first.
  function hotStreaks(ppl, plays) {
    return [...ppl.values()].filter((e) => e.rows.length).map((e) => ({ name: e.name, key: e.key, ...streakOf(e, plays) }))
      .filter((x) => x.alive && x.current >= 2).sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
  }

  // ---------- progress toward each badge's next level ----------
  // -> [{id, name, label, tier, level (the next one), desc, have, need, unit}], closest first.
  // Genre badges show up only once you've sung one song in that genre; Hot Streak only while the streak is alive
  // (a broken one starts over), counting the current streak toward the level above your best.
  function progress(e, plays) {
    if (!e || !e.track) return [];
    const st = plays ? streakOf(e, plays) : null;
    return BADGES.filter((b) => b.ld !== LADDERS.once).map((b) => {
      const t = e.track.get(b.id); if (!t) return null;
      const lv = t.level + 1, need = needFor(b.ld, lv), from = needFor(b.ld, t.level) || 0;
      let have = t.value;
      if (!isFinite(need)) return null;
      if (b.id === "streak3") { if (!st || !st.alive || st.current < 1) return null; have = st.current; }
      if (have < 1) return null;
      return { id: b.id, name: b.name, label: labelOf(b, lv), tier: tierName(lv), level: lv, desc: descAt(b, lv), have, need, unit: b.unit,
        part: Math.max(0, (have - (b.id === "streak3" ? 0 : from)) / Math.max(1, need - (b.id === "streak3" ? 0 : from))) };
    }).filter(Boolean).sort((a, b) => b.part - a.part || b.have / b.need - a.have / a.need);
  }

  global.KaraokeFun = { TIERS, tierName, LADDERS, needFor, levelOf, levelsOf, GENRES, genresOf, favoriteBands, BADGES, DARES, badgesAll, unlockedOn, daresStatus, daresFor, watchSong, people, canonicalize, seasonAwards, badgeBook, progress, streakOf, hotStreaks, weekOf, personKey: (s) => key(s) };
})(typeof window !== "undefined" ? window : globalThis);
