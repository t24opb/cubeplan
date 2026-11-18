# SmartPallet Container Builder (website prototype)

Builds container loads from the cartons the SmartPallet app measures, and
shows what it would take to fill every container properly.

- **Order** — products with carton size, weight and quantity. Import the app's
  "Export all products as JSON" file (Settings → Business API), or a CSV with
  a header row: name, sku, length, width, height (cm), weight (kg), quantity.
- **Rules** — which container types may be used, the minimum fill every
  container must reach, how far quantities may change (overall, or per
  product), and locked products whose quantity never changes.
- **Options** — *As ordered*, *Top up* (extra cartons in the gaps) and *Trim*
  (fewer cartons so a container is saved). The suggested one is the option
  that meets the minimum fill with the least change to the order.
- **3D** — the loaded container and each carton, turning, like the app.

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
| `tests/packer.test.js` | `node website/tests/packer.test.js` |
| `tests/bench.js` | How full containers get on 200 made-up furniture orders |
| `tools/build_single_page.py` | Writes `dist/container-builder.html`, the one-file version |

## Not built yet

Palletised loads (cartons on pallets, pallets in the container), accounts and
saving plans to a server, a live link from the app, weight distribution and
load restraint checks.
