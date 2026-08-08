#!/usr/bin/env node
// Builds a self-contained static browser for Stadt Zürich Ferienkurse.
//
//   node build.mjs            # uses cached raw data when present
//   node build.mjs --refetch  # re-pulls everything from the API
//
// Intermediates are cached in cache/ so the API is hit at most once.

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

const read = (path) => readFile(path, "utf8");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const API = "https://www.stadt-zuerich.ch/sport-portal/API/api/courses";
const GEO = "https://api3.geo.admin.ch/rest/services/api/SearchServer";
// Only the fallback origin: the browser recomputes every distance from the
// visitor's own address, so nothing distance-shaped is baked into the payload.
const DEFAULT_HOME = { lat: 47.40240478515625, lon: 8.543060302734375, label: "Ringstrasse 33, 8057 Zürich" };
const REFETCH = process.argv.includes("--refetch");

const cache = async (name, produce) => {
  const path = `cache/${name}`;
  if (!REFETCH && existsSync(path)) return JSON.parse(await read(path));
  const value = await produce();
  await mkdir("cache", { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return value;
};

// ---------------------------------------------------------------- fetching

// The API pages over a pre-filter row count and silently drops rows, so any
// pageSize > 1 loses courses (pageSize 25 returned 390/414, pageSize 50 only
// 366). Sweeping one row at a time is the only lossless read.
const listAll = async () => {
  const page = async (n) => {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        kurstyp: 2, aktivitaeten: [], ferienwochen: [], ferientyp: [], wochentage: [],
        jahrgaenge: [], kategorien: [], select1: [], select2: [], select3: [],
        pageNumber: n, pageSize: 1,
      }),
    });
    return (await r.json()).data;
  };

  const total = (await page(1)).total;
  const rows = new Map();
  for (let start = 1; start <= total; start += 25) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(25, total - start + 1) }, (_, k) => start + k)
        .map(async (n) => [n, (await page(n)).results]),
    );
    for (const [n, res] of batch) for (const c of res) rows.set(c.angebotId, c);
    process.stderr.write(`\rlist ${rows.size}/${total}`);
  }
  process.stderr.write("\n");
  return [...rows.values()].map(({ bild, ...rest }) => rest);
};

