#!/usr/bin/env node
/**
 * Generate the third-party attribution appendix for everything the VSIX ships.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vsce package --no-dependencies` ships no `node_modules`: every dependency is
 * inlined by esbuild into `dist/extension.js` and `dist/webview.js` (+ chunks).
 * That is still redistribution, and every license in the tree asks something in
 * return for it:
 *
 *   - MIT / ISC  — "this notice shall be included in all copies or substantial
 *                  portions of the Software"
 *   - BSD-3      — binary redistribution must reproduce the copyright notice
 *                  "in the documentation and/or other materials"
 *   - Apache-2.0 — §4(a) hand recipients a copy of the License, §4(d) reproduce
 *                  any NOTICE file the package ships
 *
 * Minification strips the header comments that would otherwise carry those
 * notices (the production bundles contain zero `@license` blocks), so the
 * obligation has to be met by a file that ships alongside them. This generator
 * writes that file.
 *
 * WHAT IT ATTRIBUTES
 * ------------------
 * The set of packages esbuild actually inlined — read from the two metafiles,
 * NOT from the dependency closure. Tree-shaking is why that distinction matters:
 * the production closure is ~263 packages, of which ~170 reach a bundle. The
 * rest (mathjs's `chevrotain` parser, for instance) are resolved but never
 * emitted, and attributing them would claim we ship code we do not.
 *
 * Run `node esbuild.mjs --production --metafile` first — this reads what that
 * writes, so a stale dist/ silently attributes a stale bundle.
 *
 * USAGE
 *   pnpm notices          # production build + write the file
 *   pnpm notices:check    # production build + verify it is current
 *
 *   node scripts/generate-third-party-notices.mjs [--check]   # reuse an existing build
 *
 * HEADS UP: the `pnpm` forms run a PRODUCTION build, which wipes `dist/` and
 * rebuilds it minified. If you are mid-session with a dev build loaded in an
 * Extension Development Host, that swaps the bundle under it — re-run
 * `pnpm build` afterwards. The bare `node` form touches nothing, and is the
 * right one when a production build with `--metafile` already exists (that is
 * what CI's `perf-bundle` job uses, since it has just built one).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_FILE = path.join(repoRoot, "licenses", "THIRD_PARTY_LICENSES.md");
// Every bundle we SHIP, because the appendix's claim is that it reports what
// the bundles inline. dist/diffView.js is a third entry point (the rendered
// diff panel) and was outside this list when it landed, which is a hole in
// that claim rather than a wrong answer: what it inlines is a subset of the
// webview's today, and nothing was checking that.
const METAFILES = ["dist/webview.meta.json", "dist/extension.meta.json", "dist/diffView.meta.json"];

/**
 * Licenses that let us ship a bundled binary at all. Anything outside this set
 * is a decision, not a detail: reciprocal terms (GPL/LGPL/AGPL) would reach the
 * whole bundle, and source-availability terms (MPL/EPL/CDDL) impose duties the
 * appendix alone does not discharge. The generator refuses rather than quietly
 * writing a file that implies the question was considered.
 *
 * This lists ONLY what the bundle actually contains today — deliberately, and it
 * is why the entries below are five rather than a dozen. An allowlist padded
 * with plausible-looking permissive licenses nobody has read (CC0's
 * public-domain dedication, Python-2.0's attribution quirks) pre-answers exactly
 * the question the paragraph above says must be answered, and does it for
 * licenses that are not even present. Adding one when a dependency needs it,
 * having read what it asks of a bundled redistribution, is the whole mechanism.
 */
export const ALLOWED_LICENSES = new Set([
    "MIT",
    "ISC",
    "Apache-2.0",
    "BSD-3-Clause",
    "Unlicense",
]);

/**
 * Dual-licensed packages, and which side we take.
 *
 * A dual license is an offer, not an ambiguity — the recipient elects one and
 * the other stops applying. Recording the election here is the point: a future
 * reader should not have to re-derive which half of "(MPL-2.0 OR Apache-2.0)"
 * this project relies on, and the appendix should print one license, not both.
 */
