#!/usr/bin/env node
/**
 * Sweep the packages esbuild inlined for the shapes that carry EMBEDDED
 * third-party code, and print candidates for a human to judge.
 *
 * `generate-third-party-notices.mjs` derives the appendix from what each
 * package's own manifest and license file declare, and it says so: a package
 * that vendors a foreign library into its published artifact is invisible to
 * it, because the manifest is self-consistent and the second license lives one
 * layer below anything it reads. `EMBEDDED_COMPONENTS` records the cases
 * someone found; this script is how the next one gets found. It knows shapes,
 * not answers, so every line it prints is a candidate and the judgement (is
 * this genuinely embedded, under what terms, is the notice already discharged
 * by the parent's LICENSE) stays with the reader.
 *
 * What it looks for, per bundled package (read from the metafiles, so it sees
 * what ships and not the dependency closure):
 *   - `.wasm` files, and inlined WebAssembly inside a JS input (the wasm magic
 *     bytes, base64 or raw) or wasm glue (emscripten, wasm-bindgen): almost by
 *     definition someone else's C, C++ or Rust library.
 *   - font files: their license is in the font's own name table, never in the
 *     package manifest (the KaTeX fonts are OFL-1.1 inside an MIT package).
 *   - vendor / third_party / external directories.
 *   - license, copying or notice files below the top level, or a top-level one
 *     whose text names a license other than the manifest's.
 *   - inputs over a size threshold, with every copyright line, SPDX id and
 *     `@license` tag found in them: a big single file is where vendored code
 *     hides, and a copyright line that names someone other than the package's
 *     author is the tell.
 *   - large data files (dictionaries, word lists, tables), whose terms are
 *     usually not the code's.
 *
 * It ALWAYS prints how many packages it inspected and lists every flag, so a
 * run that found nothing is distinguishable from a run that looked at nothing.
 * A package already covered by `EMBEDDED_COMPONENTS` is marked as such and
 * still listed, so the entry can be re-judged when the package moves.
 *
 * USAGE
 *   pnpm notices:audit        # production build + sweep
 *   node scripts/audit-embedded-components.mjs   # reuse an existing metafile build
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_COMPONENTS } from "./generate-third-party-notices.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METAFILES = ["dist/webview.meta.json", "dist/extension.meta.json"];
const BIG_INPUT_BYTES = 250_000;
const BIG_DATA_BYTES = 300_000;

function packageNameFromInput(input) {
    const marker = "node_modules/";
    const idx = input.lastIndexOf(marker);
    if (idx < 0) return null;
    const parts = input.slice(idx + marker.length).split("/");
    return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function packageDir(input, name) {
    const marker = "node_modules/" + name + "/";
    const idx = input.lastIndexOf(marker);
    return idx < 0 ? null : path.resolve(repoRoot, input.slice(0, idx + marker.length));
}

function walk(dir, depth = 0, out = []) {
    if (depth > 6) return out;
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name === "node_modules") continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, depth + 1, out);
        else out.push(p);
    }
    return out;
}

// Coarse license-family sniff over a text's opening; a hint for the reader,
// not a determination.
const LICENSE_HINTS = [
    [/Apache License/i, "Apache-2.0"],
    [/Permission is hereby granted, free of charge/i, "MIT"],
    [/Redistribution and use in source and binary forms/i, "BSD"],
    [/Permission to use, copy, modify, and\/or distribute/i, "ISC"],
    [/GNU General Public/i, "GPL"],
    [/GNU Lesser/i, "LGPL"],
    [/Mozilla Public License/i, "MPL"],
    [/Eclipse Public License/i, "EPL"],
    [/SIL Open Font License|SIL OPEN FONT/i, "OFL"],
    [/Creative Commons|CC-BY|CC0/i, "CC"],
    [/Unlicense/i, "Unlicense"],
];
function inferLicense(text) {
    const head = text.slice(0, 4000);
    for (const [re, id] of LICENSE_HINTS) if (re.test(head)) return id;
    return "?";
}
const sameFamily = (declared, id) =>
    declared.includes(id) || (id === "BSD" && /BSD/.test(declared)) || (id === "MIT" && /MIT/.test(declared));

function collectPackages() {
    const missing = METAFILES.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
    if (missing.length) {
        console.error(
            `Missing ${missing.join(", ")}.\n` +
                "Run `node esbuild.mjs --production --metafile` first; this reads what that writes.",
        );
        process.exit(2);
    }
    const pkgs = new Map();
    for (const metaPath of METAFILES) {
        const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, metaPath), "utf8"));
        for (const [input, info] of Object.entries(meta.inputs)) {
            const name = packageNameFromInput(input);
            if (!name || name.startsWith("@birta/")) continue;
            const entry = pkgs.get(name) ?? { name, dir: packageDir(input, name), inputs: [], bytes: 0 };
            entry.inputs.push({ input, bytes: info.bytes });
            entry.bytes += info.bytes;
            pkgs.set(name, entry);
        }
    }
    return [...pkgs.values()].sort((a, b) => b.bytes - a.bytes);
}

function auditPackage(entry) {
    let manifest = {};
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(entry.dir, "package.json"), "utf8"));
    } catch {
        // reported below through the missing version
    }
    const declared =
        typeof manifest.license === "string" ? manifest.license : JSON.stringify(manifest.license ?? null);
    const flags = [];
    const files = walk(entry.dir);
    const rel = (f) => f.slice(entry.dir.length);

    const wasm = files.filter((f) => /\.wasm$/i.test(f));
    if (wasm.length) flags.push(`wasm files: ${wasm.map(rel).join(", ")}`);
    const fonts = files.filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
    if (fonts.length) flags.push(`font files: ${fonts.length} (license lives in the font's name table)`);
    const vendored = files.filter((f) => /\/(vendor|third[_-]?party|external)\//i.test(rel(f)));
    if (vendored.length) flags.push(`vendor-style directories: ${vendored.length} files`);
    const data = files.filter(
        (f) => /\.(dic|aff|dict|txt|json|csv)$/i.test(f) && fs.statSync(f).size > BIG_DATA_BYTES,
    );
    if (data.length) flags.push(`large data files: ${data.map(rel).join(", ")}`);

    const foreignLicense = [];
    for (const f of files.filter((f) => /(^|\/)(LICEN[CS]E|COPYING|NOTICE|PATENTS)[^/]*$/i.test(f))) {
        const id = inferLicense(fs.readFileSync(f, "utf8"));
        const nested = rel(f).slice(1).includes("/");
        if (nested || (id !== "?" && !sameFamily(declared, id))) foreignLicense.push(`${rel(f)} reads as ${id}`);
    }
    if (foreignLicense.length) flags.push(`other license files: ${foreignLicense.join("; ")}`);

    for (const f of entry.inputs.filter((f) => f.bytes > BIG_INPUT_BYTES)) {
        let text = "";
        try {
            text = fs.readFileSync(path.resolve(repoRoot, f.input), "latin1");
        } catch {
            continue;
        }
        const marks = [];
        if (/AGFzbQ/.test(text) || text.includes("\0asm")) marks.push("inline wasm");
        if (/emscripten|wasm-function|Module\["asm"\]|__wbindgen/i.test(text)) marks.push("wasm glue");
        const copyrights = new Set();
        for (const m of text.matchAll(/(?:Copyright|\(c\)|©)\s*(?:\(c\)\s*)?(?:[\d,\-\s]+)?([A-Z][A-Za-z.,& \-]{2,60})/g)) {
            copyrights.add(m[1].trim().slice(0, 48));
        }
        const spdx = new Set([...text.matchAll(/SPDX-License-Identifier:\s*([\w.\-+ ()]+)/g)].map((m) => m[1].trim()));
        const tags = new Set([...text.matchAll(/@license\s+([^\n*]{0,60})/g)].map((m) => m[1].trim()).filter(Boolean));
        flags.push(
            `big input ${path.basename(f.input)} (${Math.round(f.bytes / 1024)} KB)` +
                (marks.length ? ` [${marks.join(", ")}]` : "") +
                (copyrights.size ? `\n      copyright: ${[...copyrights].slice(0, 8).join(" | ")}` : "") +
                (spdx.size ? `\n      spdx: ${[...spdx].join(" | ")}` : "") +
                (tags.size ? `\n      @license: ${[...tags].slice(0, 5).join(" | ")}` : ""),
        );
    }
    return { name: entry.name, version: manifest.version ?? "unknown", declared, kb: Math.round(entry.bytes / 1024), flags };
}

function main() {
    const packages = collectPackages();
    const rows = packages.map(auditPackage);
    const flagged = rows.filter((r) => r.flags.length);
    console.log(`inspected ${rows.length} bundled packages (from ${METAFILES.join(", ")}); ${flagged.length} carry a shape worth reading`);
    console.log("");
    for (const r of flagged) {
        const known = EMBEDDED_COMPONENTS[r.name];
        console.log(
            `${r.name}@${r.version} [${r.declared}] ${r.kb} KB inlined` +
                (known ? `  <- EMBEDDED_COMPONENTS: ${known.component} (${known.spdx})` : ""),
        );
        for (const flag of r.flags) console.log(`    - ${flag}`);
    }
    console.log("");
    console.log("Every line above is a candidate, not a finding. Judge each against the package's LICENSE and the appendix; record what is genuinely embedded in EMBEDDED_COMPONENTS.");
}

main();
