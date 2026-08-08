# zurich-ferienkurse-herbst-2026

Static browser for the Stadt Zürich autumn 2026 holiday courses. `build.mjs`
reads the cached API responses in `cache/`, groups course slots into cards,
geocodes venues, and inlines data + CSS + JS into a single `index.html`, which
is what GitHub Pages serves.

    node build.mjs            # rebuild index.html from cache/ (offline, <1s)
    node build.mjs --refetch  # re-pull the API into cache/ first

Live: https://joaomoreno.github.io/zurich-ferienkurse-herbst-2026/
Pages is served from `main`, path `/`.

## "push" means

When the user says *push*, do all of it without asking for confirmation:

1. Rebuild if any source changed (`build.mjs`, `src/`), so the committed
   `index.html` matches the sources.
2. Commit everything relevant.
3. `git push` to `origin main`.
4. Wait for the GitHub Pages deployment of *that commit* to finish — poll
   `gh api repos/joaomoreno/zurich-ferienkurse-herbst-2026/pages/builds/latest`
   until `.commit` is the pushed SHA and `.status` is `built`.
5. Verify the live URL actually serves the new bytes; do not report success
   from a green build alone.

## Notes

- `data.json` is git-ignored: it is the same payload already inlined into
  `index.html`. `index.html` is the deployed artifact and *is* committed.
- `cache/translations.json` is authored, not fetched. A missing entry is a hard
  build error rather than a German string leaking into the English UI.
- Distances are computed in the browser, not at build time. `DEFAULT_HOME` in
  `build.mjs` is only the fallback origin shipped in the payload; a visitor can
  set their own address (geocoded against api3.geo.admin.ch, persisted under
  `zurich-holiday-courses:home`), and every `km` value, the distance filter,
  the distance sort and the Google Maps links follow it.
- Every expanded course card carries a map of home plus the venues its still
  visible dates use. It is not Leaflet and not the OSM iframe embed (that one
  only reads a single `marker` parameter): `drawMap` in `src/app.js` lays out
  the raster tiles that cover the box and positions the pins itself, so
  `tile.openstreetmap.org` is the only runtime dependency it adds. Tiles are
  built lazily — a map stays an empty box until it comes within 300px of the
  viewport — because "Show all dates" opens every card at once.
- Only `ferientypId === 3` (autumn) is in scope; summer is filtered out at the
  top of the pipeline in `build.mjs`.
