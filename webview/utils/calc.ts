/**
 * webview/utils/calc.ts
 *
 * The deterministic calc engine — every text-level piece of the inline
 * calculators and the ```calc block, in five sections (each with its own
 * `──` banner below):
 *   1. the tokenizer/parser and the one formatting policy;
 *   2. `=` caret detection ("Math Notes", MAR-177) with its anti-hijack
 *      boundary discipline;
 *   3. the living-calculation layer (MAR-196): `=>` detection, functions and
 *      constants, definitions/scope, units via the lazy calcUnits.ts seam;
 *   4. the ```calc block evaluator (typed line results for the ledger);
 *   5. the refresh scanner — the text layer of the answer-maintenance engine
 *      in plugins/calcRefresh.ts.
 * Pure functions, no ProseMirror, no DOM.
 *
 * SAFETY IS THE WHOLE POINT. This never touches `eval`, `new Function`, or any
 * other dynamic-code path, and it never reaches the network or an LLM. It is a
 * hand-written recursive-descent parser over a fixed token set: digits, the
 * binary operators `+ - * / % ^` (plus `**` as an alias for `^`, and the
 * Unicode glyphs `× · ⋅ ÷ −` read as `* * * / -`), parentheses, and unary
 * +/-. On the closed path the letter `x` between operands is also
 * multiplication (`2 x 3 =` → 6) — an operator alias, not a name. Names reach
 * that path only from the CLOSED VOCABULARY, a fixed table of numeric
 * functions and constants (`log10(…)`, `π`) that resolve the same way in every
 * document; a name outside it, `alert(1)`, `1e3` scientific notation and hex
 * are all rejected at the tokenizer, so a call is always one of ours and a
 * variable never resolves without a scope deliberately handed in. Malformed
 * or non-computable input (unbalanced parens, a trailing operator, division by
 * zero, an overflow to Infinity) yields `null`, and the caller shows nothing.
 *
 * The result is always plain text — a number written into the document as
 * ordinary prose. Nothing about calc persists in the markdown; the file
 * round-trips exactly as if the digits had been typed by hand (the phase-0
 * fidelity line: no new node type, no marker).
 *
 * PORTABILITY IS THE OTHER HALF OF THE POINT. An equation lives in a plain
 * `.md` file, so a reader will paste it into some other calculator sooner or
 * later — and it must answer the same there. Where the world's calculators
 * genuinely DISAGREE about what a notation means, this engine does not pick a
 * side quietly: it either follows the overwhelming majority, or it refuses to
 * answer at all and asks the writer to say which they meant (see
 * AMBIGUOUS_FUNCTIONS). A wrong number that looks right is the worst thing a
 * calculator can produce; no number is recoverable, a wrong one is not.
 *
 * Operator semantics worth pinning down:
 * - `%` is MODULO, floored — the result takes the sign of the DIVISOR, so
 *   `-10 % 3` is `2` and `10 % -3` is `-2` (binary infix, same precedence as
 *   `*` and `/`). Not percent: percent-as-postfix is ambiguous with modulo, so
 *   we take the unambiguous reading. Floored rather than JS's truncated `%`
 *   because every calculator a reader is likely to paste into floors —
 *   Excel/Sheets `MOD`, Python, Ruby, Wolfram `Mod`, and mathjs (whose `%` IS
 *   `mod`) all answer `2`; only the C-family languages answer `-1`.
 * - `^` (and `**`) is exponentiation, right-associative (`2^3^2` is `2^(3^2)`
 *   = 512), binding TIGHTER than unary minus — `-2 ^ 2` is `-(2 ^ 2)` = `-4`.
 *   Both match ordinary math notation, Python, Wolfram, and Google's
 *   calculator; spreadsheets are the outlier on both counts.
 * - Trig is in RADIANS (`sin(pi/2)` is 1; `sin(30)` is -0.988, NOT 0.5). Every
 *   text-entry calculator agrees — it is the pocket-calculator DEG button that
 *   is the odd one out, and it has no notation here to disagree about.
 * - `round` rounds halves AWAY FROM ZERO: `round(2.5)` is 3 and `round(-2.5)`
 *   is -3, so `round(-x)` is always `-round(x)`. This is the spreadsheet /
 *   pocket-calculator / C `round()` rule; JS's own `Math.round` breaks the
 *   symmetry (it rounds halves toward +∞, making `round(-2.5)` -2).
 * - No scientific notation: `1e3` contains a letter and is rejected. This is a
 *   deliberate choice — it keeps the accepted grammar something a reader can
 *   see is arithmetic, and avoids surprising a user who typed `1e3` as prose.
 */

/** Precedence-climbing grammar (low → high):
 *   expr   := term   (('+' | '-') term)*
 *   term   := factor (('*' | '/' | '%') factor)*
 *   factor := ('+' | '-') factor | power        // unary, looser than '^'
 *   power  := primary ('^' factor)?             // right-associative
 *   primary := number | ident | fn '(' expr ')' | '(' expr ')'
 *              // ident/fn only on the identifier-allowing (`=>`/block) path
 */
import {
    ambiguousUnitReadings,
    calcUnitsReady,
    convertUnit,
    isKnownUnit,
    isUnitDisambiguation,
    unitsCompatible,
} from "./calcUnits";

/**
 * Rounds halves AWAY FROM ZERO (`2.5` → 3, `-2.5` → -3), so `round(-x)` is
 * always `-round(x)`. JS's `Math.round` rounds halves toward +∞ instead,
 * which silently disagrees with spreadsheets, pocket calculators, and C's
 * `round()` on every negative half — see the header's portability note.
 */