// Only the detail endpoint carries price, address and coordinates.
const detailsFor = async (ids) => {
  const out = {};
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await Promise.all(ids.slice(i, i + 20).map(async (id) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${API}/${id}`, { headers: { accept: "application/json" } });
          const j = await r.json();
          if (j.success && j.data) { const { bild, ...d } = j.data; return [id, d]; }
        } catch { /* retry */ }
        await sleep(300);
      }
      throw new Error(`detail fetch failed for ${id}`);
    }));
    for (const [id, d] of batch) out[id] = d;
    process.stderr.write(`\rdetails ${Object.keys(out).length}/${ids.length}`);
  }
  process.stderr.write("\n");
  return out;
};

const geocode = async (query) => {
  const r = await fetch(`${GEO}?${new URLSearchParams({ searchText: query, type: "locations", limit: "1" })}`);
  const hit = (await r.json()).results?.[0]?.attrs;
  return hit ? { lat: hit.lat, lon: hit.lon, matched: hit.label.replace(/<\/?b>/g, "") } : null;
};

// ---------------------------------------------------------------- geometry

// Swisstopo approximation, ~1 m accurate — good enough for crow-flies km.
const lv95ToWgs84 = (E, N) => {
  const y = (E - 2600000) / 1e6, x = (N - 1200000) / 1e6;
  const lam = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const phi = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3;
  return { lat: (phi * 100) / 36, lon: (lam * 100) / 36 };
};

const inSwitzerland = (E, N) => E >= 2485000 && E <= 2834000 && N >= 1075000 && N <= 1296000;

// ---------------------------------------------------------------- taxonomy

// The API speaks German throughout. Categories, activities and every
// enumerated field are mapped to English here; free prose is translated
// separately and looked up from cache/translations.json.
const ACTIVITY_EN = {
  "Aikido": "Aikido",
  "Akrobatik": "Acrobatics",
  "Badminton": "Badminton",
  "Ballett": "Ballet",
  "Basketball": "Basketball",
  "Billard": "Billiards",
  "Bogensport": "Archery",
  "Boxen / Kickboxen": "Boxing / kickboxing",
  "Capoeira": "Capoeira",
  "Curling": "Curling",
  "Eishockey": "Ice hockey",
  "Eiskunstlauf": "Figure skating",
  "Fechten": "Fencing",
  "Fitness": "Fitness",
  "Fussball": "Football",
  "Gesundheit und Ernährung": "Health and nutrition",
  "Golf": "Golf",
  "Handball": "Handball",
  "Handwerk und Gestalten": "Crafts and making",
  "Hip Hop / Streetdance": "Hip hop / street dance",
  "Ju-Jitsu": "Ju-jitsu",
  "Kampfsport diverse": "Martial arts (various)",
  "Kanu": "Canoeing",
  "Karate": "Karate",
  "Kung Fu": "Kung fu",
  "Landhockey": "Field hockey",
  "Leichtathletik": "Athletics",
  "Mountainbike": "Mountain biking",
  "Musik": "Music",
  "Natur und Abenteuer": "Nature and adventure",
  "Parkour": "Parkour",
  "Polysport": "Multi-sport",
  "Reiten": "Horse riding",
  "Rudern": "Rowing",
  "Schwimmen": "Swimming",
  "Segeln": "Sailing",
  "Selbstverteidigung": "Self-defence",
  "Skateboarding": "Skateboarding",
  "Sportklettern": "Sport climbing",
  "Squash": "Squash",
  "Stand Up Paddling": "Stand-up paddling",
  "Surfen": "Surfing",
  "Synchronschwimmen": "Synchronised swimming",
  "Tanzen diverse": "Dance (various)",
  "Tauchen": "Diving",
  "Tennis": "Tennis",
  "Theater und Tanz": "Theatre and dance",
  "Tischfussball": "Table football",
  "Tischtennis": "Table tennis",
  "Unihockey": "Floorball",
  "Volleyball": "Volleyball",
  "Voltigieren": "Vaulting",
  "Wasserspringen": "Diving (springboard)",
  "Wissenschaft und Technik": "Science and technology",
  "Yoga": "Yoga",
};

const CATEGORY_OF_ACTIVITY = new Map(Object.entries({
  "Ball sports": ["Fussball", "Basketball", "Volleyball", "Handball", "Unihockey", "Landhockey",
    "Tennis", "Badminton", "Tischtennis", "Squash", "Tischfussball", "Billard", "Golf"],
  "Martial arts": ["Selbstverteidigung", "Karate", "Kung Fu", "Ju-Jitsu", "Aikido",
    "Boxen / Kickboxen", "Kampfsport diverse", "Fechten", "Capoeira"],
  "Water sports": ["Schwimmen", "Synchronschwimmen", "Wasserspringen", "Rudern", "Segeln",
    "Stand Up Paddling", "Tauchen", "Surfen", "Kanu"],
  "Ice sports": ["Eishockey", "Eiskunstlauf", "Curling"],
  "Dance, music & stage": ["Theater und Tanz", "Tanzen diverse", "Ballett", "Hip Hop / Streetdance", "Musik"],
  "Nature & adventure": ["Natur und Abenteuer", "Reiten", "Voltigieren", "Bogensport",
    "Mountainbike", "Sportklettern"],
  "Tech & crafts": ["Wissenschaft und Technik", "Handwerk und Gestalten"],
  "Movement & fitness": ["Polysport", "Akrobatik", "Parkour", "Skateboarding", "Fitness",
    "Yoga", "Leichtathletik", "Gesundheit und Ernährung"],
}).flatMap(([category, activities]) => activities.map((a) => [a, category])));

const categoryOf = (course) =>
  course.kategorieId === 3 ? "Combined courses"
    : CATEGORY_OF_ACTIVITY.get(course.aktivitaet) ?? "Other";

const LEVEL_EN = {
  "Einsteiger*innen": "Beginners",
  "Fortgeschrittene": "Advanced",
  "Einsteiger*innen und Fortgeschrittene": "Beginners and advanced",
};

const GENDER_EN = {
  "Mädchen und Knaben": "Girls and boys",
  "Mädchen": "Girls only",
};

const WEEKDAY_EN = {
  Montag: "Monday", Dienstag: "Tuesday", Mittwoch: "Wednesday", Donnerstag: "Thursday",
  Freitag: "Friday", Samstag: "Saturday", Sonntag: "Sunday",
};

// "Montag bis Freitag" -> "Monday to Friday"; single days pass through the map.
const daysEn = (label) => (label ?? "")
  .split(/\s+bis\s+/)
  .map((d) => WEEKDAY_EN[d.trim()] ?? d.trim())
  .join(" to ");

// "9.30–16.00 Uhr" -> "09:30–16:00"
const timeEn = (label) => (label ?? "")
  .replace(/(\d{1,2})[.:](\d{2})/g, (_, h, m) => `${h.padStart(2, "0")}:${m}`)
  .replace(/\s*Uhr\s*$/, "")
  .trim();

// Status strings embed a dd.mm.yyyy date; render it the same way as every
// other date in the UI.
const statusDate = (ddmmyyyy) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy.trim());
  return m ? `${+m[1]} ${MONTHS[+m[2] - 1]} ${m[3]}` : ddmmyyyy;
};

const statusEn = (label) => {
  const s = (label ?? "").trim();
  if (s === "Nicht mehr buchbar") return "Closed for registration";
  const bookable = /^Buchbar ab\s+(.+)$/.exec(s);
  if (bookable) return `Bookable from ${statusDate(bookable[1])}`;
  const late = /^Nachmelden bis\s+(.+)$/.exec(s);
  if (late) return `Late registration until ${statusDate(late[1])}`;
  return s;
};

// ---------------------------------------------------------------- grouping

// `nummer` is "Ferienkurs XXX 21": the letter prefix identifies the course, the
// trailing digits the individual slot. Prefix + age band is almost the right
// grouping key; a handful of prefixes host genuinely different courses (FCO
// coding tracks, morning/afternoon Lego topics), so titles are compared too —
// fuzzily, because the source has typos ("Minibasketballl-Camp").
const prefixOf = (nummer) => (nummer ?? "").trim().replace(/\s+\d+$/, "");

const normalizeTitle = (t) => (t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const editDistance = (a, b) => {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

const similar = (a, b) => {
  const [x, y] = [normalizeTitle(a), normalizeTitle(b)];
  const longest = Math.max(x.length, y.length);
  return longest === 0 || 1 - editDistance(x, y) / longest >= 0.85;
};

// Age bands drift by a year between seasons for the same course, but they also
// encode real tiers (Y.E.S. 2014–2016 vs 2017–2018, Eislaufen 2015–2019 vs
// 2018–2021). Merge only bands that mostly overlap.
const sameAgeTier = (a, b) => {
  const lo = Math.max(a.jahrgangVon, b.jahrgangVon);
  const hi = Math.min(a.jahrgangBis, b.jahrgangBis);
  const intersection = Math.max(0, hi - lo + 1);
  const union = Math.max(a.jahrgangBis, b.jahrgangBis) - Math.min(a.jahrgangVon, b.jahrgangVon) + 1;
  return intersection / union >= 0.7;
};

// ---------------------------------------------------------------- shaping

const ALLOWED_TAGS = /^(a|b|br|em|i|li|ol|p|strong|ul)$/;

// Source text is hand-authored HTML from a CMS. Keep light formatting and
// links, drop everything else rather than trusting it into innerHTML.
const sanitize = (html) => {
  if (!html) return "";
  return html
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (match, tag, attrs) => {
      const name = tag.toLowerCase();
      if (!ALLOWED_TAGS.test(name)) return " ";
      if (match.startsWith("</")) return `</${name}>`;
      if (name !== "a") return `<${name}>`;
      const href = /href\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "";
      return /^https?:\/\//i.test(href)
        ? `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">`
        : "<a>";
    })
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

// Free prose (description, what to bring, remarks) is translated once by the
// authoring step and cached; the build is a pure lookup so it stays offline
// and reproducible. A missing entry is a hard error rather than a silent
// German string leaking into an English UI.
const TRANSLATIONS = JSON.parse(await read("cache/translations.json"));

const translate = (german) => {
  const source = (german ?? "").trim();
  if (!source) return "";
  const english = TRANSLATIONS[source];
  if (!english) throw new Error(`missing translation for: ${source.slice(0, 80)}…`);
  return english;
};

const shortNr = (nummer) => nummer.replace(/^Ferienkurs\s+/, "");

const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

// Providers re-type the same blurb with small edits ("Primarschüler*innen" vs
// "Primarschüler"). Fold those together and keep the fullest wording; keep
// genuinely different values apart, labelled by course number.
const nearlyEqual = (a, b) => {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return true;
  if (Math.min(a.length, b.length) / longest < 0.8) return false;
  return 1 - editDistance(a, b) / longest >= 0.9;
};

const dedupe = (members, valueOf, match) => {
  const out = [];
  for (const c of members) {
    const value = sanitize(translate(valueOf(c)));
    if (!value) continue;
    const key = plain(value);
    const hit = out.find((o) => match(o.key, key));
    if (!hit) { out.push({ key, value, nrs: [shortNr(c.nummer)] }); continue; }
    hit.nrs.push(shortNr(c.nummer));
    if (value.length > hit.value.length) { hit.value = value; hit.key = key; }
  }
  return out;
};

// One card can span several providers; each field is folded on its own so a
// shared description is not repeated just because the course leaders differ.
const describe = (members) => ({
  texts: dedupe(members, (c) => c.text, nearlyEqual),
  bring: dedupe(members, (c) => c.mitbringen, nearlyEqual),
  notes: dedupe(members, (c) => c.bemerkung, (a, b) => a === b),
});

// "9.30–16.00 Uhr" -> { start: 9.5, end: 16 }
const parseTimespan = (label) => {
  const m = /(\d{1,2})[.:](\d{2})\s*[–-]\s*(\d{1,2})[.:](\d{2})/.exec(label ?? "");
  if (!m) return { start: null, end: null };
  return { start: +m[1] + +m[2] / 60, end: +m[3] + +m[4] / 60 };
};

// Only the autumn holidays are in scope, so the season is implied and the
// label just numbers the week.
const weekOf = (course) => ({
  id: `${course.ferientypId}-${course.ferienwocheId}`,
  label: `Autumn week ${course.ferienwocheId}`,
});

// "10.8.2026–14.8.2026" from the API is German-ordered; rebuild it from the
// ISO range instead so the app never has to parse a localised string.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const dateRange = (from, to) => {
  if (!from) return "";
  const year = new Date(to ?? from).getFullYear();
  const start = dayMonth(from);
  const end = to ? dayMonth(to) : "";
  return end && end !== start ? `${start} – ${end} ${year}` : `${start} ${year}`;
};

