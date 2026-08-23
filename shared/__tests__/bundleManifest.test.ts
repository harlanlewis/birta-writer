/**
 * Guards on the bundle manifest, the thing that keeps the attribution appendix's
 * subject and the build's output the same set.
 *
 * These run against fixture directories rather than `dist/`, deliberately. A
 * guard whose input may be absent or may hold a dev build is a guard that passes
 * for the wrong reason, which is the lesson `bundleBaseline.test.mjs` was
 * written for and the reason the real staleness gate lives in CI's `perf-bundle`
 * job. What is checkable here is the reader's contract, and it is the whole
 * contract: each refusal below is a way the appendix used to go quietly wrong.
 *
 * The last test is the odd one and the load-bearing one. The defect this file
 * exists for was a hand-written list of metafiles in each consumer, and no green
 * run could reveal it, because a bundle nobody reads contributes no packages to
 * contradict. Deriving the list fixed it; the only way it comes back is for a
 * consumer to write its own list again, so that is what gets asserted.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BundleManifestError,
    MANIFEST_FILE,
    metafileFor,
    shippedMetafiles,
    // @ts-expect-error — plain-JS build module, intentionally untyped.
} from "../../scripts/bundleManifest.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

type Bundle = { name: string; outputs: string[] };

/** A fake repo root whose dist/ holds exactly the bundles described. */
function fixture(bundles: Bundle[], opts: { manifest?: boolean; extraDistFiles?: string[] } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "birta-manifest-"));
    mkdirSync(path.join(root, "dist"));
    for (const { name, outputs } of bundles) {
        const outputMap = Object.fromEntries(outputs.map((o) => [o, { bytes: 1 }]));
        writeFileSync(path.join(root, metafileFor(name)), JSON.stringify({ inputs: {}, outputs: outputMap }));
        for (const o of outputs) writeFileSync(path.join(root, o), "");
    }
    for (const f of opts.extraDistFiles ?? []) writeFileSync(path.join(root, f), "");
    if (opts.manifest !== false) {
        const entries = bundles.map(({ name }) => ({ name, metafile: metafileFor(name) }));
        writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify({ bundles: entries }));
    }
    return root;
}

describe("shippedMetafiles", () => {
    it("a manifest naming every shipped artifact should return its metafiles in order", () => {
        const root = fixture([
            { name: "extension", outputs: ["dist/extension.js"] },
            { name: "webview", outputs: ["dist/webview.js", "dist/webview.css"] },
        ]);
        expect(shippedMetafiles(root)).toEqual(["dist/extension.meta.json", "dist/webview.meta.json"]);
    });

    it("a bundle added to the manifest should widen the returned set", () => {
        // The positive arm. Without it every test here could pass on a reader
        // that refuses unconditionally, which would report as a working guard.
        const root = fixture([
            { name: "extension", outputs: ["dist/extension.js"] },
            { name: "webview", outputs: ["dist/webview.js"] },
            { name: "diffView", outputs: ["dist/diffView.js"] },
        ]);
        expect(shippedMetafiles(root)).toContain("dist/diffView.meta.json");
    });

    it("a dist/ shipping a bundle no metafile claims should be refused by name", () => {
        // The defect itself: a third entry point built outside the declared list.
        const root = fixture([{ name: "webview", outputs: ["dist/webview.js"] }], {
            extraDistFiles: ["dist/diffView.js"],
        });
        expect(() => shippedMetafiles(root)).toThrow(BundleManifestError);
        expect(() => shippedMetafiles(root)).toThrow(/dist\/diffView\.js/);
    });

    it("a missing manifest should be refused rather than treated as no bundles", () => {
        const root = fixture([{ name: "webview", outputs: ["dist/webview.js"] }], { manifest: false });
        expect(() => shippedMetafiles(root)).toThrow(/Missing dist\/bundles\.manifest\.json/);
    });

    it("a manifest naming a metafile that dist/ does not have should be refused by name", () => {
        // The inverse of the unclaimed-bundle case: a partial or stale dist/,
        // which a glob over dist/*.meta.json would attribute and call a success.
        const root = fixture([
            { name: "extension", outputs: ["dist/extension.js"] },
            { name: "webview", outputs: ["dist/webview.js"] },
        ]);
        const manifestPath = path.join(root, MANIFEST_FILE);
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
        parsed.bundles.push({ name: "diffView", metafile: metafileFor("diffView") });
        writeFileSync(manifestPath, JSON.stringify(parsed));
        // The type matters as much as the path here. Without this check the
        // reader still throws — from readFileSync, whose ENOENT also quotes the
        // path — so a message-only assertion passes on the unguarded code.
        expect(() => shippedMetafiles(root)).toThrow(BundleManifestError);
        expect(() => shippedMetafiles(root)).toThrow(/dist\/diffView\.meta\.json, which dist\/ does not have/);
    });

    it("an empty bundle list should be refused rather than attributing nothing", () => {
        const root = fixture([]);
        expect(() => shippedMetafiles(root)).toThrow(/names no bundles/);
    });

    it("a code-split chunk should not count as an unclaimed bundle", () => {
        const root = fixture([{ name: "webview", outputs: ["dist/webview.js"] }]);
        mkdirSync(path.join(root, "dist", "chunks"));
        writeFileSync(path.join(root, "dist", "chunks", "chunk-ABC123.js"), "");
        expect(shippedMetafiles(root)).toEqual(["dist/webview.meta.json"]);
    });

    it("no consumer should carry its own list of metafiles", () => {
        // The absence guard. Both consumers used to spell the same two paths,
        // and the appendix narrowed to whatever they happened to name.
        const consumers = ["scripts/generate-third-party-notices.mjs", "scripts/audit-embedded-components.mjs"];
        for (const file of consumers) {
            const source = readFileSync(path.join(repoRoot, file), "utf8");
            expect(source, `${file} should read the manifest, not name metafiles itself`).not.toMatch(
                /["'`]dist\/[\w.-]+\.meta\.json["'`]/,
            );
            expect(source, `${file} should call shippedMetafiles`).toMatch(/shippedMetafiles/);
        }
    });
});
