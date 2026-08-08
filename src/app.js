"use strict";

const DATA = JSON.parse(document.getElementById("payload").textContent);
const VENUES = new Map(DATA.venues.map((v) => [v.id, v]));
const BOOKING = (id) => `https://www.stadt-zuerich.ch/sport-portal/angebot/${id}`;
const FAV_KEY = "zurich-holiday-courses:favourites";
const FILTER_KEY = "zurich-holiday-courses:filters";
// Bumped whenever the filter shape or its vocabulary changes. Stored state
// from an older build is discarded rather than left to silently match nothing.
const FILTER_SCHEMA = 2;
const KM_ANY = 15;
const PRICE_ANY = 700;

const $ = (id) => document.getElementById(id);
const el = (tag, props, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};

// ------------------------------------------------------------- persistence

const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

// Favourites are keyed by the course's stable API id, so a rebuild that
// reshuffles grouping keeps them attached to the right card.
const courseIds = new Set(DATA.groups.map((g) => g.id));
const favorites = new Set(load(FAV_KEY, []).filter((id) => courseIds.has(id)));
const persistFavorites = () => save(FAV_KEY, [...favorites]);

const DEFAULTS = {
  q: "", weeks: [], cats: [], activity: "", year: "", level: "", gender: "",
  km: KM_ANY, price: PRICE_ANY, start: "", end: "", favOnly: false, bookable: false,
  sort: "distance",
};
const expanded = new Set();
const openSlots = new Set();

// ------------------------------------------------------------- derived data

for (const g of DATA.groups) {
  g.haystack = [g.title, g.activity, g.category, g.ageLabel,
    ...[...g.details.texts, ...g.details.bring, ...g.details.notes].map((e) => e.value),
    ...g.variants.map((v) => `${v.nr} ${VENUES.get(v.venue).name} ${VENUES.get(v.venue).city}`)]
    .join(" ").toLowerCase();
  for (const v of g.variants) v.km = VENUES.get(v.venue).km;
}

