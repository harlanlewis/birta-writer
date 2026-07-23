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
    | { kind: "ident"; name: string }
    | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
    | { kind: "lparen" }
    | { kind: "rparen" };

/** Characters that may appear in an arithmetic expression (letters excluded). */
const EXPR_CHAR = /[0-9.+\-*/%^()\s]/;
/** The first character of an identifier (variable name): a letter or `_`. */
const IDENT_START = /[A-Za-z_]/;
/** A subsequent identifier character: letter, digit, or `_`. */
const IDENT_CHAR = /[A-Za-z0-9_]/;

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
    constructor(
        private readonly tokens: Token[],
        /**
         * Resolves an identifier to its numeric value, or `undefined` for an
         * unknown name (→ CalcError → the whole expression yields null). Absent
         * on the pure-arithmetic path, where no `ident` token can ever appear.
         */
        private readonly resolve?: (name: string) => number | undefined,
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
        if (tok.kind === "ident") {
            this.pos++;
            const value = this.resolve?.(tok.name);
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
 * tokens, division or modulo by zero, or an overflow to ±Infinity / NaN.
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
const TRAILING_EXPR = /[0-9.+\-*/%^() \t]*$/;
/**
 * The LEADING form: `=<expr>` ending at the caret, with the `=` at line start
 * or after whitespace — `a=5+7` is a prose assignment (no boundary) and
 * `==x` never matches (the char class excludes `=`, and the second `=` has no
 * boundary before it).
 */
const LEADING_FORM = /(^|[ \t])=([0-9.+\-*/%^() \t]+)$/;
/** At least one operator: a bare number is not offered (`the value 42 =`). */
const HAS_OPERATOR = /[+\-*/%^]/;

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
        if (glued && /[\p{L}\p{N},_]/u.test(beforeEquals[runStart - 1])) { return null; }
        if (/^[+\-*/%^]/.test(expr)) { return null; }
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
    // Results that stringify with an exponent — too large (`1e+21`) or too
    // small (`1 / 1000000000` → `1e-9`) for plain digits — carry a letter, in
    // a feature whose contract is "pure digits in, pure digits out". Offer
    // nothing instead.
    if (result.includes("e")) { return null; }
    // Span from the expression's first character (after any leading run
    // whitespace) through the caret (the end of textBefore).
    const leadingWs = run.length - run.replace(/^[ \t]+/, "").length;
    const start = runStart + leadingWs;
    return { length: textBefore.length - start, expr, result };
}

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
    if (result.includes("e")) { return null; }
    const start = lead.index + lead[1].length; // the `=` itself
    return { length: textBefore.length - start, expr, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Living calculation" layer: the `=>` operator, named variables, and OFFLINE
// unit conversion (MAR-196, Calca-inspired). Everything here is still the same
// deterministic, eval-free, network-free discipline as the `=` path above — an
// identifier is a lookup in a caller-supplied scope, never a code path, and
// units are a fixed static table, never a rates service. Currency is
// deliberately absent: live rates would need the network, which the offline
// posture forbids.
// ─────────────────────────────────────────────────────────────────────────────

/** A physical dimension a unit belongs to; conversion only works within one. */
type Dim = "length" | "mass" | "time" | "volume" | "temperature";

/**
 * Linear units: factor to the dimension's base unit (metre, kilogram, second,
 * litre). Names are matched lowercased, so `KM` and `km` are the same unit.
 * Temperature is affine (offsets, not just factors) and handled separately.
 */
const LINEAR_UNITS: Record<string, { dim: Dim; factor: number }> = {
    // length (base: metre)
    mm: { dim: "length", factor: 0.001 },
    cm: { dim: "length", factor: 0.01 },
    dm: { dim: "length", factor: 0.1 },
    m: { dim: "length", factor: 1 },
    km: { dim: "length", factor: 1000 },
    in: { dim: "length", factor: 0.0254 },
    inch: { dim: "length", factor: 0.0254 },
    inches: { dim: "length", factor: 0.0254 },
    ft: { dim: "length", factor: 0.3048 },
    foot: { dim: "length", factor: 0.3048 },
    feet: { dim: "length", factor: 0.3048 },
    yd: { dim: "length", factor: 0.9144 },
    yard: { dim: "length", factor: 0.9144 },
    yards: { dim: "length", factor: 0.9144 },
    mi: { dim: "length", factor: 1609.344 },
    mile: { dim: "length", factor: 1609.344 },
    miles: { dim: "length", factor: 1609.344 },
    nmi: { dim: "length", factor: 1852 },
    // mass (base: kilogram)
    mg: { dim: "mass", factor: 0.000001 },
    g: { dim: "mass", factor: 0.001 },
    kg: { dim: "mass", factor: 1 },
    t: { dim: "mass", factor: 1000 },
    tonne: { dim: "mass", factor: 1000 },
    tonnes: { dim: "mass", factor: 1000 },
    oz: { dim: "mass", factor: 0.028349523125 },
    lb: { dim: "mass", factor: 0.45359237 },
    lbs: { dim: "mass", factor: 0.45359237 },
    pound: { dim: "mass", factor: 0.45359237 },
    pounds: { dim: "mass", factor: 0.45359237 },
    stone: { dim: "mass", factor: 6.35029318 },
    // time (base: second)
    ms: { dim: "time", factor: 0.001 },
    s: { dim: "time", factor: 1 },
    sec: { dim: "time", factor: 1 },
    secs: { dim: "time", factor: 1 },
    second: { dim: "time", factor: 1 },
    seconds: { dim: "time", factor: 1 },
    min: { dim: "time", factor: 60 },
    mins: { dim: "time", factor: 60 },
    minute: { dim: "time", factor: 60 },
    minutes: { dim: "time", factor: 60 },
    h: { dim: "time", factor: 3600 },
    hr: { dim: "time", factor: 3600 },
    hrs: { dim: "time", factor: 3600 },
    hour: { dim: "time", factor: 3600 },
    hours: { dim: "time", factor: 3600 },
    day: { dim: "time", factor: 86400 },
    days: { dim: "time", factor: 86400 },
    week: { dim: "time", factor: 604800 },
    weeks: { dim: "time", factor: 604800 },
    // volume (base: litre)
    ml: { dim: "volume", factor: 0.001 },
    l: { dim: "volume", factor: 1 },
    liter: { dim: "volume", factor: 1 },
    litre: { dim: "volume", factor: 1 },
    liters: { dim: "volume", factor: 1 },
    litres: { dim: "volume", factor: 1 },
    tsp: { dim: "volume", factor: 0.00492892159375 },
    tbsp: { dim: "volume", factor: 0.01478676478125 },
    cup: { dim: "volume", factor: 0.2365882365 },
    cups: { dim: "volume", factor: 0.2365882365 },
    pint: { dim: "volume", factor: 0.473176473 },
    pints: { dim: "volume", factor: 0.473176473 },
    quart: { dim: "volume", factor: 0.946352946 },
    quarts: { dim: "volume", factor: 0.946352946 },
    gal: { dim: "volume", factor: 3.785411784 },
    gallon: { dim: "volume", factor: 3.785411784 },
    gallons: { dim: "volume", factor: 3.785411784 },
};

/** Temperature units → the °C base, and back; affine, so not plain factors. */
const TEMP_TO_C: Record<string, (v: number) => number> = {
    c: (v) => v,
    "°c": (v) => v,
    celsius: (v) => v,
    f: (v) => (v - 32) * 5 / 9,
    "°f": (v) => (v - 32) * 5 / 9,
    fahrenheit: (v) => (v - 32) * 5 / 9,
    k: (v) => v - 273.15,
    kelvin: (v) => v - 273.15,
};
const TEMP_FROM_C: Record<string, (c: number) => number> = {
    c: (c) => c,
    "°c": (c) => c,
    celsius: (c) => c,
    f: (c) => c * 9 / 5 + 32,
    "°f": (c) => c * 9 / 5 + 32,
    fahrenheit: (c) => c * 9 / 5 + 32,
    k: (c) => c + 273.15,
    kelvin: (c) => c + 273.15,
};

/**
 * Converts `value` from one unit to another, or `null` when a unit is unknown
 * or the two belong to different dimensions (`3 km in kg` is meaningless).
 */
export function convertUnit(value: number, from: string, to: string): number | null {
    const f = from.toLowerCase();
    const trg = to.toLowerCase();
    if (f in TEMP_TO_C && trg in TEMP_FROM_C) {
        return TEMP_FROM_C[trg](TEMP_TO_C[f](value));
    }
    const a = LINEAR_UNITS[f];
    const b = LINEAR_UNITS[trg];
    if (!a || !b || a.dim !== b.dim) { return null; }
    const result = value * a.factor / b.factor;
    return Number.isFinite(result) ? result : null;
}

/**
 * The unit-conversion form `<numeric-expr> <fromUnit> (in|to) <toUnit>`, e.g.
 * `3 km in mi`, `180 lb to kg`, `100 C in F`, `2 * 3 cups in ml`. The `in`/`to`
 * keyword is matched right-anchored (so `min`/`into` inside a word never
 * trips it), the target unit is the final token, and the source unit is the
 * word right before the keyword; whatever precedes that is the numeric
 * expression, evaluated with `resolve` so `x cups in ml` works. Returns the
 * converted number, or null when the shape or the units don't line up.
 */
function evaluateUnitForm(
    input: string,
    resolve: (name: string) => number | undefined,
): number | null {
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
    const value = evaluateExpression(numExpr, resolve);
    if (value === null) { return null; }
    return convertUnit(value, fromUnit, toUnit);
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
 * Whether `input` is a well-FORMED living-calculation expression, independent of
 * whether its variables happen to be defined — every identifier is treated as
 * resolvable. The `=>` caret detection uses this to fix the highlighted span
 * from the visible text alone (the real scope, and thus the real result, is
 * only known later at fetch time); an expression that is structurally valid but
 * references an undefined variable simply produces no result then.
 */
export function isCalcStructurallyValid(input: string): boolean {
    const anyValue = (): number => 1;
    if (evaluateUnitForm(input, anyValue) !== null) { return true; }
    return evaluateExpression(input, anyValue) !== null;
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
/** Characters that may appear in a living-calc expression run (letters allowed). */
const CALC_RUN = /[\w+\-*/%^().°'" \t]*$/u;
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
 * (optionally followed by spaces already typed). Unlike the `=` path, `=>`
 * never occurs in ordinary prose, so detection needs almost none of that path's
 * anti-hijack paranoia. The one real problem is that the run before `=>` can
 * contain letters (variables, units) and therefore also ordinary prose words;
 * so the maximal trailing run is trimmed to its LONGEST suffix that is a
 * structurally valid expression, dropping leading whitespace-separated tokens
 * one at a time (`the total x*2 =>` → `x*2`).
 *
 * Returns the matched span and expression, or null when there is no `=>` or the
 * text before it holds no valid, non-trivial expression. A bare number
 * (`42 =>`) is refused — echoing it back is pointless — but a lone variable
 * (`total =>`) is offered, since showing a definition's value is the point.
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
    // because it is a suffix and runStart is derived from its length. The
    // discarded head also means a chosen expression can never be flush against a
    // truncated window start, so the fragment risk the boundary guard covers
    // can't reach it.
    const run = fullRun.length > MAX_ARROW_RUN
        ? fullRun.slice(fullRun.length - MAX_ARROW_RUN)
        : fullRun;
    const runStart = arrow.index - run.length;
    const trimmedRun = run.trim();
    if (!trimmedRun) { return null; }

    // Longest valid suffix: starting from the trimmed run, drop leading
    // whitespace-separated tokens until what remains parses (or nothing does).
    // This peels prose off the front while keeping the largest real expression
    // (`the total x*2` → `x*2`). Bounded by MAX_ARROW_TOKEN_DROPS so a long
    // prose line ending in `=>` stays cheap.
    let expr = trimmedRun;
    for (let drops = 0; ; drops++) {
        if (isCalcStructurallyValid(expr) && !isBareNumber(expr)) { break; }
        if (drops >= MAX_ARROW_TOKEN_DROPS) { return null; }
        const sp = expr.search(/\s/);
        if (sp === -1) { return null; }
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

// ── Variable definitions ─────────────────────────────────────────────────────

/**
 * A single `name = value` definition line. The name is a plain identifier; the
 * `=` must be a single `=` (not `==` highlight syntax, not `=>`), and the value
 * is any living-calc expression that resolves against the definitions seen so
 * far. Returns the name and raw right-hand side, or null when the line is not a
 * definition (ordinary prose, a heading, a `=>` line, etc.).
 */
export function parseDefinition(line: string): { name: string; rhs: string } | null {
    const m = /^\s*([A-Za-z_]\w*)\s*=(?![=>])\s*(\S.*)$/.exec(line);
    if (!m) { return null; }
    return { name: m[1], rhs: m[2].trim() };
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
        if (!def) { continue; }
        const value = evaluateCalc(def.rhs, scope);
        if (value !== null) { scope.set(def.name, value); }
    }
    return scope;
}