// ---------------------------------------------------------------- pipeline

const list = await cache("list.json", listAll);
const details = await cache("details.json", () => detailsFor(list.map((c) => c.angebotId)));
// ferientypId 2 is the summer holidays, 3 the autumn ones. Summer is over and
// out of scope; drop it here so nothing downstream has to know about seasons.
const courses = list
  .filter((c) => c.ferientypId === 3)
  .map((c) => ({ ...c, ...details[c.angebotId] }));

const venueKeyOf = (c) => `${c.anlage}|${c.anlageStrasse}|${c.anlagePlzOrt}`;

// Venues the address geocoder cannot resolve, pinned by hand.
const COORD_OVERRIDES = {
  // Tram 13 terminus; the record has no street at all.
  "Albisgütli, Tramendstation Tram 13|*|8045 Zürich": { lat: 47.351543, lon: 8.507504 },
};

const venueCoords = await cache("venue-coords.json", async () => {
  const resolved = {};
  for (const c of courses) {
    const key = venueKeyOf(c);
    if (resolved[key]) continue;
    // A few records carry a dropped or duplicated digit in the LV95 pair
    // (E=26816660, N=124878); fall back to geocoding the postal address.
    if (c.anlageLaengengrad && c.anlageBreitengrad && inSwitzerland(c.anlageLaengengrad, c.anlageBreitengrad)) {
      resolved[key] = { ...lv95ToWgs84(c.anlageLaengengrad, c.anlageBreitengrad), source: "api" };
      continue;
    }
    if (COORD_OVERRIDES[key]) {
      resolved[key] = { ...COORD_OVERRIDES[key], source: "override" };
      continue;
    }
    const street = c.anlageStrasse && c.anlageStrasse !== "*" ? c.anlageStrasse : "";
    const hit = (street && await geocode(`${street} ${c.anlagePlzOrt}`)) || await geocode(`${c.anlage} ${c.anlagePlzOrt}`);
    if (!hit) throw new Error(`cannot locate venue: ${key}`);
    resolved[key] = { lat: hit.lat, lon: hit.lon, source: "geocoded" };
    process.stderr.write(`geocoded ${c.anlage} -> ${hit.matched}\n`);
  }
  return resolved;
});

