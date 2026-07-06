/**
 * Harper grammar/spell engine, hosted in the extension process.
 *
 * The webview sends plain-text blocks; this service lints them with Harper
 * (Automattic's offline Rust engine via WASM) and returns plain DTOs with
 * character spans, messages, and replacement suggestions. Lints on tech-like
 * tokens (paths, identifiers) and words in the user's dictionary are
 * filtered here so the webview only renders real findings.
 */
import * as path from "path";
import { pathToFileURL } from "url";
import * as vscode from "vscode";
import type { HarperLint, LintBlock, LintBlockResult } from "../../shared/messages";
import { isTechSpan } from "../../shared/proofreadFilter";

type HarperLinter = {
    setup(): Promise<void>;
    lint(text: string, options?: { language?: string }): Promise<HarperRawLint[]>;
};

type HarperRawLint = {
    span(): { start: number; end: number };
    message(): string;
    lint_kind_pretty(): string;
    suggestions(): Array<{ get_replacement_text(): string }>;
};

let linterPromise: Promise<HarperLinter> | null = null;

async function createLinter(): Promise<HarperLinter> {
    // harper.js is ESM-only; esbuild bundles it into this CJS bundle, and the
    // WASM binary is copied to dist/ at build time (see esbuild.mjs).
    const harper = await import("harper.js");
    const wasmUrl = pathToFileURL(path.join(__dirname, "harper_wasm_bg.wasm")).href;
    const linter = new harper.LocalLinter({
        binary: harper.createBinaryModuleFromUrl(wasmUrl),
    }) as unknown as HarperLinter;
    await linter.setup();
    return linter;
}

/** Lazily create the linter (~380ms setup + ~300MB resident; only when used). */
function getLinter(): Promise<HarperLinter> {
    if (!linterPromise) {
        linterPromise = createLinter().catch((err) => {
            linterPromise = null;
            throw err;
        });
    }
    return linterPromise;
}

function userWords(): Set<string> {
    const words = vscode.workspace
        .getConfiguration("markdownWysiwyg")
        .get<string[]>("spellCheck.userWords", []);
    return new Set(words.map((w) => w.toLowerCase()));
}

/** Kinds where a flagged tech-like token (path, camelCase…) is noise, not prose. */
const TOKEN_KINDS = new Set(["Spelling", "Typo", "Capitalization", "BoundaryError", "Word Choice"]);

export async function lintBlocks(blocks: LintBlock[]): Promise<LintBlockResult[]> {
    const linter = await getLinter();
    const dictionary = userWords();
    const results: LintBlockResult[] = [];

    for (const block of blocks) {
        const raw = await linter.lint(block.text, { language: "plain" });
        const lints: HarperLint[] = [];
        for (const lint of raw) {
            const span = lint.span();
            const spanText = block.text.slice(span.start, span.end);
            const kind = lint.lint_kind_pretty();
            if (TOKEN_KINDS.has(kind) && isTechSpan(block.text, span.start, span.end)) { continue; }
            if (kind === "Spelling" && dictionary.has(spanText.toLowerCase())) { continue; }
            lints.push({
                start: span.start,
                end: span.end,
                kind,
                message: lint.message(),
                suggestions: lint.suggestions().map((s) => s.get_replacement_text()).slice(0, 5),
            });
        }
        results.push({ key: block.key, lints });
    }
    return results;
}
