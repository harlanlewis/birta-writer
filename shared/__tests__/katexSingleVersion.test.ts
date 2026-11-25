/**
 * Exactly one KaTeX in the tree.
 *
 * `katex` is not only ours. `micromark-extension-math` asks for `^0.16` and
 * `mermaid` for `^0.18`, neither of which admits our direct dependency's
 * version, so left alone the tree resolves more than one copy. The `katex`
 * override in `pnpm-workspace.yaml` is what holds them together, and its
 * comment says what retires it.
 *
 * Two copies is the state to refuse, and the bytes are the smaller half of why.
 * `dist/katex.css` is emitted from OUR KaTeX alone, and 0.18 prefixed 21
 * generic class names (`.base` to `.katex-base`, and `.accent`, `.hline`,
 * `.strut` and the rest). Math rendered by another copy carries the names
 * that stylesheet no longer has rules for, so one document would render math
 * through two engines against a stylesheet written for one of them.
 *
 * So this reads the lockfile rather than any one mechanism: one resolved
 * version is the requirement, and how it is achieved is the open question.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");

/** Every distinct `katex` version the lockfile resolves, `@types/katex` aside. */
function resolvedKatexVersions(): string[] {
    const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
    const versions = new Set<string>();
    for (const m of lock.matchAll(/^\s*'?katex@(\d+\.\d+\.\d+)'?:/gm)) {
        versions.add(m[1]);
    }
    return [...versions].sort();
}

describe("katex resolution", () => {
    it("the lockfile should resolve exactly one katex version", () => {
        // Arrange
        const versions = resolvedKatexVersions();
        // Assert: the count is the point, but a zero would mean the pattern
        // stopped matching the lockfile's shape rather than that KaTeX left the
        // tree, and a guard that silently matches nothing passes forever.
        expect(versions.length).toBeGreaterThan(0);
        expect(versions).toHaveLength(1);
    });

    it("the resolved katex should satisfy what package.json declares", () => {
        // Arrange
        const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
        const declaredMajorMinor = String(pkg.dependencies.katex).replace(/^\D*/, "")
            .split(".").slice(0, 2).join(".");
        // Act
        const [resolved] = resolvedKatexVersions();
        // Assert: the one copy is the one we asked for, rather than a
        // transitive line everything happened to agree on.
        expect(resolved.startsWith(`${declaredMajorMinor}.`)).toBe(true);
    });
});