const venues = new Map();
for (const c of courses) {
  const key = venueKeyOf(c);
  if (venues.has(key)) continue;
  const coord = venueCoords[key];
  venues.set(key, {
    id: venues.size,
    name: c.anlage,
    street: c.anlageStrasse === "*" ? "" : c.anlageStrasse,
    city: c.anlagePlzOrt,
    lat: coord.lat,
    lon: coord.lon,
    approx: coord.source === "geocoded",
  });
}

// Bucket by course prefix, then split buckets whose titles or age tiers differ.
const buckets = new Map();
for (const c of courses) {
  const key = prefixOf(c.nummer);
  (buckets.get(key) ?? buckets.set(key, []).get(key)).push(c);
}

const groups = [];
for (const [key, members] of buckets) {
  const clusters = [];
  for (const c of members) {
    const hit = clusters.find((cluster) => similar(cluster[0].titel, c.titel) && sameAgeTier(cluster[0], c));
    if (hit) hit.push(c); else clusters.push([c]);
  }
  clusters.forEach((cluster, i) => {
    // The title most members agree on; typos ("Minibasketballl-Camp") are rare
    // enough to lose the vote. Length only breaks ties.
    const votes = new Map();
    for (const c of cluster) votes.set(c.titel.trim(), (votes.get(c.titel.trim()) ?? 0) + 1);
    const lead = cluster.reduce((a, b) => {
      const [va, vb] = [votes.get(a.titel.trim()), votes.get(b.titel.trim())];
      return vb > va || (vb === va && b.titel.trim().length > a.titel.trim().length) ? b : a;
    });
    const variants = cluster.map((c) => {
      const span = parseTimespan(c.zeitpunkt4);
      const week = weekOf(c);
      return {
        id: c.angebotId,
        nr: shortNr(c.nummer),
        venue: venues.get(venueKeyOf(c)).id,
        price: c.preis,
        weekId: week.id,
        dates: dateRange(c.von, c.bis),
        days: daysEn(c.zeitpunkt3),
        time: timeEn(c.zeitpunkt4),
        start: span.start,
        end: span.end,
        from: c.von,
        to: c.bis,
        deadline: c.anmeldeschluss?.startsWith("0001") ? null : c.anmeldeschluss,
        status: statusEn(c.status1),
        // "Nicht mehr buchbar" marks slots whose registration already closed.
        bookable: (c.status1 ?? "") !== "Nicht mehr buchbar",
        level: LEVEL_EN[c.niveau] ?? "",
        ageFrom: c.jahrgangVon,
        ageTo: c.jahrgangBis,
        age: c.jahrgang,
        free: !!c.hatFreiePlaetze,
      };
    }).sort((a, b) => a.weekId.localeCompare(b.weekId) || (a.start ?? 0) - (b.start ?? 0) || a.nr.localeCompare(b.nr));

    const ageFrom = Math.min(...cluster.map((c) => c.jahrgangVon));
    const ageTo = Math.max(...cluster.map((c) => c.jahrgangBis));
    // Level varies per date for a few courses (Segeln Optimist runs beginner
    // and advanced weeks), so it only becomes a card-level tag when uniform.
    const levels = new Set(cluster.map((c) => LEVEL_EN[c.niveau] ?? ""));

    groups.push({
      // Favourites live in localStorage, so the identity must survive a
      // rebuild. Grouping heuristics can shift; API offer ids cannot.
      id: Math.min(...variants.map((v) => v.id)),
      title: lead.titel.trim(),
      category: categoryOf(lead),
      activity: ACTIVITY_EN[lead.aktivitaet] ?? "—",
      ageFrom,
      ageTo,
      ageLabel: `${ageFrom}–${ageTo}`,
      mixedAges: new Set(cluster.map((c) => c.jahrgang)).size > 1,
      mixedLevels: levels.size > 1,
      gender: GENDER_EN[lead.geschlecht] ?? "",
      level: levels.size === 1 ? [...levels][0] : "",
      // Providers under one card each write their own blurb; keep them apart
      // instead of pretending one description covers all of them.
      details: describe(cluster),
      variants,
    });
  });
}

