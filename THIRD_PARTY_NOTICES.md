# Third-party notices

This extension bundles data and code from the following open-source projects.

**Every bundled npm dependency is attributed in [`licenses/THIRD_PARTY_LICENSES.md`](licenses/THIRD_PARTY_LICENSES.md)** — a generated appendix carrying the license text and copyright line of each package esbuild inlines into `dist/`. This file is the hand-written companion to it: it covers the bundled *data* (dictionaries and curated word lists, which are not npm packages and so cannot be generated from a manifest), and it records the choices the generator cannot make on its own.

## DOMPurify — license election

DOMPurify is offered under `(MPL-2.0 OR Apache-2.0)`. That is a dual license, not an ambiguity: the recipient elects one and the other stops applying. **We elect the Apache-2.0 grant.** MPL-2.0 §3.2 would attach a standing source-availability duty to every copy we distribute — for a dependency we bundle unmodified, that buys nothing, while Apache-2.0 asks only for the license text and the retained notices, which the generated appendix already reproduces (as it does for the other Apache-2.0 packages, Harper and mathjs). The election is recorded in machine-readable form in `scripts/generate-third-party-notices.mjs`, and `shared/__tests__/thirdPartyNotices.test.ts` fails if upstream ever changes the offer.

## Graphviz — embedded in an Apache-2.0 package

`@hpcc-js/wasm-graphviz` declares Apache-2.0, ships the Apache text, and mentions Graphviz nowhere in the package. What it delivers, though, is **Graphviz itself**, compiled to WebAssembly and inlined into its single `dist/index.js` — the bundle exposes `CGraphviz` and the full `dot`/`neato`/`fdp`/`sfdp`/`circo`/`twopi`/`osage`/`patchwork` engine set. Graphviz is licensed under the **Eclipse Public License v1.0**. hpcc's Apache grant covers hpcc's own wrapper; it cannot relicense the library inside it, and we redistribute that object code inlined in `dist/`.

We reach Graphviz through PlantUML: nine of its diagram families (class, state, component, deployment, use case, object, ERD, DOT, ArchiMate) are laid out by Graphviz rather than by PlantUML's own layout engine.

A verbatim copy of the EPL-1.0, taken from the Graphviz project's own `LICENSE`, ships with this extension at [`licenses/graphviz-EPL-1.0.txt`](licenses/graphviz-EPL-1.0.txt). Graphviz is bundled unmodified; its source is at https://gitlab.com/graphviz/graphviz and https://graphviz.org.

