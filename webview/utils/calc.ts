/**
 * webview/utils/calc.ts
 *
 * A tiny, deterministic arithmetic evaluator and the caret-detection helper
 * behind inline calc-on-`=` ("Math Notes", MAR-177). Typing an arithmetic
 * expression immediately followed by `=` (e.g. `12 * 4 =`) computes the result
 * so the editor can offer it as an advisory suggestion or, opt-in, insert it.
 *
 * SAFETY IS THE WHOLE POINT. This never touches `eval`, `new Function`, or any
 * other dynamic-code path, and it never reaches the network or an LLM. It is a
 * hand-written recursive-descent parser over a fixed token set: digits, the
 * binary operators `+ - * / % ^` (plus `**` as an alias for `^`), parentheses,
 * and unary +/-. Anything containing a letter or any other character —
 * identifiers, `alert(1)`, `1e3` scientific notation, hex — is rejected at the
 * tokenizer, so there are no variables and therefore no side effects. Malformed
 * or non-computable input (unbalanced parens, a trailing operator, division by
 * zero, an overflow to Infinity) yields `null`, and the caller shows nothing.
 *
 * The result is always plain text — a number written into the document as
 * ordinary prose. Nothing about calc persists in the markdown; the file
 * round-trips exactly as if the digits had been typed by hand (the phase-0
 * fidelity line: no new node type, no marker).
 *
 * Operator semantics worth pinning down:
 * - `%` is the REMAINDER operator (binary infix, same precedence as `*` and
 *   `/`; JS `%`, truncated toward zero): `10 % 3` is `1` and `-10 % 3` is `-1`
 *   — not percent, and not the always-positive mathematical modulo.
 *   Percent-as-postfix is ambiguous with remainder, so we take the
 *   unambiguous, deterministic reading.
 * - `^` (and `**`) is exponentiation, right-associative, binding TIGHTER than
 *   unary minus — `-2 ^ 2` is `-(2 ^ 2)` = `-4`, matching ordinary math.
 * - No scientific notation: `1e3` contains a letter and is rejected. This is a
 *   deliberate choice — it keeps the accepted grammar something a reader can
 *   see is pure arithmetic, and avoids surprising a user who typed `1e3` as
 *   prose.
 */

/** Precedence-climbing grammar (low → high):
 *   expr   := term   (('+' | '-') term)*
 *   term   := factor (('*' | '/' | '%') factor)*
 *   factor := ('+' | '-') factor | power        // unary, looser than '^'
 *   power  := primary ('^' factor)?             // right-associative
 *   primary := number | ident | fn '(' expr ')' | '(' expr ')'
 *              // ident/fn only on the identifier-allowing (`=>`/block) path
 */
import { calcUnitsReady, convertUnit, isKnownUnit, unitsCompatible } from "./calcUnits";

/**
 * The function table for the identifier-allowing path — a FIXED map of pure
 * numeric functions, matched case-insensitively. This is the whole call
 * surface: a name not in this map is a parse error, so `alert(1)` (rejected
 * at the tokenizer on the `=` path, an unknown function here) can never
 * become a call. `log` is base-10, the note-taking convention; `ln` is the
 * natural log.
 */
const FUNCTIONS = new Map<string, (x: number) => number>([
    ["sqrt", Math.sqrt],
    ["abs", Math.abs],
    ["ln", Math.log],
    ["log", Math.log10],
    ["log10", Math.log10],
    ["log2", Math.log2],
    ["exp", Math.exp],
    ["sin", Math.sin],
    ["cos", Math.cos],
    ["tan", Math.tan],
    ["asin", Math.asin],
    ["acos", Math.acos],
    ["atan", Math.atan],
    ["round", Math.round],
    ["floor", Math.floor],
    ["ceil", Math.ceil],
]);

/**
 * Constants, matched case-insensitively — resolved only AFTER the caller's
 * scope, so a user's own `pi = 3` definition always wins. Euler's `e` is
 * deliberately NOT here: `e` is among the most common variable names, and a
 * missing/broken `e = …` definition silently resolving to 2.718282 is worse
 * than no answer (`exp(1)` gives Euler when genuinely wanted).
 */
const CONSTANTS = new Map<string, number>([
    ["pi", Math.PI],
    ["π", Math.PI],
    ["tau", 2 * Math.PI],
    ["τ", 2 * Math.PI],
]);

/** Unicode superscript digits, read as an exponent: `c²` ≡ `c^2`. */
const SUPERSCRIPT_DIGITS: Record<string, string> = {
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};
const SUPERSCRIPT_CLASS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

type Token =
    | { kind: "num"; value: number }
    | { kind: "ident"; name: string }
    | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
    | { kind: "lparen" }
    | { kind: "rparen" };

// ── The grammar's character classes — SINGLE SOURCE ──────────────────────────
// Every detection surface (the `=` caret detection here, the auto-insert input
// rule, the refresh scanner) builds its regex from these constants, so
// extending the grammar is a one-line change instead of six synchronized edits.

/** Class body: characters of a pure-arithmetic run (letters excluded; the
 * superscript digits read as exponents, so `5²` is arithmetic). */
export const ARITHMETIC_CLASS = "0-9.+\\-*/%^()⁰¹²³⁴⁵⁶⁷⁸⁹";
/** One arithmetic-run character, whitespace included (tokenizer pre-check). */
const EXPR_CHAR = new RegExp(`[${ARITHMETIC_CLASS}\\s]`);
/** The binary/unary operator characters, as a test for "contains an operator"
 * — a superscript digit IS an exponentiation. */
const HAS_OPERATOR = /[+\-*/%^⁰¹²³⁴⁵⁶⁷⁸⁹]/;
/** An expression that STARTS with a binary operator (left-operand suspicion). */
const OP_HEAD = /^[+\-*/%^]/;
/** The first character of an identifier (variable name): a letter, `_`, or a
 * constant glyph (`π`, `τ`). */
const IDENT_START = /[A-Za-zπτ_]/;
/** A subsequent identifier character: letter, digit, `_`, or constant glyph. */
const IDENT_CHAR = /[A-Za-z0-9πτ_]/;

/**
 * Splits `input` into tokens, or returns null the moment it sees anything that
 * is not part of the grammar — `,`, `$`, `=`, whatever. `**` collapses to a
 * single `^` token. A number must carry at least one digit (`.` alone is not a
 * number), and may carry at most one decimal point.
 *
 * `allowIdent` gates variable support: with it false (the default arithmetic
 * path, e.g. the `=` calc) a LETTER is rejected, keeping that grammar pure
 * digits-and-operators; with it true (the `=>` path) a run of identifier
 * characters becomes an `ident` token resolved later against a scope. The two
 * modes keep the `=` feature's "no identifiers, no surprises" contract intact.
 */
