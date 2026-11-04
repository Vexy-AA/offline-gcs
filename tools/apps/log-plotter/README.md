# DataFlash Log Plotter: source

The page is plain HTML, CSS and JavaScript with no build tools beyond one Python script.
Edit the files in `src/`, then run:

```
python3 build.py
```

In this repository the page is served by the tools service at `/log-plotter`, from its own
copy, `tools/gcs_tools/static/apps/log-plotter.html` (built with the station's hook, below).
`python3 build.py` updates that copy too, so after changing `src/` run it once and reload
`/log-plotter`; `--no-station` leaves the copy alone. (`tools/tests/smoke_test.sh` checks that
the copy matches what `src/` builds.)

Without `--host-script` it writes two files to `out/`:

- `dataflash-log-plotter.html`: the offline file. Fonts, three.js, the geoid grid and all code are inside it.
- `dataflash-log-plotter.artifact.html`: the same page for hosting, loading three.js from the jsDelivr CDN.

## Files

| File | What it does |
|---|---|
| `src/core.js` | Reads ArduPilot `.bin` logs in chunks (FMT, FMTU, UNIT, PARM, MSG, MODE, ARM, ERR…) into typed arrays per message and instance. Also builds the demo log. |
| `src/expr.js` | The formula language: tokenizer, parser, evaluation over whole fields, time alignment, every function and its help text, and the spectrum (Welch FFT). |
| `src/geo.js` | WGS84 ellipsoid and sphere maths, the local 3D frame, web-mercator tiles, and EGM96 geoid heights from `src/geoid1deg.b64` (1° grid). |
| `src/app1.js` | Page state, number formatting, the graph and field model, undo, automatic Y-axis grouping, templates. |
| `src/app2.js` | Graph cards, field rows, formula editing, autocomplete, the ƒx menu. |
| `src/app3.js` | Drawing: time graphs, spectra, cursor and selection overlays, the whole-log strip, live values and statistics. |
| `src/app4.js` | Mouse and keyboard, the side panel, help, menus, export, opening logs. |
| `src/app5.js` | 3D: position and attitude sources, built-in models, model files, XYZ imagery and quantized-mesh terrain tiles. |
| `src/app6.js` | 3D: the scene, paths, vehicle, camera, playback and the settings panel. |
| `src/app7.js` | Start-up. |
| `src/style.css`, `src/body.html` | Look and page structure. |
| `vendor/` | three.js r147 and its glTF/OBJ/STL loaders and thick lines (MIT licence). |
| `fonts/` | Barlow, Barlow Semi Condensed and JetBrains Mono, subset to Latin (SIL Open Font License). |

The geoid grid was made from the `egm96-universal` package (MIT), which uses the NGA EGM96 data.

## Hosting it with your own map and terrain

A page that hosts the plotter can offer its own imagery and terrain. Build with
`--host-script URL`: the page then loads that script first, and the script sets

```js
window.DFPLOT_HOST = {
  imagery: { 'gcs-custom': { label: 'This ground station: custom.mbtiles',
                             url: '/tiles/custom/{z}/{x}/{y}.png', max: 17, attr: 'custom.mbtiles' } },
  defaults: { imagery: 'gcs-custom', terrain: true, terrainUrl: '/quantized/layer.json', terrainMsl: true }
};
```

The imagery is listed first under Map, and the defaults apply to new 3D views (only keys
the 3D view already has, with the same type). If the script is missing, as when the file
is opened from disk, the page works exactly as before. The ground station serves this
script at `/log-plotter/config.js`, built from what is in `data/mbtiles` and
`data/terrain`, and passes `/tiles/` and `/quantized/` through to its tile and terrain
servers on its own origin, because the plotter fetches them with CORS.