export const LICENSE_ELECTIONS = {
    // DOMPurify offers MPL-2.0 or Apache-2.0. We elect Apache-2.0.
    //
    // MPL-2.0 §3.2 would make us tell every recipient how to obtain the Source
    // Form of the Covered Software — a standing distribution duty attached to a
    // file we only ever bundle unmodified. Apache-2.0 asks for the license text
    // and the retained notices, which is exactly what this appendix already does
    // for harper.js and mathjs, the other two Apache-2.0 packages that reach a
    // bundle. Same permissions either way; one of them costs an ongoing
    // obligation.
    dompurify: {
        elected: "Apache-2.0",
        offered: "(MPL-2.0 OR Apache-2.0)",
        rationale:
            "Elected Apache-2.0. The MPL-2.0 alternative would attach a standing " +
            "source-availability duty (§3.2) to a dependency we bundle unmodified.",
    },

    // plantuml-little (the PlantUML rendering engine) is offered under five
    // licenses at the author's choice: GPL-3.0-or-later, LGPL-3.0-or-later,
    // Apache-2.0, EPL-2.0, or MIT. We elect MIT.
    //
    // This election is load-bearing rather than cosmetic. We ship a bundle
    // (`vsce package --no-dependencies`), so the engine is inlined into
    // `dist/webview.js`'s chunks as part of a single distributed artifact.
    // Under the GPL-3.0 arm that inlining would carry copyleft obligations to
    // the whole of Birta Writer, which is licensed FSL-1.1-ALv2 and could not
    // satisfy them. The LGPL arm would demand relinking freedom that a
    // base64-inlined wasm module inside a minified chunk does not offer. MIT
    // asks only for the notice reproduced below, which is what this appendix
    // exists to do — and it is the least restrictive of the five, so nothing is
    // given up by choosing it.
    "@kookyleo/plantuml-little-web": {
        elected: "MIT",
        // Verbatim as upstream declares it — the guard test compares this
        // string to the manifest so a relicence cannot slip past the election.
        offered: "GPL-3.0-or-later OR LGPL-3.0-or-later OR Apache-2.0 OR EPL-2.0 OR MIT",
        rationale:
            "Elected MIT. We inline the engine into a shipped bundle, which the " +
            "GPL-3.0 arm would extend copyleft over and the LGPL arm would " +
            "require relinking freedom for; MIT asks only for this notice.",
    },
};

/**
 * Packages that INLINE third-party code licensed differently from what they
 * themselves declare.
 *
 * This is the generator's structural blind spot, recorded rather than papered
 * over. Everything else here is derived from what a package's own manifest and
 * license file say. A package that vendors a foreign library into its published
 * artifact is invisible to that: its manifest is entirely self-consistent, and
 * the second license lives one layer below anything we read.
 *
 * Found the hard way. `@hpcc-js/wasm-graphviz` declares Apache-2.0, ships the
 * Apache text, and says nothing about Graphviz anywhere in the package — yet
 * what it exists to deliver is Graphviz itself, compiled to WebAssembly and
 * inlined into its single `dist/index.js` (the bundle exposes `CGraphviz` and
 * the full `dot`/`neato`/`fdp`/`sfdp`/`circo`/`twopi`/`osage`/`patchwork`
 * engine set). Graphviz is EPL-1.0. hpcc's Apache grant covers hpcc's wrapper;
 * it cannot relicense the library inside it, and we redistribute that object
 * code in `dist/`.
 *
 * Entries here are NOT added to ALLOWED_LICENSES. That set answers "may this
 * package's own license be bundled", and EPL is deliberately outside it: the
 * header above says source-availability terms impose duties the appendix alone
 * does not discharge, and that is exactly right. An embedded component is the
 * other question — the duty is discharged by the narrative notice in
 * THIRD_PARTY_NOTICES.md and the license text shipped at `licenseFile`, and
 * this map exists so the appendix POINTS at that rather than silently implying
 * the parent's license covers everything inside it.
 *
 * Adding an entry is a claim that someone looked. Removing a dependency without
 * removing its entry is caught by `thirdPartyNotices.test.ts`. Finding the next
 * one is `pnpm notices:audit` (scripts/audit-embedded-components.mjs), which
 * sweeps the bundled packages for the shapes that carry embedded code and
 * prints candidates for a human to judge; run it on a dependency add or bump.
 */