function roundHalfAwayFromZero(x: number): number {
    return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * The function table for the identifier-allowing path — a FIXED map of pure
 * numeric functions, matched case-insensitively. This is the whole call
 * surface: a name not in this map is a parse error, so `alert(1)` (rejected
 * at the tokenizer on the `=` path, an unknown function here) can never
 * become a call.
 *
 * Every name here means ONE thing everywhere a reader might paste it. The
 * logarithms are spelled explicitly (`ln`, `log10`, `log2`) for exactly that
 * reason; bare `log` is deliberately absent — see AMBIGUOUS_FUNCTIONS.
 */
const FUNCTIONS = new Map<string, (x: number) => number>([
    ["sqrt", Math.sqrt],
    ["abs", Math.abs],
    ["ln", Math.log],
    ["log10", Math.log10],
    ["log2", Math.log2],
    ["exp", Math.exp],
    ["sin", Math.sin],
    ["cos", Math.cos],
    ["tan", Math.tan],
    ["asin", Math.asin],
    ["acos", Math.acos],
    ["atan", Math.atan],
    ["round", roundHalfAwayFromZero],
    ["floor", Math.floor],
    ["ceil", Math.ceil],
]);

/**
 * Names the world cannot agree on, mapped to the explicit spellings that
 * settle them. Such a name is RECOGNIZED by the grammar — it parses, the
 * ledger can cue it, the `=>` menu can offer each reading — but it never
 * produces a value. The engine does not guess.
 *
 * `log` is the whole list, and it is a genuine 50/50 split, not a rare corner:
 *   - base 10 in Excel/Sheets, Desmos, Google's calculator, macOS Calculator,
 *     and every pocket-calculator LOG key;
 *   - natural in Python, JavaScript, R, Julia, Mathematica, and mathjs.
 * So `log(100)` is 2 for half the world and 4.60517 for the other half — a
 * disagreement no answer of ours can survive being pasted somewhere else, and
 * one that is invisible in the result (both are plausible numbers). Refusing
 * costs one keystroke; guessing costs the reader a wrong answer they cannot
 * see is wrong. Write `log10(…)`, `ln(…)`, or `log2(…)` and the meaning
 * travels with the equation — which is the point of keeping notes in plain
 * text at all.
 */
const AMBIGUOUS_FUNCTIONS = new Map<string, readonly string[]>([
    ["log", ["log10", "ln"]],
]);

/** Every ambiguous name, in table order — the list a surface iterates when it
 * has to speak about the refusal in general rather than about one line. */
export const AMBIGUOUS_FUNCTION_NAMES: readonly string[] = [...AMBIGUOUS_FUNCTIONS.keys()];

/** Every explicit spelling offered for some ambiguous name (`log10`, `ln`). */
const DISAMBIGUATIONS = new Set<string>(
    [...AMBIGUOUS_FUNCTIONS.values()].flat(),
);

/**
 * `name` used CALL-SHAPED (`name(`), whole-word and case-insensitive — the ONE
 * pattern behind both finding an ambiguous call and rewriting it, so detection
 * and settlement can never disagree about what counts as one. `log10(` and
 * `mylog(` are untouched (no word boundary / a longer name).
 *
 * Built once from AMBIGUOUS_FUNCTIONS, a fixed table — never from user text,
 * so these are constants, not dynamic patterns. Two copies per name because a
 * `g` regex carries `lastIndex` across calls: `find` is for searching, `all`
 * for replacing.
 */
const AMBIGUOUS_CALL = new Map<string, { find: RegExp; all: RegExp }>(
    [...AMBIGUOUS_FUNCTIONS.keys()].map((name) => [name, {
        find: new RegExp(`\\b${name}(?=\\s*\\()`, "i"),
        all: new RegExp(`\\b${name}(?=\\s*\\()`, "gi"),
    }]),
);

/**
 * Whether `name` is a CALL name — a real function or a recognized-but-refused
 * ambiguous one. The difference matters only at evaluation; everywhere else
 * (is this a variable? does this line read as a formula?) an ambiguous name is
 * a function like any other, and treating it as a variable would make
 * `log(100) =>` look like it depends on a definition named `log`.
 */
function isCallName(name: string): boolean {
    const lower = name.toLowerCase();
    return FUNCTIONS.has(lower) || AMBIGUOUS_FUNCTIONS.has(lower);
}

/**
 * The explicit spellings that settle `name`, or `[]` when it isn't ambiguous.
 *
 * Two kinds of ambiguity answer here, deliberately through one function: a
 * function the world cannot agree on (`log`), and a unit name whose meaning
 * the legacy case-fold decides (`ML`). They are the same question to every
 * surface above — refuse the value, offer the readings, write the pick into
 * the text — so they resolve through one call and no surface branches on which
 * kind it got.
 *
 * A function name is matched case-insensitively and a unit name exactly, which
 * is not an inconsistency: `LOG(` and `log(` are the same call, whereas the
 * case IS the question for a unit (`Ms` and `MS` mean different things, and
 * `ms` means neither).
 */
export function ambiguousReadings(name: string): readonly string[] {
    const fn = AMBIGUOUS_FUNCTIONS.get(name.toLowerCase());
    return fn ?? ambiguousUnitReadings(name);
}

/** Whether `name` is one of the explicit spellings offered for an ambiguous
 * name — the "the user picked a reading" test on the suggestion path. */
export function isDisambiguation(name: string): boolean {
    return DISAMBIGUATIONS.has(name) || isUnitDisambiguation(name);
}

/**
 * The ambiguous UNIT names in `input`, in the order they are written.
 *
 * Structural, not a text scan, and that is the difference from
 * `ambiguousCallsIn` above: a unit name is only a unit where the conversion
 * SHAPE puts one, so `parseUnitForm` says which two words are units and this
 * asks the catalog about exactly those. A scan would have to guess, and would
 * fire on the `T` in prose.
 *
 * Empty while the lazy engine is cold, because the catalog is what makes a
 * name ambiguous — a caller on a detection path treats that as "offer
 * nothing", never as "not ambiguous".
 */
export function ambiguousUnitsIn(input: string): string[] {
    return unitSlots(input)
        .map(([, name]) => name)
        .filter((n) => ambiguousUnitReadings(n).length > 0);
}

/**
 * Where the unit names are in `input`, as `[offset, name]`, in written order.
 *
 * BOTH conversion shapes, which is the thing to keep in step: the numeric form
 * (`500 ML in l`) has a source and a target, and the tagged form (`t in ML`,
 * where `t` is a variable carrying a unit tag) has only a target — its first
 * token is a variable name and must never be read as a unit.
 */
function unitSlots(input: string): [number, string][] {
    // Callers do NOT hand this a clean expression, which is the same trap
    // `ambiguousCallsIn` documents above and the reason that one is text-level.
    // `applyArrowResult` rewrites the document REGION, which carries the
    // trailing `=>` and any answer already written after it; both parsers here
    // are end-anchored and match neither. Trimming only the TAIL is what keeps
    // this structural: every offset is measured from the start, so it is
    // unaffected by what was removed.
    const text = input.replace(TRAILING_ANSWER, "").replace(CALC_TRAILING_EQ, "");
    const form = parseUnitForm(text);
    if (form) { return [[form.fromAt, form.fromUnit], [form.toAt, form.toUnit]]; }
    const tagged = parseTaggedConversion(text);
    if (!tagged) { return []; }
    // Anchored at the end by TAGGED_CONVERSION, so the last word is the unit.
    const at = text.lastIndexOf(tagged.toUnit);
    return at < 0 ? [] : [[at, tagged.toUnit]];
}

/** An answer calc has already written after a `=>` — the shape
 *  `staleResultLengthAfter` matches, so a re-pick reparses the equation
 *  rather than reading the old number as part of the target unit. */
const TRAILING_ANSWER = /\s*-?\d(?:[\d,]*\d)?(?:\.\d+)?[ \t]*$/;

/**
 * Every ambiguous name in `input`, functions and units together — what a
 * surface asks when it has to speak about why a line refused to compute.
 */
export function ambiguousNamesIn(input: string): string[] {
    return [...new Set([...ambiguousCallsIn(input), ...ambiguousUnitsIn(input)])];
}

/**
 * The ambiguous names used CALL-SHAPED in `text` (lowercased, de-duplicated,
 * in first-use order). `log(100)` yields `["log"]`; a variable that merely
 * happens to be called `log` yields nothing, because only `name(` is a call.
 *
 * TEXT-LEVEL, deliberately — and this is the whole reason the two functions
 * share AMBIGUOUS_CALL. Callers do NOT hand this a clean expression: the
 * calc-block ledger inspects a whole line (`a = 1, b = log(2)`) and the pick
 * path inspects a document region carrying the trailing `=>`. Neither
 * tokenizes, so a token-level scan returned `[]` for both — reporting "not
 * ambiguous" about text that plainly is, which is exactly the half-settled
 * outcome this feature exists to prevent. Over-reporting is the safe
 * direction: the worst a false positive costs is an offer to make an
 * already-unambiguous line explicit.
 */
export function ambiguousCallsIn(text: string): string[] {
    return [...AMBIGUOUS_CALL]
        .map(([name, { find }]) => ({ name, at: text.search(find) }))
        .filter(({ at }) => at >= 0)
        .sort((a, b) => a.at - b.at)
        .map(({ name }) => name);
}

/**
 * `text` with every ambiguous call that `reading` can settle rewritten to it
 * (`disambiguate("log(100)", "ln")` → `"ln(100)"`), so a picked reading is
 * written back into the document itself — the equation, not just its answer,
 * stops being ambiguous. A name `reading` does not belong to is left alone —
 * the result then still refuses to evaluate, which is the honest outcome.
 */
export function disambiguate(text: string, reading: string): string {
    let out = text;
    for (const [name, readings] of AMBIGUOUS_FUNCTIONS) {
        if (readings.includes(reading)) { out = out.replace(AMBIGUOUS_CALL.get(name)!.all, reading); }
    }
    return disambiguateUnit(out, reading);
}

/**
 * `text` with the ambiguous unit name that `reading` settles rewritten to it
 * (`disambiguateUnit("500 ML in L", "milliliter")` → `"500 milliliter in L"`).
 *
 * Rewritten BY POSITION rather than by a text replace, because a unit name can
 * be a substring of the expression beside it and because only the name in the
 * unit slot is a unit at all: in `T * 2 T in kg` the leading `T` is a variable
 * and must not move.
 *
 * A reading that settles neither slot leaves the text alone, so the expression
 * still refuses to compute — the same honest degradation the function path
 * takes when a reading does not belong to the name it was offered for.
 */
function disambiguateUnit(text: string, reading: string): string {
    // Right to left, so rewriting the target cannot shift the source's offset.
    const slots = unitSlots(text).reverse();
    let out = text;
    for (const [at, name] of slots) {
        if (ambiguousUnitReadings(name).includes(reading)) {
            out = out.slice(0, at) + reading + out.slice(at + name.length);
        }
    }
    return out;
}

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

/** Unicode operator glyphs, tokenized as their ASCII equivalents on every
 * path — each is unambiguously an operator, never prose or an identifier. */
const GLYPH_OPS: Record<string, "*" | "/" | "-"> = {
    "×": "*", "·": "*", "⋅": "*", "÷": "/", "−": "-",
};
const GLYPH_OP_CLASS = "×·⋅÷−";

/** Class body: characters of a pure-arithmetic run — the ASCII operators, the
 * Unicode operator glyphs, and the superscript digits (exponents, so `5²` is
 * arithmetic). The letter `x` is the one letter here: on this grammar it can
 * only mean multiplication (`2 x 3`, `1024x768`). A name from the closed
 * vocabulary reaches the `=` path through closedRunStart, which absorbs it
 * around this class rather than by widening it; the `=>` path, where any
 * identifier is a variable, does not consult it at all. */
export const ARITHMETIC_CLASS = `0-9.+\\-*/%^()⁰¹²³⁴⁵⁶⁷⁸⁹${GLYPH_OP_CLASS}x`;
/** One character of an arithmetic run, whitespace included. The single-char
 * form of the class, shared by every backward walk over one. */
const ARITH_RUN_CHAR = new RegExp(`[${ARITHMETIC_CLASS} \\t]`);
/** One arithmetic-run character, whitespace included (tokenizer pre-check). */
const EXPR_CHAR = new RegExp(`[${ARITHMETIC_CLASS}\\s]`);
/** The binary/unary operator characters, as a test for "contains an operator"
 * — a superscript digit IS an exponentiation. Shared with the block path, so
 * `x` is NOT here (there it is an identifier, and `exp` alone must not read
 * as operator-bearing); the `=` path tests HAS_EQ_OPERATOR instead. */
const HAS_OPERATOR = new RegExp(`[+\\-*/%^⁰¹²³⁴⁵⁶⁷⁸⁹${GLYPH_OP_CLASS}]`);
/** The `=` path's operator test: the shared set plus `x`-as-multiplication. */
const HAS_EQ_OPERATOR = new RegExp(`[+\\-*/%^⁰¹²³⁴⁵⁶⁷⁸⁹${GLYPH_OP_CLASS}x]`);
/** An expression that STARTS with a binary operator (left-operand suspicion).
 * `x` is deliberately absent: on the `=>` path a leading `x` is a variable,
 * and on the `=` path a leading `x` fails the parse anyway (no left operand). */
const OP_HEAD = new RegExp(`^[+\\-*/%^${GLYPH_OP_CLASS}]`);
/** The first character of an identifier (variable name): a letter, `_`, or a
 * constant glyph (`π`, `τ`). */
const IDENT_START = /[A-Za-zπτ_]/;
/** A subsequent identifier character: letter, digit, `_`, or constant glyph. */
const IDENT_CHAR = /[A-Za-z0-9πτ_]/;

/**
 * The CLOSED VOCABULARY: the fixed set of names that mean the same thing to
 * every reader, whatever scope they are read in — the call names and the
 * constants, and nothing else. A variable is the opposite kind of name: it
 * means whatever a definition above it says, so it belongs to the `=>` path
 * that can see those definitions.
 *
 * That line is what lets `=` take `log10(…)` and `π` while still refusing
 * `total`. Both tokenizing (which names may become tokens) and detection
 * (how far left an expression reaches) ask this one question.
 */
function isClosedVocabulary(name: string): boolean {
    return isCallName(name) || CONSTANTS.has(name.toLowerCase());
}

/**
 * How a tokenizer treats a run of identifier characters.
 * - `closed`: only a closed-vocabulary name becomes an `ident`; any other run
 *   is left unconsumed, so `x` still falls through to multiplication and
 *   every other letter fails the grammar. This is the `=` path.
 * - `open`: every run becomes an `ident`, resolved later against a scope.
 *   This is the `=>` path, where `x` is a variable rather than an operator.
 */
type IdentMode = "closed" | "open";

/**
 * Splits `input` into tokens, or returns null the moment it sees anything that
 * is not part of the grammar — `,`, `$`, `=`, whatever. `**` collapses to a
 * single `^` token. A number must carry at least one digit (`.` alone is not a
 * number), and may carry at most one decimal point.
 *
 * `idents` gates which names are tokens at all (see IdentMode). In `closed`
 * mode an identifier run is looked up before it is consumed, so an unknown
 * name is not a token but a parse failure — `alert(1)` and `2 + a` are as
 * rejected as they ever were, while `log10(4)` and `π` now tokenize. In
 * `open` mode every run becomes an `ident` for a scope to resolve.
 *
 * The lookahead in `closed` mode is what keeps `x`-as-multiplication alive:
 * the run is consumed only if the whole name is known, so `1024x768` still
 * falls through to the `x` branch below rather than becoming an ident named
 * `x768`.
 */
function tokenize(input: string, idents: IdentMode): Token[] | null {
    const open = idents === "open";
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }

        if (IDENT_START.test(ch)) {
            let name = "";
            let j = i;
            while (j < input.length && IDENT_CHAR.test(input[j])) { name += input[j]; j++; }
            if (open || isClosedVocabulary(name)) {
                tokens.push({ kind: "ident", name });
                i = j;
                continue;
            }
            // Closed mode, unknown name: fall through on this ONE character.
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
        const glyph = GLYPH_OPS[ch];
        if (glyph) { tokens.push({ kind: "op", value: glyph }); i++; continue; }
        // Closed grammar: `x` can only mean multiplication (`2 x 3`,
        // `1024x768`). On the open path it was consumed as an ident above.
        if (!open && ch === "x") { tokens.push({ kind: "op", value: "*" }); i++; continue; }
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
                if (right === 0 && !this.structural) { throw new CalcError("modulo by zero"); }
                // FLOORED modulo — the sign follows the divisor, as in every
                // calculator a reader is likely to paste into (see the header).
                // JS's own `%` truncates, so `-10 % 3` must not be `left % right`.
                left = right === 0 ? 0 : ((left % right) + right) % right;
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
            const lower = tok.name.toLowerCase();
            const fn = FUNCTIONS.get(lower);
            if (fn && this.peek()?.kind === "lparen") {
                this.pos++;
                const arg = this.parseExpr();
                const close = this.peek();
                if (!close || close.kind !== "rparen") { throw new CalcError("unbalanced parentheses"); }
                this.pos++;
                return fn(arg);
            }
            // An AMBIGUOUS name parses as a call — the shape is real, and every
            // surface that asks "is this an equation?" must say yes so the
            // refusal can be EXPLAINED (a ledger cue, a menu offering each
            // reading) instead of the line silently reading as prose. It just
            // never yields a value: see AMBIGUOUS_FUNCTIONS.
            if (AMBIGUOUS_FUNCTIONS.has(lower) && this.peek()?.kind === "lparen") {
                this.pos++;
                this.parseExpr();
                const close = this.peek();
                if (!close || close.kind !== "rparen") { throw new CalcError("unbalanced parentheses"); }
                this.pos++;
                if (this.structural) { return 1; }
                throw new CalcError(`ambiguous function: ${tok.name}`);
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
 * `resolve` opts into VARIABLE support (the `=>` path): when provided, every
 * identifier is tokenized and resolved through it — an unknown name yields
 * `null`, exactly like a syntax error. Without it (the `=` path) the grammar
 * is closed: arithmetic plus the fixed vocabulary of call names and constants,
 * which mean the same thing with no scope to consult. A name outside it is
 * still rejected at the tokenizer, so `=` never depends on a definition.
 */
export function evaluateExpression(
    input: string,
    resolve?: (name: string) => number | undefined,
): number | null {
    const tokens = tokenize(input, resolve ? "open" : "closed");
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
    const tokens = tokenize(input, "open");
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
    /** The expression (trimmed), e.g. `12 * 4` or `log10(100)`. */
    expr: string;
    /** The formatted result text, e.g. `48`. */
    result: string;
}

/** The `=` (with any trailing spaces/tabs) that ends the text before the caret. */
const TRAILING_EQUALS = /=[ \t]*$/;

/** What a backward run walk found: where the expression starts, and whether it
 * had to cross a call to get there (the "this is a formula" evidence a run
 * without operators otherwise lacks — `log10(100)` has no operator at all). */
interface ClosedRun {
    start: number;
    sawCall: boolean;
}

/**
 * The identifier occupying the boundary at `at` — the maximal identifier-char
 * run around it, read in BOTH directions. Reading right matters as much as
 * reading left: an arithmetic walk stops at the first character outside its
 * class, and a name's own digits are inside it, so a walk over `log10(` halts
 * mid-name with `10` already behind it. Returns null when the run is not an
 * identifier (a bare number: `1024` in `1024x768`), never a partial name.
 *
 * `floor` bounds the leftward read, so a caller's run cap holds even when the
 * character at the boundary opens a very long word.
 */
function identifierAt(text: string, at: number, floor: number, limit: number): { name: string; start: number } | null {
    let s = at;
    while (s > floor && IDENT_CHAR.test(text[s - 1])) { s--; }
    // Stopped by the floor rather than by a non-identifier character: the name
    // continues past where this caller may look, so what was collected is a
    // TAIL of it (`…mylog10` cut to `log10`) and crossing it would compute a
    // fragment. An unreadable name is no name.
    if (s === floor && floor > 0 && IDENT_CHAR.test(text[s - 1])) { return null; }
    let e = at;
    while (e < limit && IDENT_CHAR.test(text[e])) { e++; }
    if (s === e || !IDENT_START.test(text[s])) { return null; }
    return { name: text.slice(s, e), start: s };
}

/**
 * Walks left from `end` over an expression in the CLOSED grammar, returning
 * where it starts. Arithmetic characters are crossed as they always were; the
 * walk additionally steps over a closed-vocabulary name — a constant (`π`), or
 * a call name whose `(` it just crossed (`log10(`) — and then keeps going, so
 * `3+log10(2²)/π^2` is reached end to end.
 *
 * A name outside that vocabulary STOPS the walk rather than being crossed,
 * which is the whole safety property: `total + 2 =` still reaches only ` + 2`,
 * whose leading operator the caller then refuses. No prose word is ever
 * crossed, so this needs none of the `=>` path's drop-a-token-and-retry
 * machinery, and it stays a single linear pass with no backtracking.
 *
 * `min` bounds how far left it may walk, for the callers that run inside
 * `appendTransaction` on the keystroke path and must stay bounded by their own
 * run cap rather than by the length of the line.
 */
function closedRunStart(text: string, end: number, min = 0): ClosedRun {
    let start = end;
    let sawCall = false;
    for (;;) {
        while (start > min && ARITH_RUN_CHAR.test(text[start - 1])) { start--; }
        if (start === min) { break; }
        const ident = identifierAt(text, start, min, end);
        if (!ident || !isClosedVocabulary(ident.name)) { break; }
        // Termination, structurally rather than by table inspection: a name is
        // only worth crossing if it reaches further left than the walk already
        // has. No name in the vocabulary begins with an arithmetic character
        // today, so this cannot fire — adding one must not spin the loop.
        if (ident.start >= start) { break; }
        if (!CONSTANTS.has(ident.name.toLowerCase())) {
            // A call name earns its crossing only when it is actually CALLED:
            // the first thing after it, spaces aside, must be the `(` the walk
            // has already crossed. `sin` alone is a name we know and a value we
            // don't, and crossing it would build an expression that cannot
            // parse anyway.
            let after = ident.start + ident.name.length;
            while (after < end && (text[after] === " " || text[after] === "\t")) { after++; }
            if (text[after] !== "(") { break; }
            sawCall = true;
        }
        start = ident.start;
    }
    return { start, sawCall };
}

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
 * - The characters immediately before `=` must be a run in the CLOSED grammar
 *   that parses to a finite value: arithmetic, plus call names and constants
 *   (`3+log10(2²)/π^2 =`). A name outside that vocabulary stops the walk, so
 *   `total =` and `x =` still fail, as do `a==b` (the char before the second
 *   `=` is `=`, not expression material) and `==highlight==`.
 * - The expression must carry at least one operator OR a call, so echoing a
 *   bare number back (`the answer is 42 =` → `42`) never triggers, while
 *   `log10(100) =` — which has no operator and an answer you cannot see —
 *   does.
 *
 * An ambiguous name (`log(100) =`) is refused in silence here, where `=>`
 * offers a menu of readings. That asymmetry is the paranoia difference, not an
 * oversight: `=>` is typed on purpose and can afford to explain itself, while
 * `=` appears in ordinary prose and every one of its refusals is silent — a
 * menu opening on a line the user did not mean as arithmetic is the failure
 * this path is built to avoid.
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
    const walk = closedRunStart(beforeEquals, eq.index);
    let run = beforeEquals.slice(walk.start);
    let shedLead = 0;
    // `x` is in the arithmetic class as multiplication, but a LONE `x` heading
    // the run can't be an operator (no left operand) — it reads as prose or a
    // variable name, exactly as it did before `x` joined the grammar. Shed it,
    // so `x 12*4 =` still computes 48 while `2 x 3 =` multiplies.
    while (/^[ \t]*x[ \t]/.test(run)) {
        const shorter = run.replace(/^[ \t]*x/, "");
        shedLead += run.length - shorter.length;
        run = shorter;
    }
    const expr = run.trim();
    if (!expr || !(HAS_EQ_OPERATOR.test(expr) || walk.sawCall)) { return null; }
    const runStart = walk.start + shedLead;
    // A run starting at position 0 of a possibly-truncated window: the char
    // before it is invisible, so the token-split guard below cannot rule out
    // that this run is the TAIL of a larger token (`1,000…` with the comma cut
    // off). Refuse rather than risk computing a fragment.
    if (runStart === 0 && opts?.boundaryUnknown) { return null; }
    // Left-boundary discipline. The run is MAXIMAL, so whatever precedes it is
    // either outside the grammar or a name outside the vocabulary — but the run
    // can still be a fragment of a larger token, and evaluating a fragment
    // produces a silently WRONG answer, the worst possible outcome:
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
    //
    // Shed an unmatched OPEN paren at the head AFTER those guards, never
    // before: `(` is in the arithmetic class, so `the formula (3+7 =` runs back
    // through the paren and fails to parse — but the parenthesis is prose
    // punctuation the user will close after the answer (`(3+7= 10)`). Order
    // matters both ways: `f(3+7 =` is already rejected above as glued (a call,
    // not arithmetic), and OP_HEAD must judge the UNSTRIPPED head, where a
    // leading `(` legitimately proves a following `-` is unary (`(-3+7 =`).
    const shed = stripUnmatchedLeadingParens(expr);
    if (!shed.expr) { return null; }
    const value = evaluateExpression(shed.expr);
    if (value === null) { return null; }
    const result = formatCalcResult(value);
    if (result === null) { return null; }
    // Span from the expression's first character (after any leading run
    // whitespace and any shed paren) through the caret (the end of textBefore).
    const leadingWs = run.length - run.replace(/^[ \t]+/, "").length;
    const start = runStart + leadingWs + shed.dropped;
    return { length: textBefore.length - start, expr: shed.expr, result };
}

/**
 * Drops OPEN parentheses from the head of `expr` that nothing closes — the one
 * shape where a paren belongs to the prose rather than the expression:
 * `here's the formula (3+7 =` is on its way to `(3+7= 10)`, so the run's
 * leading `(` must not make the whole thing unparseable. A paren that IS closed
 * is real grouping and survives untouched (`(3+7)*2`), and a leading `(` in the
 * middle of a still-open expression is not at the head, so `2*(3+7 =` keeps
 * refusing — answering `3+7` there would compute a different question than the
 * one on screen. Returns the surviving expression and how many characters were
 * shed, so callers can shift their span start past them.
 *
 * Linear: one stack pass marks every unclosed open, then the head is walked
 * while it sits on a marked one.
 */
function stripUnmatchedLeadingParens(expr: string): { expr: string; dropped: number } {
    const open: number[] = [];
    for (let i = 0; i < expr.length; i++) {
        if (expr[i] === "(") { open.push(i); } else if (expr[i] === ")" && open.length) { open.pop(); }
    }
    if (open.length === 0) { return { expr, dropped: 0 }; }
    const unmatched = new Set(open);
    let i = 0;
    for (;;) {
        let j = i;
        while (expr[j] === " " || expr[j] === "\t") { j++; }
        if (expr[j] !== "(" || !unmatched.has(j)) { break; }
        j++;
        while (expr[j] === " " || expr[j] === "\t") { j++; }
        i = j;
    }
    return { expr: expr.slice(i), dropped: i };
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
 *
 * Located by walking the closed grammar back from the caret and asking what
 * stopped it: an `=` means everything after it is expression material and
 * nothing else can be, which is the same question the trailing form asks from
 * the other side. Sharing the walk is what keeps the two forms from drifting
 * apart on what the grammar admits.
 */
function detectLeadingForm(textBefore: string, boundaryUnknown: boolean): CalcMatch | null {
    const walk = closedRunStart(textBefore, textBefore.length);
    const start = walk.start - 1; // the `=` itself
    if (start < 0 || textBefore[start] !== "=") { return null; }
    // The `=` needs a real left boundary: line start, or whitespace. A letter or
    // digit before it is a prose assignment (`a=5+7`), and a second `=` is
    // highlight syntax (`==x`).
    if (start > 0 && textBefore[start - 1] !== " " && textBefore[start - 1] !== "\t") { return null; }
    // `^` matched at position 0 of a possibly-truncated window: the true
    // preceding char is invisible and could be a letter (`a=5+7` — a prose
    // assignment the boundary rule exists to reject). A real whitespace
    // boundary is inside the window and stays trusted.
    if (boundaryUnknown && start === 0) { return null; }
    const expr = textBefore.slice(walk.start).trim();
    if (!expr || !(HAS_EQ_OPERATOR.test(expr) || walk.sawCall)) { return null; }
    const value = evaluateExpression(expr);
    if (value === null) { return null; }
    const result = formatCalcResult(value);
    if (result === null) { return null; }
    return { length: textBefore.length - start, expr, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Living calculation" layer: the `=>` operator, named variables, and OFFLINE
// unit conversion (MAR-196). Everything here is still the same
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
    /** Where each unit name starts in the input, so a name can be rewritten in
     *  place. Both units are single tokens, so the offset plus the name's own
     *  length is the whole span. */
    fromAt: number;
    toAt: number;
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
    // `left` is a prefix of `input`, so an offset into it is already an offset
    // into `input`; the target is the last token of the match.
    return {
        numExpr,
        fromUnit,
        toUnit,
        fromAt: unitMatch.index,
        toAt: sep.index + sep[0].length - toUnit.length,
    };
}

/**
 * Whether `input` has either unit-conversion SHAPE — numeric (`3 km in mi`) or
 * a tagged variable's (`t in weeks`) — independent of whether the units are
 * known. Expressions with this shape carry a premise outside their own literal
 * text (the unit catalog), which is what the stale-cue classifier keys on: it
 * must defer such a line rather than judge it while the lazy engine is cold,
 * where every conversion answers null.
 */
export function isUnitForm(input: string): boolean {
    return parseUnitForm(input) !== null || parseTaggedConversion(input) !== null;
}

/**
 * Whether `input` is a unit conversion that can NEVER compute: both units are
 * known but dimensionally incompatible (`3 km in kg`). Detection refuses such
 * spans outright (a span that can't compute is never offered), so an ALREADY
 * ANSWERED conversion whose unit was edited into impossibility escapes every
 * detection-based path — this is the stale-cue classifier's fallback for
 * exactly that case. Unknown units stay false: a word that isn't in the
 * catalog reads as prose, not as a broken formula.
 */
export function isImpossibleUnitConversion(input: string): boolean {
    if (!calcUnitsReady()) { return false; }
    const form = parseUnitForm(input);
    if (!form || !isValidExpressionStructure(form.numExpr)) { return false; }
    return isKnownUnit(form.fromUnit)
        && isKnownUnit(form.toUnit)
        && !unitsCompatible(form.fromUnit, form.toUnit);
}

/** The parsed pieces of a `<variable> (in|to) <unit>` form. */
interface TaggedForm {
    name: string;
    toUnit: string;
}

/**
 * The bare-variable conversion shape `<variable> (in|to) <unit>` — `t in weeks`.
 * A whole-input match, deliberately: anything before the variable makes this a
 * numeric conversion instead (`2 t in kg` is two tonnes, and parseUnitForm owns
 * it), and anything after it is not this shape at all. Whether the variable
 * carries a unit tag is the caller's question, not a shape question.
 */
const TAGGED_CONVERSION = /^\s*([A-Za-zπτ_][\wπτ]*)\s+(?:in|to)\s+([A-Za-z°]+)\s*$/u;

function parseTaggedConversion(input: string): TaggedForm | null {
    const m = TAGGED_CONVERSION.exec(input);
    return m ? { name: m[1], toUnit: m[2] } : null;
}

/**
 * A variable scope: every name a `=>` or a block line can resolve, mapped to a
 * PLAIN NUMBER, plus the optional `units` side table of UNIT TAGS.
 *
 * A tag records the unit a value is IN, and exists for one shape: a definition
 * whose right-hand side is a conversion (`t = 24*60*60*1000 ms in days`) stores
 * the dimensionless `1`, and without the tag the "days" is gone — so `t in
 * weeks` has nothing to convert FROM and the writer has to restate the unit
 * (MAR-201). A tag is written only by applyDefinition, and only from the
 * conversion that produced the value; any other right-hand side CLEARS it, so a
 * redefinition (`t = 5`) can never leave an old unit attached to a new number.
 *
 * The tag deliberately does not survive arithmetic: `u = t * 2` is a plain
 * number, and `u in weeks` refuses rather than guessing that doubling a
 * duration keeps its unit. Full unit algebra would mean routing arithmetic
 * through mathjs, which the header's safety posture forbids; restating the unit
 * (`t * 2 days in weeks`) computes today and says what was meant.
 *
 * `units` is a property rather than a richer value type so that `scope.get(x)`
 * stays a number for every consumer, and a plain `Map<string, number>` is still
 * a scope. The one thing it cannot survive is a COPY: `new Map(scope)` drops
 * the tags. Nothing copies a scope today; build one through buildScopeFromLines
 * or applyDefinition instead.
 */
export interface CalcScope extends Map<string, number> {
    units?: Map<string, string>;
}

/** A calc value with the unit it is IN, when a conversion produced it. */
interface TaggedValue {
    value: number;
    unit?: string;
}

/** Converts a tagged variable to `form.toUnit`; null when it carries no tag
 * (an ordinary number has no unit to convert FROM) or the dimensions differ. */
function convertTagged(form: TaggedForm, scope?: CalcScope): number | null {
    const from = scope?.units?.get(form.name);
    const value = scope?.get(form.name);
    if (from === undefined || value === undefined) { return null; }
    return convertUnit(value, from, form.toUnit);
}

/**
 * Evaluate a "living calculation" expression AND report the unit its value is
 * in, which is what a definition records as its tag. Three readings, in this
 * order, first one that computes wins:
 *  - a numeric unit conversion (`3 km in mi`, `2 t in kg`) — first, so a number
 *    in front always means the word after it is a UNIT, never a variable;
 *  - a tagged variable's conversion (`t in weeks`), which chains: `u = t in
 *    weeks` tags `u` as weeks in turn;
 *  - ordinary arithmetic with variables (`rent / budget * 100`), untagged.
 */
function evaluateCalcTagged(input: string, scope?: CalcScope): TaggedValue | null {
    const resolve = (name: string): number | undefined => scope?.get(name);
    const form = parseUnitForm(input);
    if (form) {
        const value = evaluateExpression(form.numExpr, resolve);
        const converted = value === null ? null : convertUnit(value, form.fromUnit, form.toUnit);
        if (converted !== null) { return { value: converted, unit: form.toUnit }; }
    }
    const tagged = parseTaggedConversion(input);
    if (tagged) {
        const converted = convertTagged(tagged, scope);
        if (converted !== null) { return { value: converted, unit: tagged.toUnit }; }
    }
    const value = evaluateExpression(input, resolve);
    return value === null ? null : { value };
}

/**
 * Evaluate a "living calculation" expression: a unit conversion (`3 km in mi`,
 * or a tagged variable's `t in weeks`) or ordinary arithmetic with variables
 * (`rent / budget * 100`). `scope` supplies variable values; an unknown name
 * (or a bad unit / shape) yields null, so the caller shows nothing. This is the
 * `=>` counterpart to the `=` path's bare `evaluateExpression`.
 */
export function evaluateCalc(input: string, scope?: CalcScope): number | null {
    return evaluateCalcTagged(input, scope)?.value ?? null;
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
    const tagged = parseTaggedConversion(input);
    // Whether the variable is TAGGED needs a scope, which structure-land does
    // not have — so the target unit is the whole test, and an untagged variable
    // simply yields no result at fetch time. The engine-cold case must accept
    // too, and here that is load-bearing rather than merely symmetric with the
    // form above: shouldSuggest gates the fetch that loads the engine, so a
    // refusal while it is cold would refuse forever.
    if (tagged && (!calcUnitsReady() || isKnownUnit(tagged.toUnit))) { return true; }
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
const CALC_RUN = /[\wπτ⁰¹²³⁴⁵⁶⁷⁸⁹+\-*/%^×·⋅÷−().°'" \t]*$/u;
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
 * prose line and drop a bounded number of leading words. A run longer than the
 * cap force-drops its first token (the cut point is never a trusted boundary):
 * capped PROSE still trims through to its tail expression, while a capped
 * EXPRESSION refuses outright — its head is an undroppable number/paren.
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
        // An unmatched OPEN paren at the head is prose punctuation, not
        // expression material (`the formula (3+7 =>` → `3+7`); the `=>` says
        // the expression is finished, so a paren with no partner cannot be part
        // of it. Judged on the STRIPPED candidate, while OP_HEAD is still asked
        // of the unstripped head — there a leading `(` proves a following `-`
        // is unary (`(-3+7 =>`), exactly as on the `=` path.
        const stripped = stripUnmatchedLeadingParens(expr).expr;
        if (!mustDrop
            && stripped
            && isCalcStructurallyValid(stripped)
            && !isBareNumber(stripped)
            // An operator head is only unary when the candidate is the whole
            // run at a true, untruncated line start.
            && !(OP_HEAD.test(expr) && (drops > 0 || runStart > 0 || opts?.boundaryUnknown))
        ) { expr = stripped; break; }
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
    const tokens = tokenize(expr, "open");
    if (!tokens) { return false; }
    return tokens.some(
        (tok, i) =>
            tok.kind === "ident" &&
            !(isCallName(tok.name) && tokens[i + 1]?.kind === "lparen"),
    );
}

/**
 * The variable names in `expr` that `scope` does not resolve (function calls
 * and constants excluded). The withdrawal guards use this to ask WHY an
 * expression stopped computing — an unresolved name whose definition is
 * visibly mid-edit is transient, not vanished.
 */
export function unresolvedVariables(expr: string, scope: CalcScope): string[] {
    // A tagged conversion has exactly ONE variable; its keyword and target unit
    // tokenize as names too, and the broken cue shows the FIRST unresolved one.
    // For an untagged or dimension-mismatched conversion that would be `in`,
    // which is not a name any definition could restore.
    const tagged = parseTaggedConversion(expr);
    if (tagged) { return scope.has(tagged.name) ? [] : [tagged.name]; }
    const tokens = tokenize(expr, "open");
    if (!tokens) { return []; }
    const names: string[] = [];
    tokens.forEach((tok, i) => {
        if (tok.kind !== "ident") { return; }
        if (isCallName(tok.name) && tokens[i + 1]?.kind === "lparen") { return; }
        if (scope.has(tok.name) || CONSTANTS.has(tok.name.toLowerCase())) { return; }
        names.push(tok.name);
    });
    return names;
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
 * The name of a definition-SHAPED line head (`x = …`), valid RHS or not — or
 * null when the line has no such head. This is the mid-edit guard's question,
 * shared by the refresh engine's withdrawal and the stale-cue classifier so
 * the two can never drift: an unresolved name that still has a head above is
 * being retyped, not vanished, and must not orphan its dependents.
 */
export function definitionHeadName(line: string): string | null {
    return /^\s*([A-Za-zπτ_][\wπτ]*)\s*=(?![=>])/u.exec(line)?.[1] ?? null;
}

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
 * Every definition on a line. A line can carry several, separated by `,` or
 * `;` (`a=5, b=2`) — but ONLY when every segment parses as a definition:
 * all-or-nothing, because `a = 1,000` must read as one definition attempt
 * (digit grouping), never be split into a silent, wrong `a = 1`. A line that
 * fails the multi reading falls back to the single-definition parse.
 */
export function parseDefinitions(line: string): Array<{ name: string; rhs: string }> {
    const segments = line.split(/[,;]/);
    if (segments.length > 1) {
        const defs = segments.map((segment) => parseDefinition(segment));
        if (defs.every((def) => def !== null)) {
            return defs as Array<{ name: string; rhs: string }>;
        }
    }
    const single = parseDefinition(line);
    return single ? [single] : [];
}

/**
 * The one definition-evaluation step shared by every scope builder: resolve
 * the right-hand side against the definitions seen so far and, when it yields
 * a value, enter it into `scope`. Returns the value, or null when the RHS does
 * not resolve (the scope is left untouched — a broken definition never
 * clobbers an earlier good one).
 *
 * This is also the ONLY writer of unit tags (see CalcScope): a conversion RHS
 * tags the name with the unit its value is in, and every other RHS clears the
 * tag, so a redefinition can never leave `t` reading as days once it is 5.
 */
export function applyDefinition(
    def: { name: string; rhs: string },
    scope: CalcScope,
): number | null {
    const out = evaluateCalcTagged(def.rhs, scope);
    if (out === null) { return null; }
    scope.set(def.name, out.value);
    if (out.unit === undefined) {
        scope.units?.delete(def.name);
    } else {
        (scope.units ??= new Map()).set(def.name, out.unit);
    }
    return out.value;
}

/**
 * Builds a variable scope from document lines, top to bottom: each
 * `name = expr` line whose right-hand side resolves to a finite number (using
 * the names defined ABOVE it) adds/overrides that name. Sequential, so a
 * definition may reference earlier ones and a later redefinition wins — the
 * predictable, spreadsheet-like reading a reader gets scanning down the page.
 */
export function buildScopeFromLines(lines: readonly string[]): CalcScope {
    const scope: CalcScope = new Map<string, number>();
    for (const line of lines) {
        for (const def of parseDefinitions(line)) { applyDefinition(def, scope); }
    }
    return scope;
}

// ── Calculation block (a fenced ```calc region) ──────────────────────────────

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
    /**
     * The ambiguous names (`log`) that stopped an `error` line from computing.
     * Present only when they are the REASON — the ledger turns this into a
     * specific explanation, so a refusal the reader can fix reads as an
     * instruction rather than a dead end.
     */
    ambiguous?: readonly string[];
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
function looksLikeFormula(expr: string, scope: CalcScope): boolean {
    const form = parseUnitForm(expr);
    if (form && isKnownUnit(form.fromUnit) && isKnownUnit(form.toUnit)) {
        return true;
    }
    // A tagged variable converted to a known unit: the evidence is the TAG, not
    // the words — `t in kg` is a formula when `t` is a duration (and refuses,
    // dimensions being what they are), while the same line with an untagged `t`
    // is prose and stays uncued.
    const tagged = parseTaggedConversion(expr);
    if (tagged && scope.units?.has(tagged.name) && isKnownUnit(tagged.toUnit)) {
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
    const tokens = tokenize(expr, "open");
    if (!tokens) { return false; }
    return tokens.some(
        (tok) =>
            tok.kind === "num" ||
            (tok.kind === "ident" && (scope.has(tok.name) || isCallName(tok.name))),
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
    const scope: CalcScope = new Map<string, number>();
    /** An `error` row, naming the ambiguity when that is why it has no value. */
    const errorLine = (raw: string, inspect: string): CalcBlockLine => {
        const ambiguous = ambiguousNamesIn(inspect);
        return ambiguous.length > 0
            ? { raw, result: null, kind: "error", ambiguous }
            : { raw, result: null, kind: "error" };
    };
    return source.split("\n").map((raw): CalcBlockLine => {
        if (!raw.trim() || CALC_COMMENT.test(raw)) { return { raw, result: null, kind: "silent" }; }

        const line = raw.replace(CALC_TRAILING_EQ, "");
        const defs = parseDefinitions(line);
        if (defs.length > 1) {
            // A multi-definition line (`a=5, b=2`): literal segments spell
            // their values; COMPUTED segments (`b=2+3`) echo theirs, joined,
            // exactly like a single computed definition would.
            const shown: string[] = [];
            let allApplied = true;
            for (const def of defs) {
                const value = applyDefinition(def, scope);
                if (value === null) { allApplied = false; continue; }
                // Same literal-RHS rule as a single definition: a spelled-out
                // value (`5.0`, `0.50`) never echoes, whatever its canonical
                // form; only COMPUTED segments show their result.
                if (/^-?[0-9.]+$/.test(def.rhs)) { continue; }
                const formatted = formatCalcResult(value);
                if (formatted !== null && formatted !== def.rhs) { shown.push(formatted); }
            }
            if (!allApplied) { return errorLine(raw, line); }
            return shown.length > 0
                ? { raw, result: shown.join(", "), kind: "value" }
                : { raw, result: null, kind: "silent" };
        }
        const def = defs[0];
        if (def) {
            const value = applyDefinition(def, scope);
            if (value === null) { return errorLine(raw, def.rhs); }
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
            return looksLikeFormula(expr, scope)
                ? errorLine(raw, expr)
                : { raw, result: null, kind: "silent" };
        }
        const formatted = formatCalcResult(value);
        if (formatted === null) { return { raw, result: null, kind: "error" }; }
        return { raw, result: formatted, kind: "value", value };
    });
}

// ── Refresh scanning (the answer-maintenance engine's text layer) ────────────

/** One equation occurrence in a block's text, as the refresh hook consumes it. */
export interface EquationSpan {
    /** `trailing`: `expr = result`. `leading`: `result=expr` (the `=`-first
     * insert). `arrow`: `expr => result` — the living-calculation form, whose
     * expression may carry variables and units. */
    form: "trailing" | "leading" | "arrow";
    /** Character span of the expression side. For the trailing and arrow
     * forms, `expr[1]` is the INDEX OF the `=` itself — consumers slicing
     * `[expr[0], expr[1])` get the expression without it, and the validation
     * paths add `+1`/`+2` to include the marker. */
    expr: [number, number];
    /** Character span of the result text, end-exclusive. */
    res: [number, number];
    /** The current result text, verbatim (may carry the user's `,` grouping). */
    resultText: string;
}

/**
 * Whether a shown result text is the same number as a freshly computed one,
 * comma-blind: `1,500` for a recomputed `1500` is the same value in the user's
 * grouping style. The ONE comparison idiom for "does this answer still hold",
 * shared by the refresh engine and the stale-cue classifier so they can never
 * disagree about what counts as stale.
 */
export function resultTextMatches(computed: string, shown: string): boolean {
    return computed === shown.replace(/,/g, "");
}

/** A previously-inserted result: optional minus, digits with `,` grouping
 * (a comma must sit BETWEEN digits — `5, then` keeps its prose comma),
 * optional decimals. Sticky, so it anchors exactly where the scan points it. */
const RESULT_NUMBER = /-?\d(?:[\d,]*\d)?(?:\.\d+)?/y;
/** The same shape, anchored — validates a backward-collected candidate. */
const RESULT_NUMBER_EXACT = /^-?\d(?:[\d,]*\d)?(?:\.\d+)?$/;
const RESULT_CHAR = /[\d,.]/;
/** A char an expression can END on: digit, `)`, or a superscript exponent —
 * `5²=` is a maintainable equation just like `5^2=`. */
const VALUE_END = /[0-9)⁰¹²³⁴⁵⁶⁷⁸⁹]/;
/** One character of a `=` expression run, scanned FORWARD (the leading form's
 * `result=expr`). Identifier characters are admitted so a run can reach through
 * a call name; which names are actually legal is settled by the re-validation
 * every candidate goes through, not here. Backward walks use closedRunStart,
 * which can consult the vocabulary as it goes and so stays exact. */
const CLOSED_RUN_CHAR = new RegExp(`[${ARITHMETIC_CLASS}\\wπτ \\t]`, "u");
/** One character of an `=>` expression run (letters allowed — variables, units). */
const ARROW_RUN_CHAR = /[\wπτ⁰¹²³⁴⁵⁶⁷⁸⁹+\-*/%^×·⋅÷−().°'" \t]/u;

/**
 * Finds `expr = result` / `result=expr` / `expr => result` equation shapes in
 * `text` whose spans intersect [from, to] — the candidates the refresh engine
 * (plugins/calcRefresh.ts) re-validates before touching anything.
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
        // The same closed-grammar walk the detector uses, so an equation whose
        // expression opens with a call (`3+log10(2)= 3.301`) reports a span
        // that reaches its own first character. A shorter span would leave an
        // edit to that opening literal outside the candidate, and the answer
        // would sit there stale.
        const runStart = closedRunStart(text, e, Math.max(0, e - maxRun)).start;
        let runEnd = e; // exclusive; walk back over the spaces before `=`
        while (runEnd > runStart && (text[runEnd - 1] === " " || text[runEnd - 1] === "\t")) {
            runEnd--;
        }
        const lastCh = text[runEnd - 1];
        if (runEnd > runStart && VALUE_END.test(lastCh)) {
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
            while (exprEnd < text.length && exprEnd - exprStart < maxRun && CLOSED_RUN_CHAR.test(text[exprEnd])) {
                exprEnd++;
            }
            while (exprEnd > exprStart && !VALUE_END.test(text[exprEnd - 1])) {
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
