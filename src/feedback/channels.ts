/**
 * src/feedback/channels.ts
 *
 * Where a composed feedback message can go, and the URLs that take it there.
 * Pure — it builds strings; `sendFeedback.ts` is what hands them to the host.
 *
 * **This is why the feedback command is rung 0** (`docs/NETWORK_POSTURE.md`
 * §1): Birta never makes the request. It composes a URL and asks the host to
 * open it, so the outbound call is made by the user's own browser or mail
 * client, under their own identity, against a form they can still read and
 * edit before they press send. That is a categorically different thing from
 * telemetry, and it is why the command needs no consent key and works with
 * `birta.network.enabled` off.
 */

/** The repository a prefilled issue is filed against. */
export const FEEDBACK_REPO = "harlanlewis/birta-writer";

/**
 * Practical ceiling for a prefilled URL. Browsers and servers both impose
 * limits well above this, but GitHub starts rejecting long prefills before the
 * theoretical maximum, and a truncated report the user can repair beats a
 * page that will not load.
 */
export const GITHUB_URL_BUDGET = 6000;

/** Appended when a body had to be cut to fit a URL budget. */
export const TRUNCATION_NOTE =
    "\n\n_(Truncated to fit the link. The full text is on your clipboard — paste it here.)_";

/**
 * Cut `body` so that the finished URL fits `budget`, leaving room for the
 * truncation note. Returns the body unchanged when it already fits.
 *
 * The measurement is done on the *encoded* length, because that is what the
 * URL actually costs — a body of newlines and punctuation triples in size once
 * escaped, so measuring the raw string would under-count by a wide margin.
 */
export function fitToBudget(body: string, overheadChars: number, budget: number): string {
    const room = budget - overheadChars;
    if (room <= 0) return TRUNCATION_NOTE.trim();
    if (encodeURIComponent(body).length <= room) return body;

    const noteCost = encodeURIComponent(TRUNCATION_NOTE).length;
    const target = Math.max(0, room - noteCost);
    // Encoded length is not linear in character count, so walk down rather
    // than compute an index: halve-and-refine would be faster and is not worth
    // the complexity for a one-shot, human-sized string.
    let cut = body;
    while (cut.length > 0 && encodeURIComponent(cut).length > target) {
        cut = cut.slice(0, Math.max(0, cut.length - Math.ceil(cut.length / 20) - 1));
    }
    return cut.trimEnd() + TRUNCATION_NOTE;
}

/**
 * A prefilled "new issue" URL. The user still has to press Submit.
 *
 * Every parameter is escaped with `encodeURIComponent`, deliberately **not**
 * `URLSearchParams` — the latter is form-encoding, which writes a space as
 * `+`, and a `+` a user actually typed would then arrive as a space.
 *
 * `truncated` is returned rather than left for the caller to sniff out of the
 * body, because it is the only thing the caller needs the clipboard for: a
 * report that fit needs no copy, and copying anyway silently destroys whatever
 * the user had on their clipboard.
 */
export function githubIssueUrl(options: { repo?: string; title: string; body: string }): {
    url: string;
    truncated: boolean;
} {
    const repo = options.repo ?? FEEDBACK_REPO;
    const prefix = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(options.title)}&body=`;
    const body = fitToBudget(options.body, prefix.length, GITHUB_URL_BUDGET);
    return { url: `${prefix}${encodeURIComponent(body)}`, truncated: body !== options.body };
}
