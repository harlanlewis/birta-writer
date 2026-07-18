/**
 * The just-in-time "Enable network features" affordance (MAR-179).
 *
 * Covers the pure decision (`shouldOfferNetworkOptIn`) and the jsdom-driven
 * popup interaction: it appears only when the master switch is off, "Enable"
 * writes the setting back + flips the in-session gate + runs the caller's
 * onEnable, and a dismissal suppresses it for the rest of the session ("don't
 * nag"). The exact on-screen positioning is an e2e concern (jsdom can't measure
 * layout) and is deliberately not asserted here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    offerNetworkOptIn,
    shouldOfferNetworkOptIn,
    isNetworkOptInOpen,
    __resetNetworkOptInForTests,
} from "@/components/networkOptIn";
import { mockVscodeApi } from "./setup";

/** The live affordance element, or null. */
function optInEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".network-optin");
}

/** Click (mousedown) a control inside the affordance by selector. */
function press(selector: string): void {
    optInEl()!
        .querySelector<HTMLElement>(selector)!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

/** The last setNetworkEnabled message posted, or undefined. */
function lastSetNetwork(): { type: string; enabled: boolean } | undefined {
    const calls = mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type: string; enabled?: boolean })
        .filter((m) => m.type === "setNetworkEnabled");
    return calls[calls.length - 1] as { type: string; enabled: boolean } | undefined;
}

describe("shouldOfferNetworkOptIn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetNetworkOptInForTests();
        window.__i18n = { translations: {}, isMac: false, network: false };
    });
    afterEach(() => {
        __resetNetworkOptInForTests();
        delete window.__i18n;
    });

    it("with the master switch OFF and nothing dismissed it should offer", () => {
        expect(shouldOfferNetworkOptIn()).toBe(true);
    });

    it("with the master switch ON it should NOT offer", () => {
        window.__i18n = { translations: {}, isMac: false, network: true };
        expect(shouldOfferNetworkOptIn()).toBe(false);
    });

    it("after a dismissal it should NOT offer again this session", () => {
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable: () => {} });
        press(".network-optin__dismiss");
        expect(shouldOfferNetworkOptIn()).toBe(false);
    });
});

describe("offerNetworkOptIn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        __resetNetworkOptInForTests();
        window.__i18n = { translations: {}, isMac: false, network: false };
    });
    afterEach(() => {
        __resetNetworkOptInForTests();
        delete window.__i18n;
    });

    it("with the master switch OFF it should mount the affordance", () => {
        offerNetworkOptIn({ label: "Fetch link title?", anchorRect: null, onEnable: () => {} });
        expect(isNetworkOptInOpen()).toBe(true);
        expect(optInEl()).not.toBeNull();
        expect(optInEl()!.textContent).toContain("Fetch link title?");
    });

    it("with the master switch already ON it should be a no-op", () => {
        window.__i18n = { translations: {}, isMac: false, network: true };
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable: () => {} });
        expect(isNetworkOptInOpen()).toBe(false);
        expect(optInEl()).toBeNull();
    });

    it("Enable should write the setting back, flip the in-session gate, and run onEnable", () => {
        const onEnable = vi.fn();
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable });

        press(".network-optin__enable");

        // Write-back message to the extension (the config seam).
        expect(lastSetNetwork()).toEqual({ type: "setNetworkEnabled", enabled: true });
        // In-session gate flipped so the feature works without a reload.
        expect(window.__i18n?.network).toBe(true);
        // The just-triggered action runs now.
        expect(onEnable).toHaveBeenCalledOnce();
        // The affordance is gone.
        expect(isNetworkOptInOpen()).toBe(false);
    });

    it("Enable should NOT suppress future offers (network is simply on now)", () => {
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable: () => {} });
        press(".network-optin__enable");
        // Simulate a later session where network is off again (e.g. reload with
        // a workspace override): the accept must not have latched suppression.
        window.__i18n = { translations: {}, isMac: false, network: false };
        expect(shouldOfferNetworkOptIn()).toBe(true);
    });

    it("dismiss should close it and suppress the rest of the session", () => {
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable: () => {} });
        press(".network-optin__dismiss");

        expect(isNetworkOptInOpen()).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
        // A second offer is now a no-op ("don't nag").
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable: () => {} });
        expect(isNetworkOptInOpen()).toBe(false);
    });

    it("Escape should dismiss it", () => {
        offerNetworkOptIn({ label: "x", anchorRect: null, onEnable: () => {} });
        expect(isNetworkOptInOpen()).toBe(true);

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(isNetworkOptInOpen()).toBe(false);
        expect(shouldOfferNetworkOptIn()).toBe(false);
    });
});