// The city sometimes files one course under several prefixes — same title and
// age tier, different provider or rink (Eislaufen at three rinks, Tennis-Camp
// at five clubs). Fold those into one card; the slot table keeps venue and
// course number per date, so nothing is lost.
const merged = [];
for (const group of groups) {
  const twin = merged.find((m) =>
    normalizeTitle(m.title) === normalizeTitle(group.title)
    && m.category === group.category
    && m.gender === group.gender
    && m.level === group.level
    && sameAgeTier({ jahrgangVon: m.ageFrom, jahrgangBis: m.ageTo },
      { jahrgangVon: group.ageFrom, jahrgangBis: group.ageTo }));
  if (!twin) { merged.push(group); continue; }
  twin.variants.push(...group.variants);
  twin.ageFrom = Math.min(twin.ageFrom, group.ageFrom);
  twin.ageTo = Math.max(twin.ageTo, group.ageTo);
  twin.ageLabel = `${twin.ageFrom}–${twin.ageTo}`;
  twin.mixedAges = new Set(twin.variants.map((v) => v.age)).size > 1;
  twin.mixedLevels = new Set(twin.variants.map((v) => v.level)).size > 1;
  twin.id = Math.min(twin.id, group.id);
  for (const field of ["texts", "bring", "notes"]) {
    const match = field === "notes" ? (a, b) => a === b : nearlyEqual;
    for (const entry of group.details[field]) {
      const same = twin.details[field].find((o) => match(o.key, entry.key));
      if (!same) { twin.details[field].push(entry); continue; }
      same.nrs.push(...entry.nrs);
      if (entry.value.length > same.value.length) { same.value = entry.value; same.key = entry.key; }
    }
  }
}

