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
 * - `%` is MODULO (binary infix, same precedence as `*` and `/`), not percent:
 *   `10 % 3` is `1`. Percent-as-postfix is ambiguous with modulo, so we take
 *   the unambiguous, deterministic reading.
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
 *   primary := number | '(' expr ')'
 */

type Token =
    | { kind: "num"; value: number }
    | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
    | { kind: "lparen" }
    | { kind: "rparen" };

/** Characters that may appear in an arithmetic expression (letters excluded). */
const EXPR_CHAR = /[0-9.+\-*/%^()\s]/;

/**
 * Splits `input` into tokens, or returns null the moment it sees anything that
 * is not part of the arithmetic grammar — a letter, `,`, `$`, `=`, whatever.
 * `**` collapses to a single `^` token. A number must carry at least one digit
 * (`.` alone is not a number), and may carry at most one decimal point.
 */
function tokenize(input: string): Token[] | null {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
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

/** A single-pass recursive-descent parser/evaluator over the token stream. */
class Parser {
    private pos = 0;
    constructor(private readonly tokens: Token[]) {}

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
                if (right === 0) { throw new CalcError("division by zero"); }
                left = left / right;
            } else {
                if (right === 0) { throw new CalcError("modulo by zero"); }
                left = left % right;
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
 * Evaluates a pure arithmetic expression. Returns the numeric result, or `null`
 * for anything not a single complete, finite arithmetic value: malformed
 * syntax, leftover tokens, letters/identifiers, division or modulo by zero, or
 * an overflow to ±Infinity / NaN.
 */
export function evaluateExpression(input: string): number | null {
    const tokens = tokenize(input);
    if (!tokens || tokens.length === 0) { return null; }
    try {
        const parser = new Parser(tokens);
        const value = parser.parseExpr();
        if (!parser.atEnd()) { return null; } // trailing junk, e.g. `2 3` or `2 (3)`
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Formats a numeric result as the plain text inserted into the document.
 * Rounds to 12 significant digits first so floating-point artifacts don't leak
 * into prose (`0.1 + 0.2` reads `0.3`, not `0.30000000000000004`), then lets
 * `String` drop trailing zeros. Normalizes `-0` to `0`.
 */
export function formatCalcResult(value: number): string {
    // Safe integers print exactly — `toPrecision(12)` exists to hide float
    // artifacts in fractional results, but applied to a 13-digit integer it
    // MANUFACTURES one (`9999999999999` → `10000000000000`).
    if (Number.isSafeInteger(value)) {
        return String(Object.is(value, -0) ? 0 : value);
    }
    const rounded = Number(value.toPrecision(12));
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** A detected calc construct ending at the caret. */
export interface CalcMatch {
    /** Length in characters from the expression's first char through the caret. */
    length: number;
    /** The pure arithmetic expression (trimmed), e.g. `12 * 4`. */
    expr: string;
    /** The formatted result text, e.g. `48`. */
    result: string;
}

/** The `=` (with any trailing spaces/tabs) that ends the text before the caret. */
const TRAILING_EQUALS = /=[ \t]*$/;
/** The maximal run of arithmetic characters immediately before that `=`. */
const TRAILING_EXPR = /[0-9.+\-*/%^() \t]*$/;
/** At least one operator: a bare number is not offered (`the value 42 =`). */
const HAS_OPERATOR = /[+\-*/%^]/;
/**
 * Three or more digit groups joined by the same `-` or `/` with no spaces —
 * a date (`2026-07-17`), phone number (`555-867-5309`), or dashed identifier,
 * not arithmetic. Two joined groups stay arithmetic (`5-3`, `7/8`), matching
 * how people actually type quick math without spaces.
 */
const SEPARATOR_CHAIN = /^\d+([-/])\d+(?:\1\d+)+$/;

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
export function detectCalcExpression(textBefore: string): CalcMatch | null {
    const eq = TRAILING_EQUALS.exec(textBefore);
    if (!eq) { return null; }
    const beforeEquals = textBefore.slice(0, eq.index);
    const run = TRAILING_EXPR.exec(beforeEquals)?.[0] ?? "";
    const expr = run.trim();
    if (!expr || !HAS_OPERATOR.test(expr)) { return null; }
    const runStart = eq.index - run.length;
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
        if (glued && /[\p{L}\p{N},_]/u.test(beforeEquals[runStart - 1])) { return null; }
        if (/^[+\-*/%^]/.test(expr)) { return null; }
    }
    // Dates and dashed identifiers (`2026-07-17 =`) tokenize as chained
    // subtraction/division and would "compute". Refuse the shape outright.
    if (SEPARATOR_CHAIN.test(expr)) { return null; }
    const value = evaluateExpression(expr);
    if (value === null) { return null; }
    const result = formatCalcResult(value);
    // Results too large for plain digits stringify with an exponent
    // (`1e+21`) — a letter, in a feature whose contract is "pure digits in,
    // pure digits out". Offer nothing instead.
    if (result.includes("e")) { return null; }
    // Span from the expression's first character (after any leading run
    // whitespace) through the caret (the end of textBefore).
    const leadingWs = run.length - run.replace(/^[ \t]+/, "").length;
    const start = runStart + leadingWs;
    return { length: textBefore.length - start, expr, result };
}
