/**
 * The list of bundles this project ships, derived rather than restated.
 *
 * WHY THIS EXISTS
 * ---------------
 * `licenses/THIRD_PARTY_LICENSES.md` claims to report every package the shipped
 * bundles inline. That claim holds only while the set of bundles esbuild builds
 * and the set the attribution generator reads are the same set. When each side
 * wrote its own list, they could disagree with nothing to say so: a bundle the
 * generator never reads contributes no packages, so no assertion it makes can
 * fail, and the appendix quietly narrows to the bundles that happen to be named.
 *
 * So there is one list, in `esbuild.mjs`, and it writes what it built here.
 * Adding a bundle to the build is the only way to add one, and it joins the
 * appendix by doing so.
 *
 * WHAT THIS CHECKS, AND WHY BOTH DIRECTIONS ARE NEEDED
 * ----------------------------------------------------
 * The manifest alone answers "is a bundle we expected missing" — a partial or
 * stale `dist/` fails loudly instead of attributing fewer bundles and reporting
 * success. It cannot answer "is a bundle here that nobody declared", because a
 * build wired up outside `BUNDLES` writes no manifest entry to be missing.
 *
 * So the reader also walks `dist/` and refuses any shipped `.js` or `.css` that
 * no manifest metafile claims as an output. That is the half that catches a
 * bundle added by any route at all, including one that forgot the manifest.
 */

import fs from "node:fs";
import path from "node:path";

/** Written by `node esbuild.mjs --metafile`; read by everything that needs the set. */
export const MANIFEST_FILE = "dist/bundles.manifest.json";

/** The one place a bundle's metafile path is spelled, so the writer and the readers cannot drift. */
export const metafileFor = (name) => `dist/${name}.meta.json`;

/** Thrown for every failure below, so a caller can turn it into its own exit code. */
export class BundleManifestError extends Error {}

const BUILD_HINT = "Run `node esbuild.mjs --production --metafile` first — this reads what that writes.";

/**
 * Every shipped bundle's metafile path, verified present and verified complete.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {string[]} repo-relative metafile paths, in build order
 * @throws {BundleManifestError} if the manifest is absent, empty, names a
 *   metafile that is not on disk, or omits something `dist/` ships
 */
export function shippedMetafiles(repoRoot) {
    const manifestPath = path.join(repoRoot, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
        throw new BundleManifestError(`Missing ${MANIFEST_FILE}.\n${BUILD_HINT}`);
    }

    let bundles;
    try {
        ({ bundles } = JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    } catch (err) {
        throw new BundleManifestError(`${MANIFEST_FILE} is not readable JSON: ${err.message}\n${BUILD_HINT}`);
    }
    if (!Array.isArray(bundles) || bundles.length === 0) {
        throw new BundleManifestError(`${MANIFEST_FILE} names no bundles.\n${BUILD_HINT}`);
    }

    const absent = bundles.map((b) => b.metafile).filter((f) => !fs.existsSync(path.join(repoRoot, f)));
    if (absent.length) {
        throw new BundleManifestError(
            `${MANIFEST_FILE} names ${absent.join(", ")}, which dist/ does not have.\n${BUILD_HINT}`,
        );
    }

    const claimed = new Set();
    for (const { metafile } of bundles) {
        const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, metafile), "utf8"));
        for (const output of Object.keys(meta.outputs)) claimed.add(output.replace(/^\.\//, ""));
    }

    // Top level only: code-split chunks live in dist/chunks/ and are already
    // claimed as outputs by the bundle that split them.
    const shipped = fs
        .readdirSync(path.join(repoRoot, "dist"))
        .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
        .map((f) => `dist/${f}`);
    const unclaimed = shipped.filter((f) => !claimed.has(f));
    if (unclaimed.length) {
        throw new BundleManifestError(
            `dist/ ships ${unclaimed.join(", ")}, which no metafile in ${MANIFEST_FILE} claims as an output.\n` +
                "A bundle esbuild.mjs does not declare in BUNDLES is a bundle the attribution appendix does not report.",
        );
    }

    return bundles.map((b) => b.metafile);
}