This is the case that showed the generated appendix has a blind spot. It reads what each package's own manifest and license file declare, which makes a package that vendors a foreign library into its published artifact invisible: the manifest is entirely self-consistent, and the second license lives one layer below anything the generator inspects. Known cases are now recorded in `EMBEDDED_COMPONENTS` in `scripts/generate-third-party-notices.mjs`, printed on the package's own entry and in an "Embedded components" section, and guarded by `shared/__tests__/thirdPartyNotices.test.ts`. Known is the operative word — the mechanism records what someone looked for and found, and cannot discover the next one. Looking is `pnpm notices:audit` (`scripts/audit-embedded-components.mjs`): it sweeps every bundled package for the shapes that carry embedded code (WebAssembly, font files, vendor directories, license files that disagree with the manifest, big inputs with someone else's copyright line) and prints candidates for a person to judge. Its first full pass over the bundle found the four cases below.

## KaTeX fonts — SIL Open Font License inside an MIT package

`katex` is MIT, and that covers KaTeX the program. The twelve KaTeX font families are not code: each font file's own name table says SIL Open Font License 1.1, copyright Design Science, Inc. (MathJax) and Khan Academy, with the `KaTeX_*` names reserved. Our build inlines all twenty WOFF2 files as data URLs into `katex.css`, so we redistribute the fonts, and the OFL asks that each copy carry the copyright notice and the license text. Both ship at [`licenses/katex-fonts-OFL-1.1.txt`](licenses/katex-fonts-OFL-1.1.txt). The fonts are bundled unmodified and under their reserved names, which is what the OFL permits.

## cytoscape — two MIT snippets by other authors

`cytoscape` (MIT, The Cytoscape Consortium) inlines into its published `dist` a Promises/A+ thenable by Ralf S. Engelschall and a bezier-easing generator by Gaetan Renaudeau, each under its author's own MIT notice. Those notices live in `/*! */` comments, which minification removes from our bundle, and cytoscape's LICENSE file names only the Consortium. MIT wants the notice in every copy, so both are reproduced at [`licenses/cytoscape-embedded-MIT.txt`](licenses/cytoscape-embedded-MIT.txt). Same license family as the parent; this is about the notice, not the terms.

## ColorBrewer and GeographicLib — a second license stated in the parent's own LICENSE

Two of the d3 packages mermaid pulls in carry a second license after their own ISC grant, in their LICENSE file, which the generated appendix reproduces whole. `d3-scale-chromatic` embeds the ColorBrewer color schemes, Apache-2.0, copyright Cynthia Brewer, Mark Harrower, and The Pennsylvania State University; because Apache-2.0 asks that a copy of the License accompany the work, the full text ships at [`licenses/colorbrewer-Apache-2.0.txt`](licenses/colorbrewer-Apache-2.0.txt) with the notice. `d3-geo` ports GeographicLib's geodesic code under Charles Karney's MIT notice; the reproduced LICENSE already carries it and MIT asks nothing more, so no separate file ships and the guard checks the reproduced text for the notice instead. Both are recorded in `EMBEDDED_COMPONENTS` so the summary table, which counts declared licenses, does not present either package as ISC and nothing else.

Inspected in the same pass and left as they are: `@mermaid-js/parser` inlines a lodash custom build, whose notice the appendix already carries under `lodash-es`; `@iconify/utils` ships an SPDX table of icon-set licenses as data, not embedded code; `d3-ease` carries Robert Penner's easing equations under the same BSD-3-Clause as the package, notice reproduced; Harper's WASM carries its curated dictionary, whose original import is not attributed upstream, and it ships under Harper's Apache-2.0 as its authors publish it.

## PlantUML engine — and the `License GPL` string in our bundle

Diagrams are rendered by [`plantuml-little`](https://github.com/Actrium/supramark/tree/main/crates/plantuml-little), an **independent Rust reimplementation** of PlantUML compiled to WebAssembly (npm: `@kookyleo/plantuml-little-web`). It is offered under five licenses at the recipient's choice — GPL-3.0-or-later, LGPL-3.0-or-later, Apache-2.0, EPL-2.0, or MIT — mirroring upstream PlantUML's own multi-license scheme. **We elect MIT**, recorded in machine-readable form in `scripts/generate-third-party-notices.mjs` and guarded by `shared/__tests__/thirdPartyNotices.test.ts`.

Its upstream `UPSTREAM.md` states plainly that **no upstream Java source files were copied**: the parity target is byte-exact SVG *output*, not source lineage. That is what makes the MIT arm the author's to offer.

**If you are auditing our bundle and found the string `License GPL`, this is the explanation.** `dist/` contains, verbatim:

```
PlantUML version 1.2026.2 / bb8550d [2026-02-27 17:45:29 UTC]
License GPL
```

That is upstream PlantUML's own **version banner, reproduced as output data** — a diagram asking for `version` must print what upstream prints, byte for byte, which is the whole point of the reimplementation. It is a string the engine can emit into an SVG, not a license grant, and not evidence that any GPL code is present. The engine we ship is the Rust reimplementation under the MIT election above.

One related point on what is *not* bundled: upstream vendors PlantUML's standard library (sprites and includes), some of which carries upstream PlantUML's own GPL/LGPL terms. That content is **not** in the WebAssembly artifact we ship — the binary contains the sprite *renderer* and an `stdlib include not found` error path, not the sprite data. A diagram using `!include <archimate/...>` fails rather than rendering.

## Harper

Offline grammar and spell checker (`harper.js` + `harper_wasm_bg.wasm`, bundled into the extension host — the WASM binary carries Harper's curated dictionary). https://github.com/Automattic/harper — Apache License 2.0, Copyright 2024 Elijah Potter (a project of Automattic). Harper is bundled unmodified. A verbatim copy of its Apache-2.0 license, including the copyright notice, ships with this extension at `licenses/harper.js-Apache-2.0.txt`; the full text is also at https://www.apache.org/licenses/LICENSE-2.0.

## no-cliches

Cliché phrase list, merged into the style-check word lists. https://github.com/duereg/no-cliches — MIT License, © Matt Blair.

## proselint

Garner redundancy phrase data, merged into the style-check word lists. https://github.com/amperser/proselint — BSD 3-Clause License, © Amperser Labs.

## weasels / hedges (retext ecosystem)

A hand-curated subset of entries merged into the filler word list. https://github.com/words/weasels, https://github.com/words/hedges — MIT License, © Titus Wormer.

## retext-repeated-words

The repeated-word exception list ("had had", "that that", …). https://github.com/retextjs/retext-repeated-words — MIT License, © Titus Wormer.

## write-good

Seeds for the wordiness list and the passive-voice / structural prose checks. https://github.com/btford/write-good — MIT License, © Brian Ford.

## slop-gate

Seeds for the AI-vocabulary and AI-artifact word lists (the LLM-ism checks). Curated MIT-clean; cross-checked against, but not copied from, the CC-BY-SA Wikipedia "Signs of AI writing" catalogue. https://github.com/hwajongpark/slop-gate — MIT License.