for (const g of merged) {
  g.variants.sort((a, b) => a.weekId.localeCompare(b.weekId) || (a.start ?? 0) - (b.start ?? 0)
    || a.nr.localeCompare(b.nr));
}

for (const g of merged) {
  for (const field of ["texts", "bring", "notes"]) {
    for (const entry of g.details[field]) delete entry.key;
  }
}
merged.sort((a, b) => a.title.localeCompare(b.title, "de"));

const weeks = [...new Map(courses.map((c) => [weekOf(c).id, weekOf(c)])).values()]
  .sort((a, b) => a.id.localeCompare(b.id));

const data = {
  home: DEFAULT_HOME,
  generated: new Date().toISOString(),
  weeks,
  venues: [...venues.values()],
  groups: merged,
};

await writeFile("data.json", JSON.stringify(data));

// Inline everything so the result works straight off the filesystem.
const [shell, css, js] = await Promise.all(["src/shell.html", "src/app.css", "src/app.js"].map(read));
const payload = JSON.stringify(data).replace(/</g, "\\u003c");
const html = shell
  .replace("/*STYLE*/", () => css)
  .replace("/*DATA*/", () => payload)
  .replace("/*SCRIPT*/", () => js);

await writeFile("index.html", html);

const variantCount = merged.reduce((n, g) => n + g.variants.length, 0);
console.log(`courses ${courses.length} -> ${merged.length} groups / ${variantCount} slots, ${venues.size} venues`);
console.log(`index.html ${((await stat("index.html")).size / 1024).toFixed(0)} KB`);
