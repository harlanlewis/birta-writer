/**
 * The per-provider embed roster (MAR-186): one contributed
 * `birta.embeds.providers.<kind>` switch per provider, and the predicate every
 * gate site reads.
 *
 * The drift this pins is the one adding a provider invites: a new extractor
 * lands, the provider starts rendering cards, and it silently has no switch —
 * so a user who has turned the roster down still gets contacted by the new
 * host. Both directions are pinned (a kind with no key, a key with no kind)
 * because either one means the settings UI and the code disagree.
 *
 * Scope is pinned next door in settingsScope.test.ts, which enumerates these
 * same keys from EMBED_KINDS: consent belongs to the user, not the repo
 * (MAR-199), and a roster entry is consent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    EMBED_KINDS,
    canonicalEmbedUrl,
    embedProviderEnabled,
    embedProviderSettingKey,
    recognizeEmbed,
    type EmbedKind,
} from "../embedProviders";

const root = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const props: Record<string, { default?: unknown; scope?: string }> =
    pkg.contributes.configuration.properties;

/** A real id per provider, so each kind can be turned into a real URL. */
const IDS: Record<EmbedKind, string> = {
    youtube: "dQw4w9WgXcQ",
    vimeo: "1084537",
    loom: "0123456789abcdef0123456789abcdef",
    figma: "design/AbCdEf123456",
    github: "owner/repo",
    googledrive: "1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    googledocs: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googleslides: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googlesheets: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googlefile: "document/1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    miro: "uXjVO5X2CWo=",
    linear: "birta/issue/MAR-186/embed-provider-roadmap",
    codepen: "chriscoyier/AbCdEf",
    codesandbox: "new-react-sandbox-abc123",
    stackblitz: "vitejs-vite-abc123",
};

/** Contributed keys under the roster prefix, whatever their kind. */
const contributedRosterKeys = Object.keys(props).filter((k) =>
    k.startsWith("birta.embeds.providers."),
);

describe("EMBED_KINDS", () => {
    it("an empty or truncated roster should fail rather than pass vacuously", () => {
        // Every sweep below iterates EMBED_KINDS, so a roster that enumerated
        // nothing would make all of them green while asserting nothing. The
        // floor is the roster as shipped; raising it is what adding a provider
        // is supposed to feel like.
        expect(EMBED_KINDS.length).toBeGreaterThanOrEqual(15);
        expect(new Set(EMBED_KINDS).size).toBe(EMBED_KINDS.length);
    });

    it("every kind should be reachable from a real URL, so the fixture is not fiction", () => {
        // The sweeps are only as good as IDS: a kind whose canonical URL does
        // not recognize back would silently test nothing.
        const unreachable: string[] = [];
        for (const kind of EMBED_KINDS) {
            const match = recognizeEmbed(canonicalEmbedUrl(kind, IDS[kind]));
            if (match?.kind !== kind) {
                unreachable.push(`${kind} -> ${match?.kind ?? "no match"}`);
            }
        }
        expect(unreachable).toEqual([]);
        expect(Object.keys(IDS).sort()).toEqual([...EMBED_KINDS].sort());
    });
});

describe("per-provider setting contributions", () => {
    it("every provider should contribute a switch that defaults to on", () => {
        const missing: string[] = [];
        for (const kind of EMBED_KINDS) {
            const key = `birta.${embedProviderSettingKey(kind)}`;
            if (!props[key]) {
                missing.push(key);
                continue;
            }
            expect(props[key].default, `${key} must ship ON`).toBe(true);
        }
        expect(missing, "a provider that renders cards with no switch to turn it off").toEqual([]);
    });

    it("no contributed switch should name a provider that does not exist", () => {
        const kinds = new Set<string>(EMBED_KINDS);
        const orphans = contributedRosterKeys.filter(
            (k) => !kinds.has(k.slice("birta.embeds.providers.".length)),
        );
        expect(orphans, "a switch for a removed or misspelled provider").toEqual([]);
    });

    it("the contributed count should equal the roster count in both directions", () => {
        expect(contributedRosterKeys).toHaveLength(EMBED_KINDS.length);
    });
});

describe("embedProviderEnabled", () => {
    it("an absent entry should read as ON so a partial map cannot blank the roster", () => {
        // The failure this rules out: a webview booted before a provider
        // existed sends a map without it, and every card of that provider
        // disappears for a user who never switched anything off.
        expect(embedProviderEnabled("youtube", {})).toBe(true);
        expect(embedProviderEnabled("youtube", undefined)).toBe(true);
        expect(embedProviderEnabled("youtube", { figma: false })).toBe(true);
    });

    it("an explicit false should be the only thing that switches a provider off", () => {
        expect(embedProviderEnabled("youtube", { youtube: false })).toBe(false);
        expect(embedProviderEnabled("youtube", { youtube: true })).toBe(true);
    });

    it("switching one provider off should leave every other provider on", () => {
        for (const off of EMBED_KINDS) {
            const map = { [off]: false };
            for (const kind of EMBED_KINDS) {
                expect(
                    embedProviderEnabled(kind, map),
                    `${off} off should not affect ${kind}`,
                ).toBe(kind !== off);
            }
        }
    });

    it("the setting key should be the kind under the roster prefix", () => {
        expect(embedProviderSettingKey("youtube")).toBe("embeds.providers.youtube");
        expect(embedProviderSettingKey("googlefile")).toBe("embeds.providers.googlefile");
    });
});
