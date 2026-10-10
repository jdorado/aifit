# AIFit design system

Concept: **a training journal that talks back.** Warm paper, blue-black ink,
one cobalt for the brand and one volt highlight reserved for "done / now".
Editorial serif for headlines and hero numerals, a clean grotesk for UI, mono for
labels, counts, loads and timers.

## Where it lives

| Path | Role |
| --- | --- |
| `web/src/design/tokens.css` | Colour, type, radius, shadow and motion tokens (`--ds-*`); light and dark |
| `web/src/design/base.css` | Canvas, type defaults, focus ring, reduced motion |
| `web/src/design/core.css` | Entry-chunk styles: tokens, base, landing (first paint) |
| `web/src/design/app.css` | Signed-in surfaces: chrome, workout, detail, chat, profile, sheets |
| `web/src/style.css` | **Legacy** styles, wrapped in `@layer legacy` |

The legacy stylesheet sits in a lower-priority cascade layer: everything in
`src/design/` is unlayered, so it always beats legacy rules regardless of specificity. Restyle by
writing a plain rule in `src/design/`; when a legacy rule becomes dead, delete it.
`core.css` loads with the entry chunk; `style.css` and `app.css` load with the
lazy auth/app chunk (`src/AuthGate.tsx`), which is why the landing paints from a
small bundle.

## Rules

- Use `var(--ds-*)` only; no hard-coded colours, so dark theme just works.
- **Volt** fills carry ink (check marks, chips, the live set, the "Now" bar). Thin
  rules and meters use `--ds-progress` (cobalt in light, volt in dark): volt on
  paper is about 1.1:1.
- Fonts: `--ds-font-display` (Instrument Serif), `--ds-font-ui` (Geist),
  `--ds-font-num` (Geist Mono, tabular figures).
- Touch targets are 44px or larger; text contrast is 4.5:1 or better; every
  animation must respect `prefers-reduced-motion` (a global kill-switch exists).
- Navigation is the labelled bottom dock; the keyboard hides it
  (`:root[data-keyboard-open='true']`).
- Dark theme follows the system: an inline script in `public/index.html` sets
  `<html data-theme="dark|light">` before first paint. Surface-specific dark tweaks
  select on `:root[data-theme='dark']`.

## Previewing and auditing without signing in

`web/design-preview/` is a local-only harness: a mock API plus a stub of the auth
SDK, so every screen renders with realistic data and no credentials.

```sh
cd web
node design-preview/mock-api.cjs                     # mock API on :8199
node node_modules/webpack-cli/bin/cli.js serve \
  --config design-preview/webpack.config.cjs --mode development --port 5301
```

Open `http://127.0.0.1:5301` (signed in) or `?landing=1` (signed-out landing,
`?landing=loading` for the loading state). Extra mock routes live in
`design-preview/routes/*.cjs`. Nothing here ships: the build output goes to
`web/dist-preview/` (ignored) and the production config never imports it.

Checks used for this design pass: `pnpm --dir web build` (all contract smokes, `tsc`,
production bundle), axe-core on every main screen in both themes, and Lighthouse on
a production build of the landing.
