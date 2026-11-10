/* Karaoke fun layer: singer badges, nightly dares and the "watch" song.
 * Pure functions over plays rows {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s},
 * sorted by played_at. No dependencies. Exposed as window.KaraokeFun.
 */
(function (global) {
  const key = (s) => (s || "").trim().toLowerCase();
  // Songs from a film, musical, show or game. KaraFun marks most as "Title Source (film)" / "(musical)",
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
  const VENUE_TZ = "America/Chicago";
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
  // Each badge looks at one person's rows (solo and group songs) plus the whole history.
  // test(rows, i, ctx) is called after each of that person's songs; the first true call earns the badge at rows[i].
  const BADGES = [
    { id: "debut", name: "Debut", desc: "Sang a first song here", test: () => true },
    { id: "regular", name: "Regular", desc: "Sang on 3 different nights", test: (r, i) => new Set(r.slice(0, i + 1).map((p) => p.night)).size >= 3 },
    { id: "lifer", name: "Lifer", desc: "Sang on 6 different nights", test: (r, i) => new Set(r.slice(0, i + 1).map((p) => p.night)).size >= 6 },
    { id: "streak3", name: "Three-Peat", desc: "Sang 3 karaoke weeks in a row", test: (r, i, ctx) => ctx.runAt(r, i) >= 3 },
    { id: "streak5", name: "On a Roll", desc: "Sang 5 karaoke weeks in a row", test: (r, i, ctx) => ctx.runAt(r, i) >= 5 },
    { id: "streak10", name: "Iron Lungs", desc: "Sang 10 karaoke weeks in a row", test: (r, i, ctx) => ctx.runAt(r, i) >= 10 },
    { id: "hattrick", name: "Hat Trick", desc: "3 songs in one night", test: (r, i) => r.slice(0, i + 1).filter((p) => p.night === r[i].night).length >= 3 },
    { id: "hopper", name: "Decade Hopper", desc: "Songs from 4 different decades", test: (r, i) => new Set(r.slice(0, i + 1).filter((p) => p.release_year).map((p) => decade(p.release_year))).size >= 4 },
    { id: "timelord", name: "Time Lord", desc: "Songs from 6 different decades", test: (r, i) => new Set(r.slice(0, i + 1).filter((p) => p.release_year).map((p) => decade(p.release_year))).size >= 6 },
    { id: "oldie", name: "Golden Oldie", desc: "Sang a song from before 1970", test: (r, i) => r[i].release_year && r[i].release_year < 1970 },
    { id: "fresh", name: "Fresh Ears", desc: "Sang a song less than 2 years old", test: (r, i) => r[i].release_year && Number(r[i].night.slice(0, 4)) - r[i].release_year <= 1 },
    { id: "marathon", name: "Marathoner", desc: "Finished a song over 6 minutes", test: (r, i) => r[i].length_s > 360 },
    { id: "sprint", name: "Sprinter", desc: "Sang a song under 2 minutes", test: (r, i) => r[i].length_s && r[i].length_s < 120 },
    { id: "duet", name: "Duet Partner", desc: "Shared the mic with someone", test: (r, i) => isGroup(r[i].singer) },
    { id: "broken", name: "Broken Record", desc: "Same song twice in one night", test: (r, i) => r[i].title && r.slice(0, i).some((p) => p.night === r[i].night && key(p.title) === key(r[i].title)) },
    { id: "signature", name: "Signature Song", desc: "Same song on 2 different nights", test: (r, i) => r[i].title && r.slice(0, i).some((p) => p.night !== r[i].night && key(p.title) === key(r[i].title)) },
    { id: "loyal", name: "Superfan", desc: "Same artist 3 times", test: (r, i) => r[i].artist && r.slice(0, i + 1).filter((p) => key(p.artist) === key(r[i].artist)).length >= 3 },
    { id: "brit", name: "Britpop Lifer", desc: "2 Britpop songs (Oasis, Pulp, Blur…)", test: (r, i) => r.slice(0, i + 1).filter(art(BRIT)).length >= 2 },
    { id: "punk", name: "Punk Points", desc: "2 punk songs", test: (r, i) => r.slice(0, i + 1).filter(art(PUNK)).length >= 2 },
    // Genre badges: 2 songs in the genre. Genre Hopper: songs from 5 different genres.
    ...GENRES.map((g) => ({ id: g.id, name: g.name, desc: "2 " + g.genre + " songs", genre: true, test: (r, i) => inGenre(g.id)(r[i]) && r.slice(0, i + 1).filter(inGenre(g.id)).length >= 2 })),
    { id: "g-hopper", name: "Genre Hopper", desc: "Songs from 5 different genres", test: (r, i) => new Set(r.slice(0, i + 1).flatMap((p) => (p.title ? genresOf(p.artist) : []))).size >= 5 },
    { id: "owl", name: "Night Owl", desc: "Sang after 1:30am", test: (r, i) => lateNight(r[i]) },
    { id: "opener", name: "Opening Act", desc: "Sang the first song of a night", test: (r, i, ctx) => ctx.firstOf.get(r[i].night) === r[i] },
    { id: "closer", name: "Closer", desc: "Sang the last song of a night", test: (r, i, ctx) => ctx.lastOf.get(r[i].night) === r[i] && r[i].night !== ctx.liveNight },
    // Crowd reactions (live emoji taps on the phone site). ctx.rx(row) -> {reaction: count} for that song.
    { id: "b-crowd", name: "Crowd Pleaser", desc: "10 hype reactions on one song", test: (r, i, ctx) => hypeOf(ctx.rx(r[i])) >= 10 },
    { id: "b-drop", name: "Mic Dropper", desc: "3 mic drops on one song", test: (r, i, ctx) => (ctx.rx(r[i]).micdrop || 0) >= 3 },
    { id: "b-encore", name: "Encore Earned", desc: "3 encore calls on one song", test: (r, i, ctx) => (ctx.rx(r[i]).encore || 0) >= 3 },
    { id: "b-tomato", name: "Tomato Survivor", desc: "Took 3 tomatoes on one song", test: (r, i, ctx) => (ctx.rx(r[i]).tomato || 0) >= 3 },
    { id: "trend", name: "Trendsetter", desc: "Sang a song someone else picked up later", test: (r, i, ctx) => r[i].title && ctx.byTitle.get(key(r[i].title)).some((p) => p.played_at > r[i].played_at && key(p.singer) !== key(r[i].singer)) },
  ];

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
    return { firstOf, lastOf, byTitle, liveNight, weeks, runAt, rx: (p) => (reax && p.uuid && reax.get(p.uuid)) || none };
  }

  // -> Map(personKey -> {name, rows, badges: [{id, name, desc, at: row}]})
  function badgesAll(plays, liveNight, reax) {
    const ctx = context(plays, liveNight, reax);
    const ppl = people(plays);
    ppl.forEach((e) => {
      e.badges = [];
      BADGES.forEach((b) => { for (let i = 0; i < e.rows.length; i++) if (b.test(e.rows, i, ctx)) { e.badges.push({ id: b.id, name: b.name, desc: b.desc, at: e.rows[i] }); break; } });
    });
    return ppl;
  }

  // Badges first earned on `night` (Debut left out: everyone gets it)
  function unlockedOn(ppl, night) {
    const out = [];
    ppl.forEach((e) => e.badges.forEach((b) => { if (b.at.night === night && b.id !== "debut") out.push({ who: e.name, badge: b }); }));
    return out.sort((a, b) => b.badge.at.played_at - a.badge.at.played_at);
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
  function seasonAwards(plays, ppl) {
    const out = [], list = [...ppl.values()].filter((e) => e.rows.length);
    // Ties go to more songs, then more nights, then more mic time: the same order the site's leaderboards use.
    const secsOf = (e) => e.rows.reduce((a, p) => a + (p.length_s || 0), 0);
    const tie = (a, b) => b.rows.length - a.rows.length || new Set(b.rows.map((p) => p.night)).size - new Set(a.rows.map((p) => p.night)).size || secsOf(b) - secsOf(a);
    const best = (score, min) => list.filter((e) => (min ? e.rows.length >= min : true)).map((e) => ({ e, v: score(e) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v || tie(a.e, b.e))[0];
    const nightsOf = (e) => new Set(e.rows.map((p) => p.night)).size;
    let w;
    if ((w = best((e) => e.rows.length))) out.push({ id: "s-mvp", label: "Season MVP", who: w.e.name, what: "Most songs of the season", stat: w.v + " songs" });
    if ((w = best(nightsOf)) && w.v > 1) out.push({ id: "s-loyal", label: "Perfect Attendance", who: w.e.name, what: "Showed up and sang the most nights", stat: w.v + " nights" });
    if ((w = best((e) => e.rows.reduce((a, p) => a + (p.length_s || 0), 0)))) out.push({ id: "s-mic", label: "Mic Time Champ", who: w.e.name, what: "Most minutes on the mic", stat: Math.round(w.v / 60) + " minutes" });
    if ((w = best((e) => e.badges.filter((b) => b.id !== "debut").length))) out.push({ id: "s-badges", label: "Badge Hunter", who: w.e.name, what: "Most badges earned", stat: w.v + " badges" });
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
  function badgeBook(ppl) {
    const list = [...ppl.values()].filter((e) => e.rows.length), total = list.length || 1;
    const book = BADGES.filter((b) => b.id !== "debut").map((b) => {
      const holders = list.filter((e) => e.badges.some((x) => x.id === b.id));
      return { id: b.id, name: b.name, desc: b.desc, holders: holders.map((e) => e.name), pct: Math.round((100 * holders.length) / total) };
    }).sort((a, b) => a.holders.length - b.holders.length || a.name.localeCompare(b.name));
    const collectors = list.map((e) => ({ name: e.name, n: e.badges.filter((b) => b.id !== "debut").length })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 10);
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
    const thisWeek = weekOf(new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10)); // about Central, good enough for a week
    const onTheLine = lastW !== latest && weeks.indexOf(lastW) === weeks.length - 2 && latest === thisWeek;
    return { current, best, alive: lastW === latest || onTheLine, onTheLine };
  }
  // Everyone with a live streak of 2+ weeks, longest first.
  function hotStreaks(ppl, plays) {
    return [...ppl.values()].filter((e) => e.rows.length).map((e) => ({ name: e.name, key: e.key, ...streakOf(e, plays) }))
      .filter((x) => x.alive && x.current >= 2).sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
  }

  // ---------- progress toward badges not earned yet ----------
  function progress(e, plays) {
    if (!e) return [];
    const r = e.rows, has = new Set(e.badges.map((b) => b.id));
    const nights = new Set(r.map((p) => p.night)).size;
    const decs = new Set(r.filter((p) => p.release_year).map((p) => decade(p.release_year))).size;
    const perNight = Math.max(0, ...[...new Set(r.map((p) => p.night))].map((n) => r.filter((p) => p.night === n).length));
    const artistMax = Math.max(0, ...[...new Set(r.map((p) => key(p.artist)).filter(Boolean))].map((a) => r.filter((p) => key(p.artist) === a).length));
    const cand = [
      ["regular", nights, 3, "nights"], ["lifer", nights, 6, "nights"], ["hattrick", perNight, 3, "songs in a night"],
      ["hopper", decs, 4, "decades"], ["timelord", decs, 6, "decades"], ["loyal", artistMax, 3, "songs by one artist"],
      ["brit", r.filter(art(BRIT)).length, 2, "Britpop songs"], ["punk", r.filter(art(PUNK)).length, 2, "punk songs"],
      // Genre badges show up as "next" only once you've sung one song in that genre.
      ...GENRES.map((g) => [g.id, r.filter(inGenre(g.id)).length, 2, g.genre + " songs"]).filter((x) => x[1] >= 1),
      ["g-hopper", new Set(r.flatMap((p) => (p.title ? genresOf(p.artist) : []))).size, 5, "genres"],
    ];
    // Streak badges: only while the streak is alive, since a broken one starts over.
    if (plays) { const st = streakOf(e, plays), cur = st.alive ? st.current : 0;
      [["streak3", 3], ["streak5", 5], ["streak10", 10]].forEach(([id, need]) => cand.push([id, cur, need, "weeks in a row"])); }
    return cand.filter(([id, have, need]) => !has.has(id) && have < need && !(id === "lifer" && !has.has("regular")) && !(id === "timelord" && !has.has("hopper"))
        && !(id === "streak5" && !has.has("streak3")) && !(id === "streak10" && !has.has("streak5")) && !(id.startsWith("streak") && have < 1))
      .map(([id, have, need, unit]) => { const b = BADGES.find((x) => x.id === id); return { id, name: b.name, desc: b.desc, have, need, unit }; })
      .sort((a, b) => b.have / b.need - a.have / a.need);
  }

  global.KaraokeFun = { GENRES, genresOf, favoriteBands, BADGES, DARES, badgesAll, unlockedOn, daresStatus, daresFor, watchSong, people, canonicalize, seasonAwards, badgeBook, progress, streakOf, hotStreaks, weekOf, personKey: (s) => key(s) };
})(typeof window !== "undefined" ? window : globalThis);
