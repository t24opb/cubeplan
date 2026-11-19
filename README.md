# CubePlanner (website prototype)

Builds container loads from the cartons the CubePlanner iPhone app measures, and
shows what it would take to fill every container properly.

- **Products** — the library on the left: every carton you have, with a small
  drawing of it. Drag one into the order (or press +) and the page offers
  the number of cartons that fit in the space left.
- **Order** — the products in this load, with carton size, weight and quantity. Import the app's
  "Export all products as JSON" file (Settings → Business API), or a CSV with
  a header row: name, sku, length, width, height (cm), weight (kg), quantity.
- **Rules** — which container types may be used, the minimum fill every
  container must reach, how far quantities may change (overall, or per
  product), and locked products whose quantity never changes.
- **Options** — *As ordered*, *Top up* (extra cartons in the gaps) and *Trim*
  (fewer cartons so a container is saved). The suggested one is the option
  that meets the minimum fill with the least change to the order.
- **3D** — the loaded container and each carton, turning, like the app.

- **Business accounts** — Sign in (a link is emailed; no password) to work in
  your business. Everyone in the business sees the same products, and an
  admin invites colleagues by email. Without signing in, the site works on its
  own with the example. See `supabase/README.md`.

## Run it

It is a static site: no build step, no server code.

    python3 -m http.server 8173 --directory website

then open http://localhost:8173. (three.js and the fonts load from the
internet.)

## Files

| File | What it holds |
| --- | --- |
| `index.html`, `styles.css` | The page |
| `js/packer.js` | Packing and optimising. Pure logic, runs in Node too |
| `js/data.js` | Container sizes (same as the app's), the example order, file import |
| `js/scene.js` | The 3D views |
| `js/app.js` | The page's behaviour |
| `js/cloud.js`, `js/config.js` | Business accounts: sign-in and shared products (Supabase) |
| `supabase/schema.sql` | The accounts database: tables and who may see what |
| `tests/packer.test.js` | `node website/tests/packer.test.js` |
| `tests/bench.js` | How full containers get on 200 made-up furniture orders |
| `tools/build_single_page.py` | Writes `dist/container-builder.html`, the one-file version |

## Not built yet

Palletised loads (cartons on pallets, pallets in the container), saving
orders and plans to the business account (they stay in the browser), a live link from the app, weight distribution and
load restraint checks.
