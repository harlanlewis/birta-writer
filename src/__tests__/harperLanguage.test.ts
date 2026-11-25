/**
 * Which language harperService lints in, judged by the real engine rather
 * than by the option it passes (MAR-508). harperService.test.ts mocks harper
 * and can only read the constant back; this asks harper itself what each
 * language makes of text shaped like what the webview sends.
 *
 * The webview sends a block's extracted text, so a leading `#` in it is a
 * character the writer typed (a file's `\#`), never a heading.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { pathToFileURL } from "url";
import { budget } from "../../webview/__tests__/helpers/testBudget";
import { LINT_LANGUAGE } from "../utils/harperService";

type Lint = { lint_kind_pretty(): string };
type Linter = {
    setup(): Promise<void>;
    lint(text: string, options: { language: string }): Promise<Lint[]>;
};

let linter: Linter;

beforeAll(async () => {
    const harper = await import("harper.js");
    const wasm = path.resolve(__dirname, "../../node_modules/harper.js/dist/harper_wasm_bg.wasm");
    linter = new harper.LocalLinter({
        binary: harper.createBinaryModuleFromUrl(pathToFileURL(wasm).href),
    }) as unknown as Linter;
    await linter.setup();
}, budget(30_000));

const kinds = async (text: string, language: string): Promise<string[]> =>
    (await linter.lint(text, { language })).map((l) => l.lint_kind_pretty());

describe("harper lint language", () => {
    const literalHash = "# the meeting notes for today";

    it("markdown should read a literal leading hash as a heading and flag its case", async () => {
        // The control: without it the next case could pass because harper
        // flags nothing about this text in any language.
        expect(await kinds(literalHash, "markdown")).toContain("Capitalization");
    });

    it("the shipped language should not read a literal leading hash as a heading", async () => {
        expect(await kinds(literalHash, LINT_LANGUAGE)).not.toContain("Capitalization");
    });

    it("the shipped language should still flag an ordinary misspelling", async () => {
        // Plain text is not lint-nothing: the engine still answers.
        expect(await kinds("This sentense has a typo.", LINT_LANGUAGE)).toContain("Spelling");
    });
});