export const EMBEDDED_COMPONENTS = {
    "@hpcc-js/wasm-graphviz": {
        component: "Graphviz",
        spdx: "EPL-1.0",
        homepage: "https://graphviz.org",
        // Path relative to licenses/, shipped in the VSIX (see .vscodeignore).
        licenseFile: "graphviz-EPL-1.0.txt",
        note:
            "Compiled Graphviz, inlined as WebAssembly. The package declares Apache-2.0 " +
            "for its own wrapper and ships no Graphviz notice of its own.",
    },
    // The font files, not the code: `esbuild.mjs` inlines every KaTeX WOFF2 as
    // a data URL into katex.css, and each font's own name table says SIL OFL
    // 1.1 with Design Science and Khan Academy as copyright holders and the
    // KaTeX_* names reserved. The package's MIT LICENSE covers KaTeX the
    // program. OFL asks that each copy carry the copyright notice and the
    // license text, which is what the shipped file is.
    katex: {
        component: "the KaTeX fonts",
        spdx: "OFL-1.1",
        homepage: "https://katex.org",
        licenseFile: "katex-fonts-OFL-1.1.txt",
        note:
            "The KaTeX_* WOFF2 fonts inlined into katex.css are SIL Open Font License 1.1 " +
            "(copyright Design Science, Inc. and Khan Academy, Reserved Font Names KaTeX_*); " +
            "the package's MIT license covers the KaTeX code, not the font files.",
    },
    // Same license family as the parent, so this is about the notice, not the
    // terms: cytoscape's dist inlines two MIT snippets by other authors whose
    // copyright lines live only in `/*! */` comments, which minification strips
    // from our bundle. MIT wants the notice in every copy; the shipped file
    // carries both, and cytoscape's own LICENSE does not.
    cytoscape: {
        component: "two MIT snippets (thenable by Ralf S. Engelschall, bezier-easing by Gaetan Renaudeau)",
        spdx: "MIT",
        homepage: "https://github.com/rse/thenable and https://github.com/gre/bezier-easing",
        licenseFile: "cytoscape-embedded-MIT.txt",
        note:
            "cytoscape's published dist inlines a Promises/A+ thenable and a bezier-easing " +
            "generator under their authors' own MIT notices, carried only in source comments.",
    },
    // A second license inside an ISC package, discharged by the parent: d3-geo's
    // LICENSE carries Charles Karney's MIT notice (GeographicLib's geodesic
    // code) after its own ISC grant, and the appendix reproduces that file
    // whole, so nothing extra ships. The entry exists so the summary, which
    // counts declared licenses, does not read the package as ISC and nothing
    // else; `noticeInParentLicense` is what the guard checks the reproduced
    // text for.
    "d3-geo": {
        component: "GeographicLib geodesic code",
        spdx: "MIT",
        homepage: "https://geographiclib.sourceforge.io",
        licenseFile: null,
        noticeInParentLicense: "Copyright 2008-2012 Charles Karney",
        note:
            "d3-geo's geodesic routines are ported from GeographicLib under Charles Karney's " +
            "MIT notice, which the package's LICENSE states after its ISC grant.",
    },
    // A second license inside an ISC package: the ColorBrewer color schemes
    // are Apache-2.0 (Cynthia Brewer, Mark Harrower, Penn State). The package's
    // LICENSE carries the notice after its own ISC grant, so the appendix
    // already reproduces it; the entry makes the second license visible where
    // the summary counts declared licenses, and the shipped file adds the full
    // Apache text so a copy of the License accompanies the schemes.
    "d3-scale-chromatic": {
        component: "the ColorBrewer color schemes",
        spdx: "Apache-2.0",
        homepage: "https://colorbrewer2.org",
        licenseFile: "colorbrewer-Apache-2.0.txt",
        note:
            "The ColorBrewer color schemes are Apache-2.0 (copyright Cynthia Brewer, Mark Harrower, " +
            "and The Pennsylvania State University), stated in the package's LICENSE after its ISC grant.",
    },
};