function tokenize(input: string, allowIdent: boolean): Token[] | null {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }

        if (allowIdent && IDENT_START.test(ch)) {
            let name = "";
            while (i < input.length && IDENT_CHAR.test(input[i])) { name += input[i]; i++; }
            tokens.push({ kind: "ident", name });
            continue;
        }
        // A superscript-digit run is an exponent: `c²` ≡ `c^2`, `2¹⁰` ≡ `2^10`.
        // Available on BOTH paths — a superscript is visibly arithmetic, so it
        // doesn't breach the `=` path's "pure digits and operators" contract.
        if (SUPERSCRIPT_DIGITS[ch] !== undefined) {
            let digits = "";
            while (i < input.length && SUPERSCRIPT_DIGITS[input[i]] !== undefined) {
                digits += SUPERSCRIPT_DIGITS[input[i]];
                i++;
            }
            tokens.push({ kind: "op", value: "^" });
            tokens.push({ kind: "num", value: parseFloat(digits) });
            continue;
        }
        if (!EXPR_CHAR.test(ch)) { return null; } // a letter or stray symbol → not arithmetic

        if (ch >= "0" && ch <= "9" || ch === ".") {
            let numStr = "";
            let dots = 0;
            while (i < input.length && (input[i] >= "0" && input[i] <= "9" || input[i] === ".")) {
                if (input[i] === ".") { dots++; }
                numStr += input[i];
                i++;
            }
            if (dots > 1 || !/[0-9]/.test(numStr)) { return null; } // `1.2.3` or a lone `.`
            tokens.push({ kind: "num", value: parseFloat(numStr) });
            continue;
        }

        if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
        if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }

        if (ch === "*" && input[i + 1] === "*") {
            tokens.push({ kind: "op", value: "^" }); // `**` is an exponent alias
            i += 2;
            continue;
        }
        if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "^") {
            tokens.push({ kind: "op", value: ch });
            i++;
            continue;
        }
        return null; // unreachable given EXPR_CHAR, but keeps the switch total
    }
    return tokens;
}

/** Thrown for div/mod by zero; caught at the top and turned into `null`. */
class CalcError extends Error {}

/**
 * A single-pass recursive-descent parser/evaluator over the token stream.
 *
 * `structural` mode answers only "is this a well-formed expression?" — value
 * errors (division by zero, an unknown identifier) do not fail the parse, and
 * every identifier resolves to a dummy. It exists because structure and value
 * are different questions: `x / (y - 1)` is a perfectly-formed expression even
 * though evaluating it with placeholder values would divide by zero, and the
 * `=>` span detection must judge the SHAPE from the visible text alone (the
 * real scope is only known later, at fetch time).
 */
class Parser {
    private pos = 0;
    constructor(
        private readonly tokens: Token[],
        /**
         * Resolves an identifier to its numeric value, or `undefined` for an
         * unknown name (→ CalcError → the whole expression yields null). Absent
         * on the pure-arithmetic path, where no `ident` token can ever appear.
         */
        private readonly resolve?: (name: string) => number | undefined,
        private readonly structural = false,
    ) {}