const tally = (items, keyOf) => {
  const counts = new Map();
  for (const item of items) for (const key of [keyOf(item)].flat()) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const categoryCounts = tally(DATA.groups, (g) => g.category);
const activityCounts = tally(DATA.groups, (g) => g.activity);
const weekCounts = tally(DATA.groups, (g) => [...new Set(g.variants.map((v) => v.weekId))]);
const levels = [...new Set(DATA.groups.flatMap((g) => g.variants.map((v) => v.level)))]
  .filter(Boolean).sort();
const startTimes = [...new Set(DATA.groups.flatMap((g) => g.variants.map((v) => v.start)))]
  .filter((t) => t != null).sort((a, b) => a - b);
const endTimes = [...new Set(DATA.groups.flatMap((g) => g.variants.map((v) => v.end)))]
  .filter((t) => t != null).sort((a, b) => a - b);
const years = (() => {
  const from = Math.min(...DATA.groups.map((g) => g.ageFrom));
  const to = Math.max(...DATA.groups.map((g) => g.ageTo));
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
})();

// ------------------------------------------------------------- filter state

// Restored filters are validated against the vocabulary this build actually
// has. A value that no longer exists (a renamed category, a level from the
// German build) is dropped instead of quietly matching nothing and leaving
// the user staring at an empty list.
const restoreFilters = () => {
  const stored = load(FILTER_KEY, null);
  if (!stored || stored.v !== FILTER_SCHEMA || typeof stored.filters !== "object") {
    return { ...DEFAULTS };
  }
  const saved = stored.filters;
  const oneOf = (value, allowed, fallback = "") => (allowed.includes(value) ? value : fallback);
  const subset = (value, allowed) =>
    Array.isArray(value) ? value.filter((x) => allowed.includes(x)) : [];
  // Out of the control's domain means corrupt, not "clamp me" — clamping a
  // stored -5 to 0 would restore a filter that matches nothing.
  const inRange = (value, lo, hi, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi
      ? value : fallback;

  return {
    q: typeof saved.q === "string" ? saved.q : "",
    weeks: subset(saved.weeks, DATA.weeks.map((w) => w.id)),
    cats: subset(saved.cats, [...categoryCounts.keys()]),
    activity: oneOf(saved.activity, [...activityCounts.keys()]),
    level: oneOf(saved.level, levels),
    gender: oneOf(saved.gender, [...new Set(DATA.groups.map((g) => g.gender))]),
    year: years.includes(+saved.year) ? String(saved.year) : "",
    start: startTimes.includes(+saved.start) ? String(saved.start) : "",
    end: endTimes.includes(+saved.end) ? String(saved.end) : "",
    km: inRange(saved.km, 0, KM_ANY, KM_ANY),
    price: inRange(saved.price, 0, PRICE_ANY, PRICE_ANY),
    favOnly: saved.favOnly === true,
    bookable: saved.bookable === true,
    sort: oneOf(saved.sort, Object.keys(SORTS), DEFAULTS.sort),
  };
};

// ------------------------------------------------------------- formatting

const clock = (t) => t == null ? ""
  : `${String(Math.floor(t)).padStart(2, "0")}:${String(Math.round((t % 1) * 60)).padStart(2, "0")}`;
const money = (n) => `CHF ${n.toLocaleString("en-CH")}`;
const km = (n) => `${n.toLocaleString("en-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------- filtering

const variantMatches = (v) =>
  (filters.weeks.length === 0 || filters.weeks.includes(v.weekId))
  && v.price <= filters.price
  && (filters.km >= KM_ANY || v.km <= filters.km)
  && (filters.start === "" || (v.start != null && v.start >= +filters.start))
  && (filters.end === "" || (v.end != null && v.end <= +filters.end))
  && (filters.year === "" || (+filters.year >= v.ageFrom && +filters.year <= v.ageTo))
  && (filters.level === "" || v.level === filters.level)
  && (!filters.bookable || v.bookable);

const groupMatches = (g) => {
  if (filters.favOnly && !favorites.has(g.id)) return false;
  if (filters.cats.length && !filters.cats.includes(g.category)) return false;
  if (filters.activity && g.activity !== filters.activity) return false;
  if (filters.gender && g.gender !== filters.gender) return false;
  if (filters.q) {
    const needles = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!needles.every((n) => g.haystack.includes(n))) return false;
  }
  return true;
};

const SORTS = {
  distance: (a, b) => a.km - b.km || a.g.title.localeCompare(b.g.title, "en"),
  "price-asc": (a, b) => a.minPrice - b.minPrice || a.km - b.km,
  "price-desc": (a, b) => b.maxPrice - a.maxPrice || a.km - b.km,
  date: (a, b) => a.from.localeCompare(b.from) || a.g.title.localeCompare(b.g.title, "en"),
  title: (a, b) => a.g.title.localeCompare(b.g.title, "en"),
  category: (a, b) => a.g.category.localeCompare(b.g.category, "en")
    || a.g.title.localeCompare(b.g.title, "en"),
  age: (a, b) => b.g.ageTo - a.g.ageTo || a.g.title.localeCompare(b.g.title, "en"),
};

const filters = restoreFilters();

// Sort order is not a filter, so it never counts towards the active badge.
const activeFilterCount = () =>
  Object.entries(DEFAULTS).filter(([key, fallback]) => {
    if (key === "sort") return false;
    const value = filters[key];
    return Array.isArray(fallback) ? value.length > 0 : value !== fallback;
  }).length;

const collect = () => {
  const hits = [];
  for (const g of DATA.groups) {
    if (!groupMatches(g)) continue;
    const slots = g.variants.filter(variantMatches);
    if (!slots.length) continue;
    hits.push({
      g,
      slots,
      km: Math.min(...slots.map((v) => v.km)),
      minPrice: Math.min(...slots.map((v) => v.price)),
      maxPrice: Math.max(...slots.map((v) => v.price)),
      from: slots.reduce((min, v) => (v.from < min ? v.from : min), slots[0].from),
    });
  }
  hits.sort(SORTS[filters.sort] ?? SORTS.distance);
  return hits;
};

// ------------------------------------------------------------- rendering

const venueCell = (v) => {
  const venue = VENUES.get(v.venue);
  const dir = `https://www.google.com/maps/dir/?api=1&origin=${DATA.home.lat},${DATA.home.lon}`
    + `&destination=${venue.lat},${venue.lon}`;
  return el("td", {},
    el("a", { href: dir, target: "_blank", rel: "noopener noreferrer", textContent: venue.name }),
    el("div", { className: "venue-sub", textContent: [venue.street, venue.city].filter(Boolean).join(", ") }),
  );
};

const richText = (html) => {
  const div = el("div", { className: "desc" });
  div.innerHTML = html;
  for (const a of div.querySelectorAll("a")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  return div;
};

const plainText = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();

const noteLine = (caption, html) => el("p", { className: "note" },
  el("b", { textContent: `${caption}: ` }), plainText(html));

// A merged card can carry several provider blurbs. Entries that no visible
// date belongs to are dropped; what is left is shared across the card only if
// a single entry covers everything — otherwise it belongs on the date rows.
const visibleEntries = (list, slots) => {
  const kept = list.filter((e) => e.nrs.some((nr) => slots.some((v) => v.nr === nr)));
  return kept.length ? kept : list;
};

const splitDetails = (details, slots) => {
  const shared = {}, perRow = {};
  for (const field of ["texts", "bring", "notes"]) {
    const kept = visibleEntries(details[field], slots);
    if (kept.length <= 1) shared[field] = kept[0]?.value ?? "";
    else perRow[field] = kept;
  }
  return { shared, perRow };
};

const rowDetail = (perRow, nr) => {
  const pick = (field) => perRow[field]?.find((e) => e.nrs.includes(nr))?.value ?? "";
  const [text, bring, notes] = ["texts", "bring", "notes"].map(pick);
  if (!text && !bring && !notes) return null;
  return el("div", { className: "row-detail" },
    text ? richText(text) : null,
    bring ? noteLine("Bring", bring) : null,
    notes ? noteLine("Note", notes) : null,
  );
};

const slotTable = (slots, group, perRow) => {
  const expandable = Object.keys(perRow).length > 0;
  const columns = ["No.", "Week", "Dates", "Time", group.mixedAges ? "Born" : null,
    group.mixedLevels ? "Level" : null, "Venue", "Distance", "Price", "Registration", ""]
    .filter((h) => h !== null);
  const head = el("tr", {}, columns.map((h) => el("th", {
    textContent: h,
    className: ["Distance", "Price"].includes(h) ? "num" : "",
  })));

  const body = el("tbody", {});
  for (const v of slots) {
    const detail = expandable ? rowDetail(perRow, v.nr) : null;
    const isOpen = openSlots.has(v.id);
    const row = el("tr", { className: [detail ? "expandable" : "", v.bookable ? "" : "closed"].join(" ").trim() },
      el("td", {}, detail ? el("span", { className: "caret", textContent: isOpen ? "▾ " : "▸ " }) : null, v.nr),
      el("td", { textContent: DATA.weeks.find((w) => w.id === v.weekId)?.label ?? "" }),
      el("td", { textContent: v.dates }),
      el("td", { textContent: [v.days, v.time].filter(Boolean).join(", ") }),
      group.mixedAges ? el("td", { textContent: v.age }) : null,
      group.mixedLevels ? el("td", { textContent: v.level || "—" }) : null,
      venueCell(v),
      el("td", { className: "num", textContent: km(v.km) }),
      el("td", { className: "num", textContent: money(v.price) }),
      el("td", {},
        el("div", { textContent: v.status }),
        v.deadline ? el("div", { className: "venue-sub", textContent: `Deadline ${day(v.deadline)}` }) : null,
        v.free ? null : el("div", { className: "venue-sub", textContent: "no places left" }),
      ),
      el("td", {}, el("a", {
        href: BOOKING(v.id), target: "_blank", rel: "noopener noreferrer", textContent: "Details ↗",
      })),
    );
    if (detail) {
      row.onclick = (e) => {
        if (e.target.closest("a")) return;
        if (openSlots.has(v.id)) openSlots.delete(v.id); else openSlots.add(v.id);
        render();
      };
    }
    body.append(row);
    if (detail && isOpen) {
      body.append(el("tr", { className: "detail-row" },
        el("td", { colSpan: columns.length }, detail)));
    }
  }
  return el("table", { className: "slots" }, el("thead", {}, head), body);
};

const describe = (shared) => [
  shared.texts ? richText(shared.texts) : null,
  shared.bring ? noteLine("Bring", shared.bring) : null,
  shared.notes ? noteLine("Note", shared.notes) : null,
].filter(Boolean);

const card = (hit) => {
  const { g, slots } = hit;
  const isFav = favorites.has(g.id);
  const open = expanded.has(g.id);

  const star = el("button", {
    className: "star", type: "button", textContent: isFav ? "★" : "☆",
    title: isFav ? "Remove from favourites" : "Save as favourite",
  });
  star.setAttribute("aria-pressed", String(isFav));
  star.onclick = (e) => {
    e.stopPropagation();
    if (isFav) favorites.delete(g.id); else favorites.add(g.id);
    persistFavorites();
    render();
  };

  const toggle = el("button", { type: "button", textContent: g.title });
  toggle.onclick = () => {
    if (expanded.has(g.id)) expanded.delete(g.id); else expanded.add(g.id);
    render();
  };

  const tags = [
    el("span", { className: "tag", textContent: g.category }),
    g.activity !== "—" && g.activity !== g.category
      ? el("span", { className: "tag plain", textContent: g.activity }) : null,
    el("span", { className: "tag plain", textContent: `Jg. ${g.ageLabel}` }),
    g.gender === "Mädchen" ? el("span", { className: "tag girls", textContent: "nur Mädchen" }) : null,
    g.level ? el("span", { className: "tag plain", textContent: g.level }) : null,
  ];

  const price = hit.minPrice === hit.maxPrice ? money(hit.minPrice)
    : `${money(hit.minPrice)}–${money(hit.maxPrice)}`;
  const hidden = g.variants.length - slots.length;

  const head = el("div", { className: "card-head" },
    star,
    el("div", {},
      el("h2", { className: "card-title" }, toggle),
      el("div", { className: "tags" }, tags),
    ),
    el("div", { className: "card-facts" },
      el("strong", { textContent: price }),
      el("div", { textContent: `${km(hit.km)} · ${plural(slots.length, "date", "dates")}` }),
      hidden > 0 ? el("div", { textContent: `${hidden} filtered out` }) : null,
    ),
  );
  // The title button handles its own click; anywhere else in the header toggles too.
  head.onclick = (e) => { if (!e.target.closest("button, a")) toggle.click(); };

  const { shared, perRow } = splitDetails(g.details, slots);
  const body = open ? el("div", { className: "card-body" },
    describe(shared),
    slotTable(slots, g, perRow),
  ) : null;

  return el("article", { className: `card${isFav ? " fav" : ""}` }, head, body);
};

const render = () => {
  const hits = collect();
  const slotTotal = hits.reduce((n, h) => n + h.slots.length, 0);
  $("count").textContent = `${plural(hits.length, "course", "courses")} · ${plural(slotTotal, "date", "dates")}`;
  $("fav-count").textContent = String(favorites.size);
  const active = activeFilterCount();
  $("active-count").textContent = active ? String(active) : "";
  $("expand-all").textContent = hits.length && hits.every((h) => expanded.has(h.g.id))
    ? "Collapse dates" : "Show all dates";

  const out = $("results");
  out.replaceChildren();
  if (!hits.length) {
    // Never a bare blank page: say what is filtering everything out and offer
    // the way back, so restored state can't look like a broken app.
    const clear = el("button", { className: "ghost", type: "button", textContent: "Clear all filters" });
    clear.onclick = () => $("reset").click();
    out.append(el("div", { className: "empty" },
      el("p", { textContent: "No courses match these filters." }),
      active ? el("p", { className: "empty-detail", textContent: `${plural(active, "filter is", "filters are")} active.` }) : null,
      clear,
    ));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const hit of hits) frag.append(card(hit));
  out.append(frag);
};

// ------------------------------------------------------------- wiring

const commit = () => {
  save(FILTER_KEY, { v: FILTER_SCHEMA, filters });
  syncLabels();
  render();
};

const syncLabels = () => {
  $("o-km").textContent = filters.km >= KM_ANY ? "any" : `≤ ${km(+filters.km)}`;
  $("o-price").textContent = filters.price >= PRICE_ANY ? "any" : `≤ ${money(+filters.price)}`;
};

const chipGroup = (host, entries, selected, onToggle) => {
  host.replaceChildren();
  for (const [value, label, count] of entries) {
    const chip = el("button", { className: "chip", type: "button" },
      label, el("span", { className: "n", textContent: String(count) }));
    chip.setAttribute("aria-pressed", String(selected.includes(value)));
    chip.onclick = () => onToggle(value);
    host.append(chip);
  }
};

const fillSelect = (node, options, value) => {
  node.replaceChildren(...options.map(([v, label]) => el("option", { value: v, textContent: label })));
  node.value = value;
};

const renderChips = () => {
  chipGroup($("f-weeks"), DATA.weeks.map((w) => [w.id, w.label, weekCounts.get(w.id) ?? 0]),
    filters.weeks, (v) => {
      filters.weeks = filters.weeks.includes(v) ? filters.weeks.filter((x) => x !== v) : [...filters.weeks, v];
      renderChips(); commit();
    });
  chipGroup($("f-cats"), [...categoryCounts].sort((a, b) => b[1] - a[1]).map(([c, n]) => [c, c, n]),
    filters.cats, (v) => {
      filters.cats = filters.cats.includes(v) ? filters.cats.filter((x) => x !== v) : [...filters.cats, v];
      renderChips(); commit();
    });
};

// Options never change, so they are built once; values are re-synced whenever
// the filter object is replaced wholesale (reset).
const buildControls = () => {
  fillSelect($("f-activity"),
    [["", "all"], ...[...activityCounts].sort((a, b) => a[0].localeCompare(b[0], "en"))
      .map(([a, n]) => [a, `${a} (${n})`])], filters.activity);
  fillSelect($("f-level"), [["", "all"], ...levels.map((l) => [l, l])], filters.level);
  fillSelect($("f-start"), [["", "any"], ...startTimes.map((t) => [t, `from ${clock(t)}`])], filters.start);
  fillSelect($("f-end"), [["", "any"], ...endTimes.map((t) => [t, `until ${clock(t)}`])], filters.end);
  $("years").replaceChildren(...years.map((y) => el("option", { value: String(y) })));

  const bind = (id, key, read = (n) => n.value, event = "input") =>
    $(id).addEventListener(event, (e) => { filters[key] = read(e.target); commit(); });

  bind("f-q", "q");
  bind("f-activity", "activity", (n) => n.value, "change");
  bind("f-level", "level", (n) => n.value, "change");
  bind("f-gender", "gender", (n) => n.value, "change");
  bind("f-start", "start", (n) => n.value, "change");
  bind("f-end", "end", (n) => n.value, "change");
  bind("f-sort", "sort", (n) => n.value, "change");
  bind("f-year", "year");
  bind("f-km", "km", (n) => +n.value);
  bind("f-price", "price", (n) => +n.value);
  bind("f-fav", "favOnly", (n) => n.checked, "change");
  bind("f-bookable", "bookable", (n) => n.checked, "change");

  $("reset").onclick = () => {
    Object.assign(filters, structuredClone(DEFAULTS));
    expanded.clear();
    syncControls();
    commit();
  };

  $("expand-all").onclick = () => {
    const hits = collect();
    const allOpen = hits.every((h) => expanded.has(h.g.id));
    expanded.clear();
    if (!allOpen) for (const h of hits) expanded.add(h.g.id);
    render();
  };
};

const syncControls = () => {
  renderChips();
  for (const [id, key] of [["f-q", "q"], ["f-activity", "activity"], ["f-level", "level"],
    ["f-gender", "gender"], ["f-start", "start"], ["f-end", "end"], ["f-sort", "sort"],
    ["f-year", "year"], ["f-km", "km"], ["f-price", "price"]]) {
    $(id).value = filters[key];
  }
  $("f-fav").checked = filters.favOnly;
  $("f-bookable").checked = filters.bookable;
  syncLabels();
};

$("home-label").textContent = DATA.home.label;
buildControls();
syncControls();
commit();
