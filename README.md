# PokeVault

Personal Pokemon card collection app — catalog cards with front/back photos,
get a best-effort grade estimate (centering + corners), track raw-card values
from the free [pokemontcg.io](https://pokemontcg.io) API, and sort your
collection into keep / sell piles. Installs on iPhone as a PWA — no App Store.

All data stays on the device (IndexedDB). No backend, no accounts, no cost.

## Development

```sh
npm install
npm run dev        # dev server on :5173
npm run build      # type-check + production build with service worker
npm run preview    # serve the production build locally
```

## Deploying (Vercel free tier)

1. Push this repo to GitHub.
2. On vercel.com: **Add New Project** → import the repo. Vercel auto-detects
   Vite; the defaults (build `npm run build`, output `dist`) are correct.
3. Deploy. You get an `https://….vercel.app` URL — HTTPS is required for the
   PWA install and camera access.

Any static host works (Netlify, GitHub Pages, Cloudflare Pages).

## Installing on iPhone

1. Open the deployed URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Launch from the home-screen icon (runs fullscreen, works offline).

## First-run setup

1. Get a free API key at **dev.pokemontcg.io** (raises the limit to 20,000
   requests/day — a 3000-card daily refresh uses a fraction of that).
2. Paste it in the app under **Settings**.

## Card identification

Photos are identified by two engines whose scores are merged: a perceptual
image match against every card's official artwork (fingerprints ship in
`public/card-hashes.json`, ~1MB), and on-device OCR of the name + collector
number. Rebuild the fingerprint file to pick up newly released sets:

```sh
node scripts/build-hash-db.mjs   # ~30-60 min, resumable, then commit + push
```

## Notes

- **Prices** are TCGplayer market prices for *raw* (ungraded) near-mint cards,
  per variant (holo, reverse holo, …). Price history accumulates on-device:
  a snapshot per card per day, taken automatically when the app is opened
  (at most once per ~20h). iOS PWAs cannot refresh in the background.
- **Grade estimates** analyze centering (border ratios, PSA-style thresholds)
  and corner whitening from the front photo. Surface/edge wear is not
  analyzed — treat grades as a rough range for valuing, never as a real grade.
  Best results: plain contrasting background, even light, card fills the guide.
- **Swapping price sources** later (PriceCharting, Scrydex): all API access
  goes through `src/api/pokemonTcg.ts`; replace that module and keep the shape.
