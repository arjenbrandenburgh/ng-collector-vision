# Contributing to ng-collector-vision

Thank you for considering a contribution. This is a focused library — please open an issue before starting large work so we can align on scope and direction.

---

## Development setup

**Prerequisites:** Node.js 24+, npm 11+

```bash
git clone https://github.com/your-org/ng-collector-vision.git
cd ng-collector-vision
npm install
```

### Build + dev loop

```bash
# Build the library in watch mode (terminal 1)
ng build ng-collector-vision --watch

# Serve the demo app (terminal 2)
ng serve demo
# → http://localhost:4200
```

The demo app at `projects/demo/` is a working integration test of the library. It uses the Scryfall public API to enrich Magic card detections.

### Runtime assets

The demo's `angular.json` expects built lib assets at `dist/ng-collector-vision/collectorvision/`. The library ships:

- `collectorvision/scanner.worker.mjs` — CollectorVision inference worker
- `collectorvision/coi-serviceworker.js` — Cross-Origin Isolation service worker
- `collectorvision/vendor/onnxruntime-web/` — ONNX Runtime WASM backend

These are binary/large files committed directly. Keep them in sync with the upstream [CollectorVision](https://github.com/HanClinto/CollectorVision) release when bumping the dependency.

---

## Running tests

```bash
ng test ng-collector-vision
```

Tests run with Vitest via the Angular build system. No browser required — JSDOM is used.

---

## Code style

The project uses Prettier for formatting:

```bash
# Check
npx prettier --check .

# Fix
npx prettier --write .
```

TypeScript is checked strictly — no `any`, `!` non-null assertions only where genuinely safe.

---

## Project structure

```
projects/
├── ng-collector-vision/      # Library (published to npm)
│   ├── src/lib/
│   │   ├── card-scanner/     # Main component (ts + html + scss)
│   │   ├── confirmation-bucket.ts
│   │   ├── constants.ts
│   │   ├── tokens.ts
│   │   └── types.ts
│   └── collectorvision/      # Bundled CollectorVision runtime assets
└── demo/                     # Integration demo (not published)
    └── src/app/
```

---

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep PRs focused — one feature or fix per PR.
3. Update the `README.md` inputs table if you add or change a component input.
4. Run `ng test ng-collector-vision` and `npx prettier --check .` before pushing.
5. CI must pass before merge.

---

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **patch** — bug fixes, no API changes
- **minor** — new inputs/outputs, backward-compatible
- **major** — breaking API changes

Releases are created by pushing a `v*.*.*` tag to `main`. GitHub Actions builds and publishes to npm automatically.

---

## Attribution

This library wraps [CollectorVision](https://github.com/HanClinto/CollectorVision) by [@HanClinto](https://github.com/HanClinto). The models, worker script, and catalogs are CollectorVision's work — please credit and respect the AGPL-3.0 license that governs them.
