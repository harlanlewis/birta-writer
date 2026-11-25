/**
 * harperService filtering: Harper's raw lints are post-filtered before they
 * reach the webview. The key case here is the space-mask bug — inline code (and
 * other non-prose inline nodes) is masked with the placeholder char, and any
 * lint touching that placeholder is noise about content the reader can't see,
 * so it's dropped regardless of lint kind. Harper itself is mocked; we only
 * exercise the filtering in lintBlocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { INLINE_PLACEHOLDER } from "../../shared/proofreadFilter";

type RawLint = {
    span: () => { start: number; end: number };
    message: () => string;
    lint_kind_pretty: () => string;
    suggestions: () => Array<{ get_replacement_text: () => string }>;
};

function rawLint(start: number, end: number, kind: string, message: string): RawLint {
    return {
        span: () => ({ start, end }),
        message: () => message,
        lint_kind_pretty: () => kind,
        suggestions: () => [],
    };
}

// The lints the fake linter returns for a given block text; set per test.
let nextLints: RawLint[] = [];

vi.mock("harper.js", () => ({
    LocalLinter: class {
        async setup(): Promise<void> {}
        async lint(): Promise<RawLint[]> { return nextLints; }
    },
    createBinaryModuleFromUrl: () => ({}),
}));

// Import after the mock is registered.
import { lintBlocks } from "../utils/harperService";

describe("lintBlocks filtering", () => {
    beforeEach(() => {
        nextLints = [];
        vi.clearAllMocks();
    });

    it("a grammar lint landing on a masked (placeholder) span should be dropped", async () => {
        // "see ￼￼￼ here" — the placeholders stand in for masked inline code.
        const text = `see ${INLINE_PLACEHOLDER.repeat(3)} here`;
        const codeStart = 4;
        nextLints = [
            rawLint(codeStart, codeStart + 3, "Grammar", "There are 3 spaces where there should be only one."),
        ];

        const [result] = await lintBlocks([{ key: 0, text }]);

        expect(result.lints).toHaveLength(0);
    });

    it("a real lint on visible prose should survive", async () => {
        const text = `teh ${INLINE_PLACEHOLDER.repeat(3)} here`;
        nextLints = [
            rawLint(0, 3, "Spelling", "Did you mean “the”?"),
        ];

        const [result] = await lintBlocks([{ key: 0, text }]);

        expect(result.lints).toHaveLength(1);
        expect(result.lints[0]).toMatchObject({ start: 0, end: 3, kind: "Spelling" });
    });

    it("a mix should keep the prose lint and drop the masked one", async () => {
        const text = `teh ${INLINE_PLACEHOLDER.repeat(3)} here`;
        nextLints = [
            rawLint(0, 3, "Spelling", "Did you mean “the”?"),
            rawLint(4, 7, "Grammar", "There are 3 spaces where there should be only one."),
        ];

        const [result] = await lintBlocks([{ key: 0, text }]);

        expect(result.lints).toHaveLength(1);
        expect(result.lints[0].kind).toBe("Spelling");
    });
});

describe("lintBlocks user dictionary", () => {
    beforeEach(() => {
        nextLints = [];
        vi.clearAllMocks();
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
            get: vi.fn((key: string, defaultValue?: unknown) => (key === "spellCheck.userWords" ? ["API", "frontmatter"] : defaultValue)),
            inspect: vi.fn(() => undefined),
            update: vi.fn(async () => undefined),
        } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
    });

    it("a dictionary word flagged as Capitalization should be dropped", async () => {
        // harper 3 files a lowercase "api" under Capitalization, not Spelling.
        nextLints = [rawLint(9, 12, "Capitalization", "This word should be capitalized.")];

        const [result] = await lintBlocks([{ key: 0, text: "Call the api now." }]);

        expect(result.lints).toHaveLength(0);
    });

    it("a dictionary word flagged as Spelling should be dropped", async () => {
        nextLints = [rawLint(14, 25, "Spelling", "Did you mean “front matter”?")];

        const [result] = await lintBlocks([{ key: 0, text: "Put it in the frontmatter." }]);

        expect(result.lints).toHaveLength(0);
    });

    it("a Capitalization finding on a word outside the dictionary should survive", async () => {
        nextLints = [rawLint(9, 13, "Capitalization", "This word should be capitalized.")];

        const [result] = await lintBlocks([{ key: 0, text: "Edit the html now." }]);

        expect(result.lints).toHaveLength(1);
    });

    it("a grammar finding on a dictionary word should survive", async () => {
        nextLints = [rawLint(9, 12, "Grammar", "Something else is wrong here.")];

        const [result] = await lintBlocks([{ key: 0, text: "Call the api now." }]);

        expect(result.lints).toHaveLength(1);
    });
});
