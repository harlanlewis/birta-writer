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
import { readBirtaSetting } from "../config";
import type { HarperLint, LintBlock, LintBlockResult } from "../../shared/messages";
import { INLINE_PLACEHOLDER, isTechSpan } from "../../shared/proofreadFilter";

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

/** The user's words: lowercased for spelling, and as written for case. */
function userWords(): { folded: Set<string>; asWritten: Set<string> } {
    // Through the config seam (src/config.ts) like every other birta.* read.
    const words = readBirtaSetting("userWords");
    return { folded: new Set(words.map((w) => w.toLowerCase())), asWritten: new Set(words) };
}

/** Kinds where a flagged tech-like token (path, camelCase…) is noise, not prose. */
const TOKEN_KINDS = new Set(["Spelling", "Typo", "Capitalization", "BoundaryError", "Word Choice"]);

/**
 * Does a `birta.spellCheck.userWords` entry silence this finding? A word
 * somebody added is one they spell that way on purpose.
 *
 * Spelling is answered case-insensitively, as the dictionary always has been.
 * Capitalization is a finding about case alone, so it is silenced only where
 * the span is written exactly as the entry is: harper files a lowercase word
 * it knows in capitals (`api`, `html`) there rather than under Spelling, and
 * an entry `api` means the writer wants it lowercase, while an entry spelled
 * with capitals says nothing in favour of the lowercase form. A suggestion
 * that only capitalizes the first letter is the sentence-start rule, which no
 * entry overrules.
 */
function silencedByDictionary(
    kind: string,
    spanText: string,
    suggestions: string[],
    dictionary: { folded: Set<string>; asWritten: Set<string> },
): boolean {
    if (kind === "Spelling") return dictionary.folded.has(spanText.toLowerCase());
    if (kind !== "Capitalization" || !dictionary.asWritten.has(spanText)) return false;
    const sentenceStart = spanText.charAt(0).toUpperCase() + spanText.slice(1);
    return !suggestions.includes(sentenceStart);
}

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
            // Any lint touching a masked span (inline code, images, escaped
            // pipes → placeholder chars) is about content the reader can't see
            // as prose, so it's noise regardless of kind — Harper's "N spaces"
            // and whitespace lints landed here before inline code was masked
            // with the placeholder instead of spaces. Drop them unconditionally.
            if (spanText.includes(INLINE_PLACEHOLDER)) { continue; }
            if (TOKEN_KINDS.has(kind) && isTechSpan(block.text, span.start, span.end)) { continue; }
            const suggestions = lint.suggestions().map((s) => s.get_replacement_text());
            if (silencedByDictionary(kind, spanText, suggestions, dictionary)) { continue; }
            lints.push({
                start: span.start,
                end: span.end,
                kind,
                message: lint.message(),
                suggestions: suggestions.slice(0, 5),
            });
        }
        results.push({ key: block.key, lints });
    }
    return results;
}
