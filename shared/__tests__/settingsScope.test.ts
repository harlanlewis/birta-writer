/**
 * Consent settings must be user-level only (MAR-199): the keys that let Birta
 * touch the network — or write fetched bytes into the file — are marked
 * `"scope": "application"` in package.json, so a workspace's checked-in
 * .vscode/settings.json can never flip them. Without the scope, VS Code's
 * default (window scope) lets any trusted repo silently defeat the
 * offline-by-default guarantee documented in docs/BENEFITS.md.
 *
 * The line: anything that causes a network request or a file write is consent,
 * and consent belongs to the user, not the repo. Add new consent keys (future
 * embed-provider switches, connector settings — MAR-198) to CONSENT_KEYS so
 * this guard covers them from day one.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props: Record<string, { scope?: string }> =
    pkg.contributes.configuration.properties;

/** Every key that gates a network request or an automatic file write. */
const CONSENT_KEYS = [
    "birta.network.enabled",
    "birta.pasteUnfurl.enabled",
    "birta.pasteUnfurl.autoApply",
    "birta.embeds.enabled",
];

describe("consent setting scopes", () => {
    it("every consent key should be contributed (guard against a vacuous pass)", () => {
        for (const key of CONSENT_KEYS) {
            expect(props[key], `${key} is not contributed in package.json`).toBeDefined();
        }
    });

    it("every consent key should declare application scope so workspaces cannot override it", () => {
        for (const key of CONSENT_KEYS) {
            expect(
                props[key].scope,
                `${key} must be "scope": "application" — window scope lets a repo's .vscode/settings.json enable it`,
            ).toBe("application");
        }
    });
});
