/**
 * Guards on the third-party attribution appendix that do NOT need a build.
 *
 * The real staleness gate — "does licenses/THIRD_PARTY_LICENSES.md match what
 * the bundles actually inline?" — lives in CI's `perf-bundle` job, because
 * answering it requires a production build with metafiles. That is exactly the
 * kind of state a unit test should not depend on: `dist/` may be absent, or hold
 * a dev build, and a guard that silently passes when its input is missing is
 * worse than no guard (the lesson `bundleBaseline.test.mjs` was written for).
 *
 * What IS checkable here is everything derivable from the manifest and the
 * installed tree, and these are the two ways the appendix goes quietly wrong:
 *
 *  1. A dependency is added and nobody regenerates. The file still looks
 *     complete — it just does not mention the thing we started shipping.
 *  2. An upstream package changes its license. Our recorded election then
 *     describes an offer that is no longer on the table, and the appendix keeps
 *     asserting it with total confidence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    ALLOWED_LICENSES,
    EMBEDDED_COMPONENTS,
    LICENSE_ELECTIONS,
    OUT_FILE,
    // @ts-expect-error — plain-JS CLI module, intentionally untyped.
} from "../../scripts/generate-third-party-notices.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Read an installed package's manifest off disk.
 *
 * Not `require("<pkg>/package.json")`: a package with an `exports` map that does
 * not list `./package.json` — dompurify, the one package this test most needs to
 * read — makes that throw.
 */
