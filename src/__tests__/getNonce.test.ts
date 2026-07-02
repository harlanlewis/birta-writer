import { describe, it, expect } from "vitest";
import { getNonce } from "../../src/utils/getNonce";

describe("getNonce", () => {
    it("returns a string type", () => {
        expect(typeof getNonce()).toBe("string");
    });

    it("returns the base64 encoding of 16 bytes (length 24)", () => {
        // The base64 encoding of 16 bytes is always 24 characters (including padding =)
        expect(getNonce()).toHaveLength(24);
    });

    it("contains only valid base64 characters", () => {
        const nonce = getNonce();
        expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("two consecutive calls generate different nonces (uniqueness)", () => {
        const n1 = getNonce();
        const n2 = getNonce();
        // Randomness makes a collision extremely unlikely; a collision would indicate randomness failure
        expect(n1).not.toBe(n2);
    });

    it("generates 100 nonces in bulk, all unique", () => {
        const nonces = new Set(Array.from({ length: 100 }, () => getNonce()));
        expect(nonces.size).toBe(100);
    });
});
