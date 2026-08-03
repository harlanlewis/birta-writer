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
 *   node scripts/generate-third-party-notices.mjs           # write the file
 *   node scripts/generate-third-party-notices.mjs --check    # verify it is current
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_FILE = path.join(repoRoot, "licenses", "THIRD_PARTY_LICENSES.md");
const METAFILES = ["dist/webview.meta.json", "dist/extension.meta.json"];

/**
 * Licenses that let us ship a bundled binary at all. Anything outside this set
 * is a decision, not a detail: reciprocal terms (GPL/LGPL/AGPL) would reach the
 * whole bundle, and source-availability terms (MPL/EPL/CDDL) impose duties the
 * appendix alone does not discharge. The generator refuses rather than quietly
 * writing a file that implies the question was considered.
 */
export const ALLOWED_LICENSES = new Set([
    "MIT",
    "ISC",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "Unlicense",
    "CC0-1.0",
    "MIT-0",
    "Python-2.0",
    "BlueOak-1.0.0",
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
                .replace(/^[ \t]*\*ptr?[ \t]?/gm, "")
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

    out.push("## Packages");
    out.push("");
    for (const p of packages) {
        out.push(`### ${p.name}@${p.version}`);
        out.push("");
        out.push(`- License: ${p.spdx}`);
        if (p.homepage) out.push(`- Source: ${p.homepage.replace(/^git\+/, "").replace(/\.git$/, "")}`);
        if (p.copyright) out.push(`- ${p.copyright}`);
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
        out.push("<details><summary>License text</summary>");
        out.push("");
        out.push("```");
        // Fence-safe: a license file containing ``` would break the block.
        out.push(p.licenseText.replace(/```/g, "'''"));
        out.push("```");
        out.push("");
        out.push("</details>");
        out.push("");
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
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
