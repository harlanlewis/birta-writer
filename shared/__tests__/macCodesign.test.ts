/**
 * Guard for the Mac app's signing: every Mach-O the bundle carries is signed,
 * and the options notarization requires are the ones applied.
 *
 * The defect this exists for is one the tracker had recorded as impossible.
 * MAR-378 stated that the bundle holds one binary, "so signing the `.app`
 * itself is the whole job". It holds two: the app's executable and the `bwr`
 * CLI beside it in Contents/MacOS. `--deep` had been walking to the second one
 * all along, so nothing surfaced the second binary, and dropping `--deep` (now
 * deprecated for signing) on the strength of that sentence would have shipped
 * a bundle whose CLI carried no signature of its own.
 *
 * It fails LATE and far from its cause. `codesign --verify` on the bundle
 * passes, because the nested binary is sealed as a resource either way; the
 * first thing that objects is the notary service, minutes into a release job,
 * naming a path rather than the missing line that produced it.
 *
 * So the enumeration is DERIVED from the script rather than written here. A
 * hand-kept list of binaries is a list a third binary never joins, which is
 * the same absence the defect came from. This reads the copies the script
 * makes into Contents/MacOS and requires each one to be accounted for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const buildScript = readFileSync(join(REPO, "mac/scripts/build-app.sh"), "utf8");
const releaseWorkflow = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");

/**
 * Every destination the build copies into Contents/MacOS, as the script spells
 * it. `cp "$BIN" "$APP/Contents/MacOS/$EXEC_NAME"` yields `$EXEC_NAME`.
 */
function macOsCopyTargets(script: string): string[] {
    const targets: string[] = [];
    for (const line of script.split("\n")) {
        const match = line.match(/^\s*cp\s+[^\n]*"\$APP\/Contents\/MacOS\/([^"]+)"/);
        if (match) targets.push(match[1]);
    }
    return targets;
}

describe("mac/scripts/build-app.sh", () => {
    it("copying a binary into Contents/MacOS should sign it or be the bundle's own executable", () => {
        const targets = macOsCopyTargets(buildScript);
        // The sweep has to have reached something. An enumeration that matched
        // no lines passes every assertion below it and reports nothing, which
        // is how a guard goes quiet after a rename.
        expect(targets.length).toBeGreaterThanOrEqual(2);

        const unaccounted = targets.filter((target) => {
            // The bundle's main executable is signed by signing the bundle,
            // and is named by CFBundleExecutable rather than signed by path.
            if (target === "$EXEC_NAME") return false;
            // Anything else is nested code and needs a signature of its own.
            return !new RegExp(`\\$\\{SIGN\\[@\\]}"[^\\n]*Contents/MacOS/${target.replace(/\$/g, "\\$")}"`).test(
                buildScript,
            );
        });
        expect(unaccounted).toEqual([]);
    });

    it("signing should apply the hardened runtime, which the notary service requires", () => {
        expect(buildScript).toMatch(/codesign[^\n]*--options runtime/);
    });

    it("signing should not use --deep, deprecated for signing as of macOS 13", () => {
        expect(buildScript).not.toMatch(/codesign[^\n]*--deep/);
    });

    it("a secure timestamp should be requested only when the identity is not ad-hoc", () => {
        // `--timestamp` against an ad-hoc signature fails: there is no
        // certificate for a timestamp to attest to. The gate is what lets one
        // signing path serve a local build and a release.
        expect(buildScript).toMatch(/\[ "\$IDENTITY" = "-" \] \|\| SIGN\+=\(--timestamp\)/);
    });

    it("the identity should default to ad-hoc so a local build needs no key", () => {
        expect(buildScript).toMatch(/IDENTITY="\$\{BIRTA_CODESIGN_IDENTITY:--}"/);
    });
});

describe(".github/workflows/release.yml", () => {
    it("the mac-app job should not re-sign with --deep", () => {
        expect(releaseWorkflow).not.toMatch(/codesign[^\n]*--deep/);
    });

    it("the release archive should be built after stapling, never from the submitted one", () => {
        // A zip cannot carry a stapled ticket, so the archive that ships has
        // to be made from the bundle AFTER `stapler staple` ran. Shipping the
        // submitted archive instead produces an app that opens only while the
        // machine opening it can reach Apple.
        const staple = releaseWorkflow.indexOf("stapler staple");
        const releaseZip = releaseWorkflow.indexOf('ditto -c -k --keepParent "Birta Writer.app" "BirtaWriter-$VERSION.zip"');
        expect(staple).toBeGreaterThan(-1);
        expect(releaseZip).toBeGreaterThan(-1);
        expect(releaseZip).toBeGreaterThan(staple);
    });

    it("the job should install the G2 intermediate, which a fresh runner does not carry", () => {
        // Without it codesign fails with errSecInternalComponent and
        // find-identity omits the identity entirely, so the symptom reads as
        // a missing certificate rather than a missing chain.
        expect(releaseWorkflow).toMatch(/DeveloperIDG2CA\.cer/);
    });

    it("the signing identity should be selected by hash rather than by name", () => {
        // Two Developer ID certificates of one team share a common name, so a
        // name match is ambiguous the moment a second one exists and codesign
        // fails rather than choosing.
        expect(releaseWorkflow).toMatch(/grep -oE '\\b\[0-9A-F]\{40}\\b'/);
    });
});