/** Package directories that are ours, not third-party. */
const isWorkspacePackage = (name) => name.startsWith("@birta/");

/** Extract `name` from a bundler input path, handling pnpm's virtual store. */
function packageNameFromInput(input) {
    const marker = "node_modules/";
    const idx = input.lastIndexOf(marker);
    if (idx < 0) return null;
    let rest = input.slice(idx + marker.length);
    const scopedName = (p) => {
        const parts = p.split("/");
        return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    };
    // pnpm: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/… — the last
    // `node_modules/` already skipped the store prefix, so this only fires for
    // a `.pnpm` path that had no inner segment.
    if (rest.startsWith(".pnpm/")) {
        const inner = rest.indexOf("/node_modules/");
        if (inner < 0) return null;
        rest = rest.slice(inner + "/node_modules/".length);
    }
    return scopedName(rest);
}

/** Resolve a package's on-disk directory from a bundler input path. */
function packageDirFromInput(input, name) {
    const abs = path.resolve(repoRoot, input);
    const segments = name.split("/").length;
    let dir = path.dirname(abs);
    // Walk up until the directory tail matches the package name.
    while (dir !== path.dirname(dir)) {
        const tail = dir.split(path.sep).slice(-segments).join("/");
        if (tail === name) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

/** The SPDX id a package declares, normalized. */
function declaredLicense(pkg) {
    if (typeof pkg.license === "string") return pkg.license;
    if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type).join(" OR ");
    return null;
}

/**
 * The verbatim license text a package ships, if any.
 *
 * Preferred over a synthesized SPDX template because MIT/ISC/BSD all require
 * reproducing *that package's* copyright line, which only its own file carries.
 */
function readLicenseText(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const candidates = entries
        .filter((f) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(f))
        .sort((a, b) => a.length - b.length);
    for (const file of candidates) {
        const full = path.join(dir, file);
        try {
            if (!fs.statSync(full).isFile()) continue;
            const text = fs.readFileSync(full, "utf8").trim();
            if (text) return { file, text };
        } catch {
            /* unreadable — fall through to the next candidate */
        }
    }
    return null;
}

/**
 * Some packages ship no license file but carry the notice as a header comment
 * in their source (seedrandom does exactly this). That header IS the copyright
 * notice MIT asks us to reproduce, so prefer it over a synthesized template.
 */
function readLicenseHeaderFromSource(dir, manifest) {
    const candidates = [manifest.main, "index.js", `${path.basename(dir)}.js`].filter(Boolean);
    for (const rel of candidates) {
        const full = path.join(dir, rel);
        let src;
        try {
            if (!fs.statSync(full).isFile()) continue;
            src = fs.readFileSync(full, "utf8");
        } catch {
            continue;
        }
        // Collect leading block comments that carry a copyright line.
        const blocks = [...src.matchAll(/\/\*[\s\S]*?\*\//g)]
            .map((m) => m[0])
            .filter((b) => /copyright/i.test(b) && /permission|licen[cs]e/i.test(b));
        if (blocks.length) {
            const text = blocks
                .join("\n\n")
                .replace(/^[ \t]*\/\*+/gm, "")
                .replace(/\*+\/[ \t]*$/gm, "")
                .replace(/^[ \t]*\* ?/gm, "")
                .trim();
            if (text) return { file: rel, text, source: "header" };
        }
    }
    return null;
}

/**
 * Last resort for a package that declares a license but ships neither a license
 * file nor a source header: reproduce the standard text with the package's own
 * attribution. Marked as reconstructed in the output — we are not going to
 * present a template as if it were the package's verbatim file.
 */
const LICENSE_TEMPLATES = {
    MIT: (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
    ISC: (holder) => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};

/** The attribution to put in a reconstructed notice. */
function attributionFor(manifest) {
    const author =
        typeof manifest.author === "string" ? manifest.author : manifest.author?.name ?? null;
    return author ?? `the ${manifest.name} authors`;
}

/** An Apache-2.0 NOTICE file, which §4(d) requires us to reproduce. */
function readNoticeText(dir) {
    for (const file of ["NOTICE", "NOTICE.txt", "NOTICE.md"]) {
        const full = path.join(dir, file);
        try {
            if (fs.statSync(full).isFile()) {
                const text = fs.readFileSync(full, "utf8").trim();
                if (text) return text;
            }
        } catch {
            /* absent — normal */
        }
    }
    return null;
}

/** Best-effort copyright line, for packages whose license file we cannot read. */
function copyrightFrom(text) {
    if (!text) return null;
    const line = text.split("\n").find((l) => /copyright/i.test(l) && /\d{4}|©/.test(l));
    return line ? line.trim() : null;
}

function collect() {
    const missingMeta = METAFILES.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
    if (missingMeta.length) {
        console.error(
            `Missing ${missingMeta.join(", ")}.\n` +
                "Run `node esbuild.mjs --production --metafile` first — this reads what that writes.",
        );
        process.exit(2);
    }

    const bundled = new Map(); // name -> { dir }
    for (const metaPath of METAFILES) {
        const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, metaPath), "utf8"));
        for (const input of Object.keys(meta.inputs)) {
            const name = packageNameFromInput(input);
            if (!name || isWorkspacePackage(name)) continue;
            if (bundled.has(name)) continue;
            const dir = packageDirFromInput(input, name);
            if (dir) bundled.set(name, { dir });
        }
    }

    const packages = [];
    const problems = [];
    for (const [name, { dir }] of [...bundled].sort(([a], [b]) => a.localeCompare(b))) {
        let manifest = {};
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        } catch {
            problems.push(`${name}: unreadable package.json at ${dir}`);
            continue;
        }
        let license = readLicenseText(dir);
        const election = LICENSE_ELECTIONS[name];
        // A package with no `license` field can still be licensed by its LICENSE
        // file (khroma is MIT exactly this way); fall back to the text before
        // calling it unknown.
        let spdx = election?.elected ?? declaredLicense(manifest);
        if (!spdx && license) {
            const first = license.text.split("\n")[0];
            if (/MIT/i.test(first)) spdx = "MIT";
            else if (/ISC/i.test(first)) spdx = "ISC";
            else if (/Apache/i.test(first)) spdx = "Apache-2.0";
        }
        if (!spdx) {
            problems.push(`${name}@${manifest.version}: no license declared and none inferable`);
            continue;
        }
        if (!ALLOWED_LICENSES.has(spdx)) {
            problems.push(
                `${name}@${manifest.version}: license "${spdx}" is outside the reviewed set ` +
                    "(add it to ALLOWED_LICENSES only after checking what it asks of a bundled redistribution)",
            );
        }
        // No license file: recover the notice from a source header, else
        // reconstruct it from the declared license + the package's own
        // attribution. Only a license we have no template for is a hard failure.
        if (!license) license = readLicenseHeaderFromSource(dir, manifest);
        if (!license) {
            const template = LICENSE_TEMPLATES[spdx];
            if (template) {
                license = {
                    file: null,
                    text: template(attributionFor(manifest)),
                    source: "reconstructed",
                };
            } else {
                problems.push(
                    `${name}@${manifest.version}: declares ${spdx} but ships no license file, ` +
                        "has no source header, and we have no template for that license",
                );
                continue;
            }
        }

        packages.push({
            name,
            version: manifest.version ?? "unknown",
            spdx,
            election,
            licenseSource: license.source ?? "file",
            homepage:
                manifest.homepage ??
                (typeof manifest.repository === "string"
                    ? manifest.repository
                    : manifest.repository?.url) ??
                null,
            licenseText: license?.text ?? null,
            copyright: copyrightFrom(license?.text),
            notice: spdx === "Apache-2.0" ? readNoticeText(dir) : null,
        });
    }
    return { packages, problems };
}