    atEnd(): boolean {
        return this.pos >= this.tokens.length;
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    /** Consumes and returns the current operator when it is one of `ops`. */
    private eatOp(ops: readonly string[]): string | null {
        const tok = this.peek();
        if (tok && tok.kind === "op" && ops.includes(tok.value)) {
            this.pos++;
            return tok.value;
        }
        return null;
    }

    parseExpr(): number {
        let left = this.parseTerm();
        for (;;) {
            const op = this.eatOp(["+", "-"]);
            if (!op) { return left; }
            const right = this.parseTerm();
            left = op === "+" ? left + right : left - right;
        }
    }

    private parseTerm(): number {
        let left = this.parseFactor();
        for (;;) {
            const op = this.eatOp(["*", "/", "%"]);
            if (!op) { return left; }
            const right = this.parseFactor();
            if (op === "*") {
                left = left * right;
            } else if (op === "/") {
                if (right === 0 && !this.structural) { throw new CalcError("division by zero"); }
                left = right === 0 ? 0 : left / right;
            } else {
                if (right === 0 && !this.structural) { throw new CalcError("remainder by zero"); }
                left = right === 0 ? 0 : left % right;
            }
        }
    }

    private parseFactor(): number {
        const op = this.eatOp(["+", "-"]);
        if (op) {
            const operand = this.parseFactor(); // unary chains: `--5`, `-+5`
            return op === "-" ? -operand : operand;
        }
        return this.parsePower();
    }

    private parsePower(): number {
        const base = this.parsePrimary();
        if (this.eatOp(["^"])) {
            // Right-associative, and the exponent may itself be unary (`2^-3`),
            // so recurse through parseFactor rather than parsePower.
            const exp = this.parseFactor();
            return base ** exp;
        }
        return base;
    }

    private parsePrimary(): number {
        const tok = this.peek();
        if (!tok) { throw new CalcError("unexpected end of input"); }
        if (tok.kind === "num") {
            this.pos++;
            return tok.value;
        }
        if (tok.kind === "ident") {
            this.pos++;
            // A KNOWN function name followed by `(` is a call — the only call
            // syntax there is; an unknown name before `(` falls through to the
            // variable path, whose leftover `(…)` then fails the parse (no
            // implicit multiplication, no surprise calls).
            const fn = FUNCTIONS.get(tok.name.toLowerCase());
            if (fn && this.peek()?.kind === "lparen") {
                this.pos++;
                const arg = this.parseExpr();
                const close = this.peek();
                if (!close || close.kind !== "rparen") { throw new CalcError("unbalanced parentheses"); }
                this.pos++;
                return fn(arg);
            }
            if (this.structural) { return 1; } // any name is resolvable in shape-land
            const value = this.resolve?.(tok.name) ?? CONSTANTS.get(tok.name.toLowerCase());
            if (value === undefined || !Number.isFinite(value)) {
                throw new CalcError(`unknown or non-finite variable: ${tok.name}`);
            }
            return value;
        }
        if (tok.kind === "lparen") {
            this.pos++;
            const value = this.parseExpr();
            const close = this.peek();
            if (!close || close.kind !== "rparen") { throw new CalcError("unbalanced parentheses"); }
            this.pos++;
            return value;
        }
        throw new CalcError("expected a number or '('");
    }
}

/**
 * Evaluates an arithmetic expression. Returns the numeric result, or `null`
 * for anything not a single complete, finite value: malformed syntax, leftover
 * tokens, division or remainder by zero, or an overflow to ±Infinity / NaN.
 *
 * `resolve` opts into variable support (the `=>` path): when provided,
 * identifiers are tokenized and resolved through it — an unknown name yields
 * `null`, exactly like a syntax error. Without it (the default `=` path) any
 * letter is rejected at the tokenizer, so the grammar stays pure arithmetic
 * with no identifiers and therefore no scope to consult.
 */
export function evaluateExpression(
    input: string,
    resolve?: (name: string) => number | undefined,
): number | null {
    const tokens = tokenize(input, resolve !== undefined);
    if (!tokens || tokens.length === 0) { return null; }
    try {
        const parser = new Parser(tokens, resolve);
        const value = parser.parseExpr();
        if (!parser.atEnd()) { return null; } // trailing junk, e.g. `2 3` or `2 (3)`
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Whether `input` parses as a well-formed expression with identifiers allowed
 * — structure only, values ignored (see Parser's `structural` mode). This is
 * the parse-without-evaluating check: `x / (y - 1)` is valid here even though
 * no scope is consulted, and `x *` is not.
 */
function isValidExpressionStructure(input: string): boolean {
    const tokens = tokenize(input, true);
    if (!tokens || tokens.length === 0) { return false; }
    try {
        const parser = new Parser(tokens, undefined, true);
        parser.parseExpr();
        return parser.atEnd();
    } catch {
        return false;
    }
}

/**
 * Displayed decimal places are capped here: a fractional tail beyond this reads
 * as noise, not an answer (`3 km in mi` should say `1.864114`, not
 * `1.86411357671`) — and on the inline paths the display IS what gets inserted
 * into prose. The source expression always remains, so nothing is lost to the
 * rounding; block scopes chain on full-precision values, never on the display.
 */
const MAX_DISPLAY_DECIMALS = 6;

/**
 * Formats a numeric result as the plain text shown beside — or inserted into —
 * the document, or `null` when no HONEST plain-digits rendering exists. This is
 * the one formatting policy for every calc surface (`=`, `=>`, the block
 * ledger); a `null` means the caller shows/offers nothing.
 *
 * Refusals, and why:
 * - Non-finite values (overflow, NaN): not a number a reader can use.
 * - Whole numbers beyond `Number.isSafeInteger`: a double can't represent every
 *   integer past 2^53, so printing full digits would MANUFACTURE precision
 *   (`2^60` → `…4610000000000`, wrong by millions). `toPrecision` has the same
 *   problem for 13+-digit safe integers, which is why safe integers print via
 *   `String` exactly.
 * - Exponent-shaped output (`1e+21`, `1e-9`): carries a letter, in a feature
 *   whose contract is "pure digits in, pure digits out".
 * - A nonzero value whose capped display would round to `0`: showing `0` for
 *   not-zero is a lie; better to show nothing.
 *
 * Fractional results are first rounded to 12 significant digits so float
 * artifacts never leak (`0.1 + 0.2` reads `0.3`), then capped to
 * MAX_DISPLAY_DECIMALS decimal places. `-0` normalizes to `0`.
 */
export function formatCalcResult(value: number): string | null {
    if (!Number.isFinite(value)) { return null; }
    const v = Object.is(value, -0) ? 0 : value;
    if (Number.isInteger(v)) {
        return Number.isSafeInteger(v) ? String(v) : null;
    }
    const rounded = Number(v.toPrecision(12));
    const capped = Number(rounded.toFixed(MAX_DISPLAY_DECIMALS));
    if (capped === 0) { return null; } // tiny-but-nonzero would display as 0
    const text = String(Object.is(capped, -0) ? 0 : capped);
    return text.includes("e") ? null : text;
}

/** A detected calc construct ending at the caret. */
export interface CalcMatch {
    /**
     * Length in characters of the matched span through the caret — from the
     * expression's first char (trailing form, `5+7 =`) or from the `=`
     * (leading form, `=5+7`).
     */
    length: number;
    /** The pure arithmetic expression (trimmed), e.g. `12 * 4`. */
    expr: string;
    /** The formatted result text, e.g. `48`. */
    result: string;
}

/** The `=` (with any trailing spaces/tabs) that ends the text before the caret. */
const TRAILING_EQUALS = /=[ \t]*$/;
/** The maximal run of arithmetic characters immediately before that `=`. */
const TRAILING_EXPR = new RegExp(`[${ARITHMETIC_CLASS} \\t]*$`);
/**
 * The LEADING form: `=<expr>` ending at the caret, with the `=` at line start
 * or after whitespace — `a=5+7` is a prose assignment (no boundary) and
 * `==x` never matches (the char class excludes `=`, and the second `=` has no
 * boundary before it).
 */
const LEADING_FORM = new RegExp(`(^|[ \\t])=([${ARITHMETIC_CLASS} \\t]+)$`);

/**
 * Detects an arithmetic expression that ends, at the caret, in `=` (optionally
 * followed by spaces the user already typed). Returns the matched span, the
 * expression, and its formatted result — or null when the text before the
 * caret is not a computable expression-then-`=`.
 *
 * Detection is deliberately narrow, so ordinary prose containing `=` is never
 * hijacked (the same discipline as pasteLink.ts's URL detection):
 * - The text must end in `=`; the caret sits right after it. Prose like
 *   `x = y` never matches, because when the caret is at `y` the text does not
 *   end in `=`.
 * - The characters immediately before `=` must be a pure arithmetic run that
 *   parses to a finite value. `x =` (a letter), `a==b` (the char before the
 *   second `=` is `=`, not an expression char), and `==highlight==` all fail.
 * - The expression must contain at least one operator, so echoing a bare
 *   number back (`the answer is 42 =` → `42`) never triggers.
 */
export function detectCalcExpression(
    textBefore: string,
    opts?: {
        /**
         * True when `textBefore` may be CUT SHORT of the real line start (the
         * caret-suggest window is the last ≤500 chars; ProseMirror input
         * rules cap similarly). Position 0 is then an arbitrary cut point,
         * not a line boundary — any match that needs to TRUST position 0
         * (a leading `=` anchored there; a trailing run starting there,
         * whose token-split guard can't see the preceding char) is refused,
         * because the invisible context could make the visible run a
         * fragment — and a fragment computes a WRONG answer.
         */
        boundaryUnknown?: boolean;
    },
): CalcMatch | null {
    const eq = TRAILING_EQUALS.exec(textBefore);
    if (!eq) { return detectLeadingForm(textBefore, opts?.boundaryUnknown ?? false); }
    const beforeEquals = textBefore.slice(0, eq.index);
    const run = TRAILING_EXPR.exec(beforeEquals)?.[0] ?? "";
    const expr = run.trim();
    if (!expr || !HAS_OPERATOR.test(expr)) { return null; }
    const runStart = eq.index - run.length;
    // A run starting at position 0 of a possibly-truncated window: the char
    // before it is invisible, so the token-split guard below cannot rule out
    // that this run is the TAIL of a larger token (`1,000…` with the comma cut
    // off). Refuse rather than risk computing a fragment.
    if (runStart === 0 && opts?.boundaryUnknown) { return null; }
    // Left-boundary discipline. The run is the MAXIMAL trailing span of
    // arithmetic characters, so whatever precedes it is not arithmetic — but
    // the run can still be a fragment of a larger token, and evaluating a
    // fragment produces a silently WRONG answer, the worst possible outcome:
    // - `1,000 + 2 =`: the run is `000 + 2` (the comma breaks it) — offering
    //   `2` would be a lie. When the run touches a word-ish character
    //   (letter/digit/comma/underscore) with no space between, reject.
    //   `€5+5 =` still works: currency glyphs aren't token glue.
    // - `x - 4 =`: the run is ` - 4` — its leading operator has a left operand
    //   (the variable) outside the grammar, so `-4` answers a question the
    //   user didn't ask. A run that starts with an operator is only unary
    //   when nothing precedes it on the line (`- 4 =` at line start).
    // `is 3 + 4 =` keeps working: a space separates the prose from a run that
    // opens with its own number.
    if (runStart > 0) {
        const glued = run[0] !== " " && run[0] !== "\t";
        if (glued && TOKEN_GLUE.test(beforeEquals[runStart - 1])) { return null; }
        if (OP_HEAD.test(expr)) { return null; }
    }
    // Date-like shapes (`2026-07-17 =`) DO compute, as chained subtraction —
    // a deliberate maintainer ruling: any digits-and-operators run before `=`
    // is arithmetic. The `=` itself is the user's ask, and in the default
    // advisory mode the answer is only a suggestion — the path to "not math"
    // is to not type `=` (or not accept). The guards above exist solely for
    // runs that would compute a DIFFERENT question than the visible one
    // (split tokens, out-of-grammar operands), never for unwanted-but-honest
    // answers.
    const value = evaluateExpression(expr);
    if (value === null) { return null; }
    const result = formatCalcResult(value);
    if (result === null) { return null; }
    // Span from the expression's first character (after any leading run
    // whitespace) through the caret (the end of textBefore).
    const leadingWs = run.length - run.replace(/^[ \t]+/, "").length;
    const start = runStart + leadingWs;
    return { length: textBefore.length - start, expr, result };
}

/**
 * A character that can GLUE to the start of an arithmetic/calc run and make it
 * a fragment of a larger token — a letter, digit, comma (digit grouping), or
 * underscore immediately before the run means the run's head is the TAIL of
 * something bigger (`1,000` → `000`). Shared by every boundary guard.
 */
const TOKEN_GLUE = /[\p{L}\p{N},_]/u;

/**
 * The result-first form: `=5+7` at the caret offers `12`, accepted as
 * `12=5+7` — the result lands BEFORE the `=` (see applyCalcResult's caller).
 * The `=` must sit at line start or after whitespace, so prose assignments
 * (`a=5+7`) and `==`-delimited highlights never trigger.
 */
function detectLeadingForm(textBefore: string, boundaryUnknown: boolean): CalcMatch | null {
    const lead = LEADING_FORM.exec(textBefore);
    if (!lead) { return null; }
    // `^` matched at position 0 of a possibly-truncated window: the true
    // preceding char is invisible and could be a letter (`a=5+7` — a prose
    // assignment the boundary rule exists to reject). A real whitespace
    // boundary (lead[1] non-empty) is inside the window and stays trusted.
    if (boundaryUnknown && lead.index === 0 && lead[1] === "") { return null; }
    const expr = lead[2].trim();
    if (!expr || !HAS_OPERATOR.test(expr)) { return null; }
    const value = evaluateExpression(expr);
    if (value === null) { return null; }
    const result = formatCalcResult(value);
    if (result === null) { return null; }
    const start = lead.index + lead[1].length; // the `=` itself
    return { length: textBefore.length - start, expr, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Living calculation" layer: the `=>` operator, named variables, and OFFLINE
// unit conversion (MAR-196, Calca-inspired). Everything here is still the same
// deterministic, eval-free, network-free discipline as the `=` path above — an
// identifier is a lookup in a caller-supplied scope, never a code path. Unit
// conversion delegates to calcUnits.ts (a lazily-loaded, tree-shaken mathjs
// unit instance — catalog and factors maintained there, i.e. NOT here; user
// expressions never reach mathjs). Currency is deliberately absent: live
// rates would need the network, which the offline posture forbids.
// ─────────────────────────────────────────────────────────────────────────────

export { convertUnit, ensureCalcUnits } from "./calcUnits";

/** The parsed pieces of a `<numeric-expr> <fromUnit> (in|to) <toUnit>` form. */
interface UnitForm {
    numExpr: string;
    fromUnit: string;
    toUnit: string;
}

/**
 * Parses the unit-conversion SHAPE `<numeric-expr> <fromUnit> (in|to) <toUnit>`
 * — e.g. `3 km in mi`, `180 lb to kg`, `2 * 3 cups in ml` — without touching
 * values. The `in`/`to` keyword is matched right-anchored (so `min`/`into`
 * inside a word never trips it), the target unit is the final token, and the
 * source unit is the word right before the keyword; whatever precedes that is
 * the numeric expression. Returns null when the shape doesn't hold. Whether
 * the units are KNOWN is the caller's question, not a shape question.
 */
function parseUnitForm(input: string): UnitForm | null {
    // The keyword must be word-bounded (a non-letter, or start, before it) so
    // `min`/`into`/`ton` never trip it. That boundary char, when present, is
    // consumed by the group and belongs to the left (numeric-expr + unit) part.
    const sep = /(?:^|[^A-Za-z])(in|to)\s+([A-Za-z°]+)\s*$/.exec(input);
    if (!sep) { return null; }
    const toUnit = sep[2];
    const keywordAtStart = /^(in|to)/.test(sep[0]);
    const left = input.slice(0, sep.index + (keywordAtStart ? 0 : 1));
    const unitMatch = /([A-Za-z°]+)\s*$/.exec(left);
    if (!unitMatch) { return null; }
    const fromUnit = unitMatch[1];
    const numExpr = left.slice(0, unitMatch.index).trim();
    if (!numExpr) { return null; }
    return { numExpr, fromUnit, toUnit };
}

/** Evaluates a parsed unit form against `resolve`; null on any failure. */
function evaluateUnitForm(
    input: string,
    resolve: (name: string) => number | undefined,
): number | null {
    const form = parseUnitForm(input);
    if (!form) { return null; }
    const value = evaluateExpression(form.numExpr, resolve);
    if (value === null) { return null; }
    return convertUnit(value, form.fromUnit, form.toUnit);
}

/**
 * Evaluate a "living calculation" expression: either a unit conversion
 * (`3 km in mi`) or ordinary arithmetic with variables (`rent / budget * 100`).
 * `scope` supplies variable values; an unknown name (or a bad unit / shape)
 * yields null, so the caller shows nothing. This is the `=>` counterpart to the
 * `=` path's bare `evaluateExpression`.
 */
export function evaluateCalc(input: string, scope?: Map<string, number>): number | null {
    const resolve = (name: string): number | undefined => scope?.get(name);
    const unit = evaluateUnitForm(input, resolve);
    if (unit !== null) { return unit; }
    return evaluateExpression(input, resolve);
}

/**
 * Whether `input` is a well-FORMED living-calculation expression, independent
 * of whether its variables happen to be defined or its values divide cleanly —
 * a true parse-only check (Parser's structural mode), so `x / (y - 1)` is
 * valid here. The `=>` caret detection uses this to fix the highlighted span
 * from the visible text alone (the real scope, and thus the real result, is
 * only known later at fetch time); a structurally valid expression that
 * references an undefined variable simply produces no result then.
 *
 * The unit form is valid when its shape holds, its units are known and
 * compatible, and its numeric part is well-formed.
 */
export function isCalcStructurallyValid(input: string): boolean {
    const form = parseUnitForm(input);
    if (form && isValidExpressionStructure(form.numExpr)) {
        // With the unit engine loaded, require known compatible units. Before
        // it loads (it is lazy), accept the SHAPE: a bad unit then simply
        // yields no result at fetch time and nothing is offered —
        // under-promising is safe, guessing at the catalog is not.
        if (!calcUnitsReady() || unitsCompatible(form.fromUnit, form.toUnit)) { return true; }
    }
    return isValidExpressionStructure(input);
}

/** A detected `=>` construct ending at the caret. */
export interface ArrowMatch {
    /** Length in characters of the matched span (expression through the caret). */
    length: number;
    /** The chosen expression (trimmed), e.g. `rent / budget * 100` or `3 km in mi`. */
    expr: string;
}

/** The `=>` (with any trailing spaces/tabs) that ends the text before the caret. */
const TRAILING_ARROW = /=>[ \t]*$/;
/** Characters that may appear in a living-calc expression run (letters, the
 * constant glyphs, and superscript exponents allowed). */
const CALC_RUN = /[\wπτ⁰¹²³⁴⁵⁶⁷⁸⁹+\-*/%^().°'" \t]*$/u;
/**
 * A prose-ish token the `=>` trimming loop may drop from the front of the run:
 * it must contain a letter (it reads as a WORD — `the`, `total`, `costs.`,
 * `it's`), and it may not contain expression material (an operator or paren).
 * A pure number is deliberately NOT droppable: a leading number is either part
 * of the expression (`2 (3 + 4)` — dropping the `2` would compute a different
 * question) or the tail fragment of a bigger token (`1,000` → `000`), and both
 * must refuse rather than answer wrongly — the same "never compute a fragment"
 * rule the `=` path enforces.
 */
const DROPPABLE_TOKEN = /^[\w.'"°πτ]*[A-Za-zπτ_][\w.'"°πτ]*$/u;
/**
 * Caps that keep `detectArrowExpression` O(1) on the un-debounced keystroke path
 * (`match` runs per transaction). A real inline expression is short and sits
 * within a few tokens of the `=>`, so we only ever look at the tail of a long
 * prose line and drop a bounded number of leading words. Prose longer than this
 * before a `=>` simply isn't offered — the right trade for a per-keystroke hook.
 */
const MAX_ARROW_RUN = 160;
const MAX_ARROW_TOKEN_DROPS = 24;

/**
 * Detects a living-calculation expression that ends, at the caret, in `=>`
 * (optionally followed by spaces already typed). Unlike `=`, `=>` never occurs
 * in ordinary prose, so the trigger needs no hijack paranoia — but the run
 * before `=>` can contain letters (variables, units) and therefore ordinary
 * prose words, so the maximal trailing run is trimmed to its LONGEST suffix
 * that is a structurally valid expression, dropping leading tokens one at a
 * time (`the total x*2 =>` → `x*2`).
 *
 * The trimming carries the `=` path's full boundary discipline — every rule
 * exists to refuse a run that would compute a DIFFERENT question than the
 * visible one:
 * - only prose-ish WORDS are droppable (see DROPPABLE_TOKEN); hitting a number
 *   or expression material refuses (`2 (3+4) =>` offers nothing rather than 7);
 * - a run glued to a word-ish char (`1,000 + 2 =>` — the comma splits the
 *   token) must drop its fragment head, which, being a number, refuses;
 * - a chosen expression may start with an operator only when it IS the whole
 *   run at a true line start (`- 4 =>` is unary; after any drop or glue an
 *   operator head had a left operand we can't see).
 *
 * Returns the matched span and expression, or null when there is no `=>` or no
 * valid, non-trivial expression before it. A bare number (`42 =>`) is refused —
 * echoing it back is pointless — but a lone variable (`total =>`) is offered,
 * since showing a definition's value is the point.
 */
export function detectArrowExpression(
    textBefore: string,
    opts?: { boundaryUnknown?: boolean },
): ArrowMatch | null {
    const arrow = TRAILING_ARROW.exec(textBefore);
    if (!arrow) { return null; }
    const beforeArrow = textBefore.slice(0, arrow.index);
    const fullRun = CALC_RUN.exec(beforeArrow)?.[0] ?? "";
    // Only the tail can hold a (short) inline expression; capping it bounds the
    // per-keystroke tokenization. A capped run still yields correct positions
    // because it is a suffix and runStart is derived from its length.
    const capped = fullRun.length > MAX_ARROW_RUN;
    const run = capped ? fullRun.slice(fullRun.length - MAX_ARROW_RUN) : fullRun;
    const runStart = arrow.index - run.length;
    const trimmedRun = run.trim();
    if (!trimmedRun) { return null; }

    // The run's first token can never be trusted when either
    // - the run was length-CAPPED: the cut point is arbitrary, and the
    //   discarded head may bind the surviving tail (`1+1+…+1 =>` cut after an
    //   operator would otherwise answer the tail's sum — a fragment answer for
    //   a longer visible expression). Even a cut at whitespace is untrusted:
    //   the discarded prefix can end in a binding operator (`10 + <cut>…`); or
    // - the char before the run is word-ish (letter/digit/comma/underscore):
    //   the head is the TAIL of a larger token (`1,000` → `000`).
    // Either way, force the trimming loop to drop the first token before
    // considering anything — for genuine long expressions the head is a
    // number/paren, which is undroppable, so they refuse outright.
    const glued = capped || (runStart > 0
        && run[0] !== " " && run[0] !== "\t"
        && TOKEN_GLUE.test(beforeArrow[runStart - 1]));

    // Longest valid suffix: starting from the trimmed run, drop leading tokens
    // until what remains parses (or nothing does). Bounded by
    // MAX_ARROW_TOKEN_DROPS so a long prose line ending in `=>` stays cheap.
    let expr = trimmedRun;
    let drops = 0;
    for (;;) {
        const mustDrop = glued && drops === 0;
        if (!mustDrop
            && isCalcStructurallyValid(expr)
            && !isBareNumber(expr)
            // An operator head is only unary when the candidate is the whole
            // run at a true, untruncated line start.
            && !(OP_HEAD.test(expr) && (drops > 0 || runStart > 0 || opts?.boundaryUnknown))
        ) { break; }
        const sp = expr.search(/\s/);
        const head = sp === -1 ? expr : expr.slice(0, sp);
        if (!DROPPABLE_TOKEN.test(head)) { return null; }
        if (++drops > MAX_ARROW_TOKEN_DROPS) { return null; }
        if (sp === -1) { return null; } // dropped the last token — nothing left
        expr = expr.slice(sp + 1).trimStart();
        if (!expr) { return null; }
    }

    // `expr` is a suffix of the run, so its start is the run's last occurrence
    // of it. A chosen expression flush against the start of a possibly-truncated
    // window may open with a fragment of a token cut off before the window — a
    // longer variable name (`…budg|et * 2 =>`) or a split number (`…2|1000 =>`),
    // either of which would resolve to the wrong value — so refuse it, matching
    // the `=` path's boundary discipline.
    const exprStartInRun = run.lastIndexOf(expr);
    if (opts?.boundaryUnknown && runStart === 0 && run.slice(0, exprStartInRun).trim() === "") {
        return null;
    }
    return { length: textBefore.length - (runStart + exprStartInRun), expr };
}

/** True when `expr` is just a numeric literal (no operator, variable, or unit). */
function isBareNumber(expr: string): boolean {
    return /^[0-9.]+$/.test(expr.trim());
}

/**
 * Whether `expr` references any VARIABLE — an identifier that is not a
 * function call. The cascade uses this to skip constant-only equations
 * (`2+3 => 99` depends on no definition, so no definition edit may touch
 * it); constants (`pi`) count as variables here on purpose, because a scope
 * definition can shadow them.
 */
export function expressionUsesVariables(expr: string): boolean {
    const tokens = tokenize(expr, true);
    if (!tokens) { return false; }
    return tokens.some(
        (tok, i) =>
            tok.kind === "ident" &&
            !(FUNCTIONS.has(tok.name.toLowerCase()) && tokens[i + 1]?.kind === "lparen"),
    );
}

// ── Variable definitions ─────────────────────────────────────────────────────

/**
 * The answer tail an insertion leaves on a line: `=` or `=>`, optionally
 * followed by the number it wrote. Stripped from a definition's right-hand
 * side, because a definition that carries its own inserted answer
 * (`e=d => 6`) still defines `e` as `d` — the answer is display, not value.
 * A plain number with no marker never matches, so `x = 6` keeps its 6.
 */
const DEFINITION_ANSWER_TAIL = /\s*=>?[ \t]*(?:-?\d(?:[\d,]*\d)?(?:\.\d+)?)?[ \t]*$/;

/**
 * A single `name = value` definition line. The name is a plain identifier
 * (constant glyphs allowed, so `π = 3` can shadow the constant); the `=` must
 * be a single `=` (not `==` highlight syntax, not `=>`), and the value is any
 * living-calc expression that resolves against the definitions seen so far —
 * with any trailing inserted answer stripped first. Returns the name and
 * right-hand side, or null when the line is not a definition (ordinary prose,
 * a heading, a `=>` line, etc.).
 */
export function parseDefinition(line: string): { name: string; rhs: string } | null {
    const m = /^\s*([A-Za-zπτ_][\wπτ]*)\s*=(?![=>])\s*(\S.*)$/u.exec(line);
    if (!m) { return null; }
    const rhs = m[2].replace(DEFINITION_ANSWER_TAIL, "").trim();
    if (!rhs) { return null; }
    return { name: m[1], rhs };
}

/**
 * The one definition-evaluation step shared by every scope builder: resolve
 * the right-hand side against the definitions seen so far and, when it yields
 * a value, enter it into `scope`. Returns the value, or null when the RHS does
 * not resolve (the scope is left untouched — a broken definition never
 * clobbers an earlier good one).
 */
function applyDefinition(
    def: { name: string; rhs: string },
    scope: Map<string, number>,
): number | null {
    const value = evaluateCalc(def.rhs, scope);
    if (value !== null) { scope.set(def.name, value); }
    return value;
}

/**
 * Builds a variable scope from document lines, top to bottom: each
 * `name = expr` line whose right-hand side resolves to a finite number (using
 * the names defined ABOVE it) adds/overrides that name. Sequential, so a
 * definition may reference earlier ones and a later redefinition wins — the
 * predictable, spreadsheet-like reading a reader gets scanning down the page.
 */
export function buildScopeFromLines(lines: readonly string[]): Map<string, number> {
    const scope = new Map<string, number>();
    for (const line of lines) {
        const def = parseDefinition(line);
        if (def) { applyDefinition(def, scope); }
    }
    return scope;
}

// ── Calc block ("Calca mode": a fenced ```calc region) ───────────────────────

/**
 * How a calc-block line came out:
 * - `value`: computed fine — `result` holds the display text;
 * - `silent`: nothing to show and nothing wrong — a blank, a comment, prose,
 *   a bare literal, or a definition whose source already spells its value;
 * - `error`: the line READS as a formula (a definition, an operator-bearing
 *   expression, a known-units conversion) but no honest value exists — an
 *   unknown variable, division by zero, a dimension mismatch, a result too
 *   big to print truthfully. The ledger shows a quiet cue, because inside a
 *   block whose whole point is computing, a silent absence needs a signal
 *   (docs/DESIGN_PRINCIPLES.md) — while prose stays uncued.
 */
export type CalcLineKind = "value" | "silent" | "error";

/** One rendered line of a calc block: the source verbatim + the value to show. */
export interface CalcBlockLine {
    /** The source line, unchanged (the block round-trips as ordinary Markdown). */
    raw: string;
    /** The formatted result to display beside the line; null unless `kind` is `value`. */
    result: string | null;
    kind: CalcLineKind;
    /**
     * The full-precision numeric value behind a `value` row. The display is
     * rounded (12 significant digits, ≤6 decimals); when the two differ, the
     * ledger offers this as a hover tooltip so the rounding is inspectable.
     */
    value?: number;
}

/** A calc-block comment/annotation line: `#` or `//`, so prose can sit inline. */
const CALC_COMMENT = /^\s*(#|\/\/)/;
/** An explicit trailing `=` or `=>` on a block line — stripped before parsing,
 * so `x = 2 + 3 =` still defines `x` and `3 km in mi =>` still converts. */
const CALC_TRAILING_EQ = /\s*=>?[ \t]*$/;

/**
 * Whether a non-definition block line READS as a formula — the error-cue
 * gate. Confidence needs two things:
 * - structure: an operator-bearing, well-formed expression (`total * 2`) or a
 *   known-units conversion shape (`3 km in kg`) — hyphenated prose with a
 *   trailing word (`well-known plan`) parses as no valid structure;
 * - evidence: at least one number or one KNOWN variable. A chain of solely
 *   unknown words is structurally an expression too (`one-off`, `win/win`,
 *   `state-of-the-art` are ident chains with operators), but it reads as
 *   prose — cueing it would put error dashes on ordinary notes.
 */
function looksLikeFormula(expr: string, scope: Map<string, number>): boolean {
    const form = parseUnitForm(expr);
    if (form && isKnownUnit(form.fromUnit) && isKnownUnit(form.toUnit)) {
        return true;
    }
    const hasCall = HAS_FUNCTION_CALL.test(expr);
    if ((!HAS_OPERATOR.test(expr) && !hasCall) || !isValidExpressionStructure(expr)) {
        return false;
    }
    // A single word-shaped token headed by an UNKNOWN identifier and joined
    // only by hyphens/slashes reads as a prose compound (`T-1000`, `COVID-19`,
    // `B-52`, `either/or`), even when a number gives it structural evidence.
    // Anything with a space, another operator, or a KNOWN leading variable is
    // judged normally.
    if (!/\s/.test(expr) && /^[A-Za-z_]/.test(expr) && !/[+*%^()]/.test(expr)) {
        const head = /^[A-Za-z_]\w*/.exec(expr)![0];
        if (!scope.has(head)) { return false; }
    }
    const tokens = tokenize(expr, true);
    if (!tokens) { return false; }
    return tokens.some(
        (tok) =>
            tok.kind === "num" ||
            (tok.kind === "ident" && (scope.has(tok.name) || FUNCTIONS.has(tok.name.toLowerCase()))),
    );
}

/** An identifier immediately followed by `(` — a call-shaped span. */
const HAS_FUNCTION_CALL = /[A-Za-zπτ_][\wπτ]*\s*\(/u;

/**
 * Evaluate a fenced `calc` block: every line under ONE shared scope, top to
 * bottom, like a page you read down (or a tiny spreadsheet). Returns one entry
 * per source line paired with the value to show beside it; the source itself is
 * never rewritten, so the block round-trips byte-for-byte as ordinary Markdown
 * — the result lives only in the rendered view.
 *
 * Line semantics (each resolved against the definitions ABOVE it):
 *  - blank or a `#` / `//` comment → passed through, no result;
 *  - `name = expr` → a definition: the value enters scope, and is shown unless
 *    the source already spells it out (`budget = 5000` shows nothing extra,
 *    `total = 12 * 100` shows `1200`);
 *  - otherwise an expression (`budget * 0.3`, `3 km in mi`, optionally ending in
 *    `=` / `=>`) → its value is shown; a bare number or prose shows nothing,
 *    and a line that reads as a formula but can't compute is flagged `error`.
 *
 * Deterministic, eval-free, network-free — the same engine as the `=` and `=>`
 * paths, only evaluated line-by-line over a shared scope.
 */
export function evaluateCalcBlock(source: string): CalcBlockLine[] {
    const scope = new Map<string, number>();
    return source.split("\n").map((raw): CalcBlockLine => {
        if (!raw.trim() || CALC_COMMENT.test(raw)) { return { raw, result: null, kind: "silent" }; }

        const line = raw.replace(CALC_TRAILING_EQ, "");
        const def = parseDefinition(line);
        if (def) {
            const value = applyDefinition(def, scope);
            if (value === null) { return { raw, result: null, kind: "error" }; }
            // A literal RHS already spells its value — nothing to display, and
            // nothing wrong, even when the value itself is unprintable
            // (`x = 0.0000001` defines fine and shows no echo; an error dash
            // on a definition the ledger visibly uses downstream would lie).
            if (/^-?[0-9.]+$/.test(def.rhs)) { return { raw, result: null, kind: "silent" }; }
            const formatted = formatCalcResult(value);
            if (formatted === null) { return { raw, result: null, kind: "error" }; }
            // No echo when the RHS already is the value; show it when the RHS
            // is an expression (`x = 2 + 3` → 5) or a conversion.
            return formatted === def.rhs
                ? { raw, result: null, kind: "silent" }
                : { raw, result: formatted, kind: "value", value };
        }

        const expr = line.trim();
        if (!expr || isBareNumber(expr)) { return { raw, result: null, kind: "silent" }; }
        const value = evaluateCalc(expr, scope);
        if (value === null) {
            return { raw, result: null, kind: looksLikeFormula(expr, scope) ? "error" : "silent" };
        }
        const formatted = formatCalcResult(value);
        if (formatted === null) { return { raw, result: null, kind: "error" }; }
        return { raw, result: formatted, kind: "value", value };
    });
}

// ── Refresh scanning (auto-insert mode) ──────────────────────────────────────

/** One equation occurrence in a block's text, as the refresh hook consumes it. */
export interface EquationSpan {
    /** `trailing`: `expr = result`. `leading`: `result=expr` (the `=`-first
     * insert). `arrow`: `expr => result` — the living-calculation form, whose
     * expression may carry variables and units. */
    form: "trailing" | "leading" | "arrow";
    /** Character span of the expression side, END-INCLUSIVE of the `=` for the
     * trailing and arrow forms (mirrors the original regex's span semantics). */
    expr: [number, number];
    /** Character span of the result text, end-exclusive. */
    res: [number, number];
    /** The current result text, verbatim (may carry the user's `,` grouping). */
    resultText: string;
}

/** A previously-inserted result: optional minus, digits with `,` grouping
 * (a comma must sit BETWEEN digits — `5, then` keeps its prose comma),
 * optional decimals. Sticky, so it anchors exactly where the scan points it. */
const RESULT_NUMBER = /-?\d(?:[\d,]*\d)?(?:\.\d+)?/y;
/** The same shape, anchored — validates a backward-collected candidate. */
const RESULT_NUMBER_EXACT = /^-?\d(?:[\d,]*\d)?(?:\.\d+)?$/;
const RESULT_CHAR = /[\d,.]/;
const DIGIT = /[0-9]/;
const ARITH_OR_WS = new RegExp(`[${ARITHMETIC_CLASS} \\t]`);
/** One character of an `=>` expression run (letters allowed — variables, units). */
const ARROW_RUN_CHAR = /[\wπτ⁰¹²³⁴⁵⁶⁷⁸⁹+\-*/%^().°'" \t]/u;

/**
 * Finds `expr = result` / `result=expr` equation shapes in `text` whose spans
 * intersect [from, to] — the candidates the auto-insert refresh re-validates.
 *
 * This is a hand-rolled scan, NOT a regex, on purpose: the natural regex for
 * "an arithmetic run, then `=`, then a number" (`[class]*[0-9)]…=`) backtracks
 * QUADRATICALLY on a long digit-heavy line that contains `=` but never
 * completes the shape — and this runs inside `appendTransaction`, on the
 * synchronous keystroke path. The scan walks outward from each `=` instead:
 * linear, and only within the neighborhood of the change (an equation an edit
 * didn't touch can't have gone stale). Expression runs are capped at `maxRun`
 * per side; the result-number walks are uncapped but each is a single linear
 * pass — no shape here can backtrack.
 *
 * Candidates are returned trailing-first, left-to-right (the original
 * evaluation order); every candidate must still be re-validated through
 * detectCalcExpression by the caller — the shapes here are deliberately broad.
 */
export function findRefreshEquations(
    text: string,
    from: number,
    to: number,
    maxRun: number,
): EquationSpan[] {
    const trailing: EquationSpan[] = [];
    const leading: EquationSpan[] = [];
    const arrow: EquationSpan[] = [];
    // An equation intersecting [from, to] has its `=` within an expression run
    // or a result of it; pad the examined region by one run either side.
    const margin = maxRun + 40;
    const scanFrom = Math.max(0, from - margin);
    const scanTo = Math.min(text.length, to + margin);
    for (let e = text.indexOf("=", scanFrom); e !== -1 && e < scanTo; e = text.indexOf("=", e + 1)) {
        // ARROW `expr => result`: the living-calculation form. Only a
        // number-bearing arrow is an equation to maintain — a bare `=>` with
        // no accepted answer belongs to the advisory suggestion, not refresh.
        if (text[e + 1] === ">") {
            let resStart = e + 2;
            while (text[resStart] === " " || text[resStart] === "\t") { resStart++; }
            RESULT_NUMBER.lastIndex = resStart;
            const num = RESULT_NUMBER.exec(text);
            if (num) {
                let exprStart = e;
                while (exprStart > 0 && e - exprStart < maxRun && ARROW_RUN_CHAR.test(text[exprStart - 1])) {
                    exprStart--;
                }
                if (text.slice(exprStart, e).trim()) {
                    arrow.push({
                        form: "arrow",
                        expr: [exprStart, e],
                        res: [resStart, resStart + num[0].length],
                        resultText: num[0],
                    });
                }
            }
            continue;
        }
        // `==` (highlight syntax) is never an equation; a `>`-preceded `=`
        // can't occur (handled above), and `=`-adjacent pairs are skipped.
        if (text[e + 1] === "=" || text[e - 1] === "=") { continue; }

        // TRAILING `expr = result`: an arithmetic run before the `=` whose last
        // non-space char is a digit or `)`, and a number after it.
        let runStart = e;
        while (runStart > 0 && e - runStart < maxRun && ARITH_OR_WS.test(text[runStart - 1])) {
            runStart--;
        }
        let runEnd = e; // exclusive; walk back over the spaces before `=`
        while (runEnd > runStart && (text[runEnd - 1] === " " || text[runEnd - 1] === "\t")) {
            runEnd--;
        }
        const lastCh = text[runEnd - 1];
        if (runEnd > runStart && (DIGIT.test(lastCh) || lastCh === ")")) {
            let resStart = e + 1;
            while (text[resStart] === " " || text[resStart] === "\t") { resStart++; }
            RESULT_NUMBER.lastIndex = resStart;
            const num = RESULT_NUMBER.exec(text);
            if (num) {
                trailing.push({
                    form: "trailing",
                    expr: [runStart, e],
                    res: [resStart, resStart + num[0].length],
                    resultText: num[0],
                });
            }
        }

        // LEADING `result=expr`: a number before the `=`, and an arithmetic run
        // after it ending in a digit or `)`.
        let resEnd = e; // exclusive; walk back over spaces, then the number
        while (resEnd > 0 && (text[resEnd - 1] === " " || text[resEnd - 1] === "\t")) { resEnd--; }
        let resStart = resEnd;
        while (resStart > 0 && RESULT_CHAR.test(text[resStart - 1])) { resStart--; }
        if (text[resStart - 1] === "-") { resStart--; }
        const resText = text.slice(resStart, resEnd);
        if (resStart < resEnd && RESULT_NUMBER_EXACT.test(resText)) {
            let exprStart = e + 1;
            while (text[exprStart] === " " || text[exprStart] === "\t") { exprStart++; }
            let exprEnd = exprStart;
            while (exprEnd < text.length && exprEnd - exprStart < maxRun && ARITH_OR_WS.test(text[exprEnd])) {
                exprEnd++;
            }
            while (exprEnd > exprStart && !(DIGIT.test(text[exprEnd - 1]) || text[exprEnd - 1] === ")")) {
                exprEnd--;
            }
            if (exprEnd > exprStart) {
                leading.push({
                    form: "leading",
                    expr: [exprStart, exprEnd],
                    res: [resStart, resEnd],
                    resultText: resText,
                });
            }
        }
    }
    const intersects = (s: EquationSpan): boolean =>
        !(to < Math.min(s.expr[0], s.res[0]) || from > Math.max(s.expr[1], s.res[1]));
    return [...trailing, ...leading, ...arrow].filter(intersects);
}
