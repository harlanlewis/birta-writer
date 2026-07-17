/**
 * Anti-divergence guard (MAR-143): every editor-construction site must wire gfm
 * through the `gfmFidelity` bundle (serialization.ts), never the bare `gfm`
 * preset. The bundle pairs gfm with the overrides that MUST register after it
 * (null table-cell alignment; boolean list `spread`, MAR-124); a site that does
 * `.use(gfm)` on its own silently omits them and diverges from production —
 * exactly how a list/table `doc.check()` added to such a factory would fail
 * confusingly. This test fails at build time if a bare `.use(gfm)` reappears.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { gfmFidelity } from "../serialization";
import { markdownFormat } from "../format/markdown";

const WEBVIEW = path.resolve(__dirname, "..");
// serialization.ts defines the bundle and only names `.use(gfm)` in prose.
const ALLOWED = new Set([path.join(WEBVIEW, "serialization.ts")]);

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") { continue; }
            out.push(...walk(full));
        } else if (entry.name.endsWith(".ts")) {
            out.push(full);
        }
    }
    return out;
}

/** Strip line and block comments so a `.use(gfm)` in prose doesn't trip us. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

describe("gfm is only wired through the gfmFidelity bundle (MAR-143)", () => {
    it("no editor-construction site should register the bare gfm preset", () => {
        const offenders: string[] = [];
        for (const file of walk(WEBVIEW)) {
            if (ALLOWED.has(file)) { continue; }
            if (/\.use\(gfm\)/.test(stripComments(fs.readFileSync(file, "utf8")))) {
                offenders.push(path.relative(WEBVIEW, file));
            }
        }
        expect(
            offenders,
            `these sites use the bare gfm preset instead of gfmFidelity: ${offenders.join(", ")}`,
        ).toEqual([]);
    });

    it("the production format module should adopt the gfmFidelity bundle", () => {
        // editor.ts registers presets through the FormatModule seam (MAR-41),
        // so the adoption check lives on the module: its presets must include
        // the bundle BY IDENTITY — a lookalike `[gfm, ...]` array would not
        // pass, which is exactly the divergence this guard exists to catch.
        expect(markdownFormat.presets).toContain(gfmFidelity);
    });

    it("production editor.ts should build from the markdown format module", () => {
        const src = fs.readFileSync(path.join(WEBVIEW, "editor.ts"), "utf8");
        expect(stripComments(src)).toContain("markdownFormat");
    });
});