/** Where an embedded component's license text lives, as a sentence. */
function embeddedLicenseWhere(e) {
    return e.licenseFile
        ? `License text: [\`licenses/${e.licenseFile}\`](${e.licenseFile}).`
        : "Its notice is carried in the package's own license text, reproduced below.";
}

function render(packages) {
    const byLicense = new Map();
    for (const p of packages) byLicense.set(p.spdx, (byLicense.get(p.spdx) ?? 0) + 1);

    const out = [];
    out.push("# Third-party licenses");
    out.push("");
    out.push(
        "Birta Writer is distributed as a bundle: `vsce package --no-dependencies` ships no",
        "`node_modules`, so every dependency below is inlined into `dist/extension.js`,",
        "`dist/webview.js`, or one of their chunks. Minification strips the header comments",
        "that would normally carry these notices, so they are reproduced here instead.",
        "",
        "This file is **generated** — do not edit it by hand. Regenerate with:",
        "",
        "```",
        "node esbuild.mjs --production --metafile",
        "node scripts/generate-third-party-notices.mjs",
        "```",
        "",
        "It lists what the bundles actually inline, not the full dependency tree: packages",
        "that are resolved but tree-shaken out are deliberately absent, because we do not",
        "ship their code.",
        "",
        "The narrative notices for bundled *data* (dictionaries and word lists, which are not",
        "npm dependencies) live in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).",
        "",
        "Every component below is licensed under its own terms, which are the terms reproduced",
        "with it — not under Birta Writer's license. Nothing in Birta Writer's license limits or",
        "alters the rights any of these grant you.",
        "",
        "One limit worth knowing when reading this file: each entry states what that PACKAGE",
        "declares. A package that inlines a third-party library into its own published artifact",
        "carries a second license one layer down, which a manifest cannot reveal. Where we know",
        "of one it is called out on the package's own entry; the known cases are listed under",
        "Embedded components below.",
        "",
    );

    out.push(`## Summary`);
    out.push("");
    out.push(`${packages.length} bundled packages.`);
    out.push("");
    out.push("| License | Packages |");
    out.push("| --- | ---: |");
    for (const [lic, n] of [...byLicense].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        out.push(`| ${lic} | ${n} |`);
    }
    out.push("");

    const elected = packages.filter((p) => p.election);
    if (elected.length) {
        out.push("## License elections");
        out.push("");
        out.push(
            "These packages are offered under more than one license. A dual license is an",
            "offer, not an ambiguity — we elect one, and the terms below are the ones this",
            "project relies on.",
            "",
        );
        for (const p of elected) {
            out.push(`- **${p.name}** — offered as \`${p.election.offered}\`. ${p.election.rationale}`);
        }
        out.push("");
    }

    const embeddedEntries = Object.entries(EMBEDDED_COMPONENTS)
        .filter(([name]) => packages.some((p) => p.name === name));
    if (embeddedEntries.length) {
        out.push("## Embedded components");
        out.push("");
        out.push(
            "Libraries inlined INSIDE a package above, under a license the package's own",
            "manifest does not state. They are listed separately because the summary table",
            "counts declared licenses, and would otherwise not show these at all.",
            "",
        );
        for (const [name, e] of embeddedEntries) {
            out.push(
                `- **${e.component}** (\`${e.spdx}\`), embedded in \`${name}\`. ${e.note} ` +
                `Source: ${e.homepage}. ${embeddedLicenseWhere(e)}`,
            );
        }
        out.push("");
    }

    out.push("## Packages");
    out.push("");
    for (const p of packages) {
        out.push(`### ${p.name}@${p.version}`);
        out.push("");
        out.push(`- License: ${p.spdx}`);
        if (p.homepage) out.push(`- Source: ${p.homepage.replace(/^git\+/, "").replace(/\.git$/, "")}`);
        if (p.copyright) out.push(`- ${p.copyright}`);
        const embedded = EMBEDDED_COMPONENTS[p.name];
        if (embedded) {
            // The package's own license does NOT cover what it inlines. Say so
            // right here, where a reader checking this package would otherwise
            // conclude the line above is the whole story.
            out.push(
                `- **Embeds ${embedded.component} (${embedded.spdx})** — ${embedded.note} ` +
                `Source: ${embedded.homepage}. ${embeddedLicenseWhere(embedded)} ` +
                `The narrative notice is in [\`THIRD_PARTY_NOTICES.md\`](../THIRD_PARTY_NOTICES.md).`,
            );
        }
        out.push("");
        if (p.notice) {
            out.push("NOTICE (reproduced per Apache-2.0 §4(d)):");
            out.push("");
            out.push("```");
            out.push(p.notice);
            out.push("```");
            out.push("");
        }
        if (p.licenseSource === "header") {
            out.push(
                "_This package ships no license file; the notice below is its verbatim source header._",
            );
            out.push("");
        } else if (p.licenseSource === "reconstructed") {
            out.push(
                `_This package ships no license file and no source header. The text below is the ` +
                    `standard ${p.spdx} license with the attribution this package declares — ` +
                    `reconstructed, not verbatim from the project._`,
            );
            out.push("");
        }
        // The license body is pushed as ONE array element, and the fence is
        // widened to clear any backtick run inside it. Both matter: this file's
        // whole contract is that the text between the fences is what the package
        // ships, so the renderer must not be able to alter it. An earlier version
        // rewrote ``` to ''' inside the body to protect the fence — safe against
        // today's dependencies (none contain a fence) and silently corrupting on
        // the first one that does.
        const fence = "`".repeat(Math.max(3, longestBacktickRun(p.licenseText) + 1));
        out.push("<details><summary>License text</summary>");
        out.push("");
        out.push(fence);
        out.push(p.licenseText);
        out.push(fence);
        out.push("");
        out.push("</details>");
        out.push("");
    }
    // Collapse runs of blank SCAFFOLDING lines only — by de-duplicating empty
    // ARRAY entries, never by regex over the joined string. A `/\n{3,}/` pass on
    // the output would reach inside the license bodies (each of which is a single
    // multi-line entry) and quietly reflow text this file promises to reproduce
    // verbatim. Ten license files in the current tree contain 3+ consecutive
    // newlines; none is bundled today, which is exactly why the bug would have
    // shipped unnoticed until the dependency that changed it.
    const lines = out.filter((line, i) => line !== "" || out[i - 1] !== "");
    return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/** Longest run of consecutive backticks in `text` (0 if none). */
function longestBacktickRun(text) {
    let longest = 0;
    for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    return longest;
}

function main() {
    const check = process.argv.includes("--check");
    const { packages, problems } = collect();
    const rendered = render(packages);

    if (problems.length) {
        console.error("Attribution problems:");
        for (const p of problems) console.error(`  - ${p}`);
        // An unreproducible notice and an unreviewed license are both open
        // questions. Fail rather than write a file that looks complete.
        process.exit(1);
    }

    if (check) {
        const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
        if (current !== rendered) {
            console.error(
                `${path.relative(repoRoot, OUT_FILE)} is out of date.\n` +
                    "Regenerate: node esbuild.mjs --production --metafile && node scripts/generate-third-party-notices.mjs",
            );
            process.exit(1);
        }
        console.log(
            `${path.relative(repoRoot, OUT_FILE)} is up to date (${packages.length} packages).`,
        );
    } else {
        fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
        fs.writeFileSync(OUT_FILE, rendered);
        console.log(`Wrote ${path.relative(repoRoot, OUT_FILE)} — ${packages.length} bundled packages.`);
    }
}

// Only run as a CLI. The guard test imports this module for ALLOWED_LICENSES and
// LICENSE_ELECTIONS, and must not trip the metafile requirement by doing so.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