const readInstalledManifest = (name: string) =>
    JSON.parse(readFileSync(path.join(repoRoot, "node_modules", name, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const appendix = readFileSync(OUT_FILE, "utf8");

/** Direct production dependencies, minus our own workspace packages. */
const directDeps = Object.keys(manifest.dependencies ?? {}).filter((d) => !d.startsWith("@birta/"));

describe("third-party attribution appendix", () => {
    it("a generated appendix should exist with a package inventory", () => {
        expect(appendix).toContain("# Third-party licenses");
        expect(appendix).toMatch(/^\d+ bundled packages\.$/m);
    });

    it("every direct production dependency should be attributed", () => {
        // Every direct prod dep currently reaches a bundle, so absence means the
        // appendix was not regenerated after the dependency was added — not that
        // the dependency was tree-shaken away. If one ever legitimately stops
        // shipping, that is a deliberate change to record here, with a reason.
        const missing = directDeps.filter(
            (dep) => !new RegExp(`^### ${dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "m").test(appendix),
        );
        expect(missing, "regenerate: node esbuild.mjs --production --metafile && node scripts/generate-third-party-notices.mjs").toEqual([]);
    });

    it("every license in the appendix should be one we reviewed for bundled redistribution", () => {
        const listed = [...appendix.matchAll(/^- License: (.+)$/gm)].map((m) => m[1].trim());
        expect(listed.length).toBeGreaterThan(0);
        const unreviewed = [...new Set(listed)].filter((l) => !ALLOWED_LICENSES.has(l));
        expect(unreviewed).toEqual([]);
    });

    it("a recorded dual-license election should still match what upstream offers", () => {
        for (const [name, election] of Object.entries(LICENSE_ELECTIONS) as [
            string,
            { elected: string; offered: string },
        ][]) {
            const pkg = readInstalledManifest(name);
            // If upstream relicenses, our election describes an offer that no
            // longer exists — and the appendix would keep printing it.
            expect(pkg.license, `${name} changed its license; revisit the election`).toBe(
                election.offered,
            );
            expect(appendix).toContain(`**${name}** — offered as \`${election.offered}\``);
        }
    });

    // ── Embedded components ──────────────────────────────────────────
    // These attribute code that a package INLINES under other terms — the one
    // thing the generator cannot derive, so it is the one thing most able to
    // rot silently. Each check below is a way it could rot.

    it("every embedded component should name a package the appendix actually attributes", () => {
        // Drop the dependency and this entry becomes a claim about code we no
        // longer ship — attribution for something absent is its own defect.
        for (const name of Object.keys(EMBEDDED_COMPONENTS)) {
            expect(appendix, `${name} has an embedded-component entry but is not in the appendix`)
                .toContain(`### ${name}@`);
        }
    });

    it("every embedded component should ship the license text it points at, or name the notice its parent carries", () => {
        for (const [name, e] of Object.entries(EMBEDDED_COMPONENTS) as [string, {
            licenseFile: string | null; noticeInParentLicense?: string; component: string; spdx: string;
        }][]) {
            if (e.licenseFile) {
                const file = path.join(repoRoot, "licenses", e.licenseFile);
                const text = readFileSync(file, "utf8");
                // A stub or a fetch that silently returned an error page would
                // satisfy "the file exists" but discharge nothing.
                expect(text.length, `${name}: ${e.licenseFile} is too short to be a license`)
                    .toBeGreaterThan(1000);
                continue;
            }
            // No shipped file means the parent's own LICENSE carries the
            // component's notice and the appendix reproduces it. Check the
            // reproduced text, not the claim: a package that drops the notice
            // in a bump leaves this entry pointing at nothing.
            expect(e.noticeInParentLicense, `${name}: no licenseFile and no noticeInParentLicense`).toBeTruthy();
            const entry = appendix.slice(appendix.indexOf(`### ${name}@`));
            const block = entry.slice(0, entry.indexOf("\n### ", 1) < 0 ? undefined : entry.indexOf("\n### ", 1));
            expect(block, `${name}'s reproduced license no longer carries "${e.noticeInParentLicense}"`)
                .toContain(e.noticeInParentLicense!);
        }
    });

    it("an embedded component's license should NOT be silently added to the allowed set", () => {
        // The allowlist answers "may this package's own license be bundled".
        // EPL and OFL are deliberately outside it; an embedded component is
        // discharged by its notice and shipped text instead. If one ever lands
        // in ALLOWED_LICENSES, that decision was made somewhere it is not
        // visible, and the header's reasoning has been quietly overridden.
        // An embedded component under a license some package DECLARES for
        // itself (cytoscape's MIT snippets, ColorBrewer's Apache-2.0) is not
        // that case: the set already had to answer for that license.
        const declared = new Set(
            [...appendix.matchAll(/^- License: (.+)$/gm)].map((m) => m[1].trim()),
        );
        for (const [name, e] of Object.entries(EMBEDDED_COMPONENTS) as [string, { spdx: string }][]) {
            if (declared.has(e.spdx)) continue;
            expect(ALLOWED_LICENSES.has(e.spdx), `${e.spdx} (embedded in ${name}) is in ALLOWED_LICENSES`)
                .toBe(false);
        }
    });

    it("the appendix should name every embedded component on its package's own entry", () => {
        // The per-package line is what a reader checking one package sees; the
        // section at the top is what a reader counting licenses sees. Both
        // must carry the component, or one of the two readers is told the
        // parent's license is the whole story.
        for (const [name, e] of Object.entries(EMBEDDED_COMPONENTS) as [string, {
            component: string; spdx: string;
        }][]) {
            const entry = appendix.slice(appendix.indexOf(`### ${name}@`));
            const head = entry.slice(0, entry.indexOf("<details>"));
            expect(head, `${name}'s entry does not name ${e.component}`).toContain(`Embeds ${e.component} (${e.spdx})`);
        }
    });

    it("the elected license should be the one the appendix prints for that package", () => {
        for (const [name, election] of Object.entries(LICENSE_ELECTIONS) as [
            string,
            { elected: string },
        ][]) {
            const entry = appendix.match(new RegExp(`^### ${name}@[^\\n]*\\n\\n- License: (.+)$`, "m"));
            expect(entry?.[1]).toBe(election.elected);
        }
    });
});
