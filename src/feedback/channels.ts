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
 * Destination for the mail channel — **`null` on purpose, which disables the
 * channel.** The mail path is built, tested, and dark: Birta Labs does not yet
 * have a dedicated address, and pointing feedback at a personal inbox in the
 * interim is a commitment that is awkward to withdraw. Set this to the
 * `@birtalabs.com` address when it exists and the channel lights up with no
 * other change; `feedbackChannels.test.ts` pins both states so it cannot ship
 * half-wired in either direction. Tracked as MAR-250.
 */
export const FEEDBACK_EMAIL: string | null = null;

export type FeedbackChannel = "github" | "mail" | "clipboard";

/**
 * Practical ceiling for a prefilled URL. Browsers and servers both impose
 * limits well above this, but GitHub starts rejecting long prefills before the
 * theoretical maximum, and a truncated report the user can repair beats a
 * page that will not load. Mail clients are far stricter, hence the separate
 * (much smaller) budget.
 */
export const GITHUB_URL_BUDGET = 6000;
export const MAILTO_URL_BUDGET = 1800;

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
 * `+`. GitHub tolerates that, but `mailto:` does not (a `+` there is a literal
 * plus), and one escaping rule across both channels is worth more than the
 * convenience.
 */
export function githubIssueUrl(options: {
    repo?: string;
    title: string;
    body: string;
    labels?: string[];
}): string {
    const repo = options.repo ?? FEEDBACK_REPO;
    const base = `https://github.com/${repo}/issues/new`;
    const fixed = [`title=${encodeURIComponent(options.title)}`];
    if (options.labels?.length) {
        fixed.push(`labels=${encodeURIComponent(options.labels.join(","))}`);
    }
    const prefix = `${base}?${fixed.join("&")}&body=`;
    const body = fitToBudget(options.body, prefix.length, GITHUB_URL_BUDGET);
    return `${prefix}${encodeURIComponent(body)}`;
}

/**
 * A prefilled mail draft. Returns `null` when no destination is configured —
 * callers use that to hide the channel rather than to show a broken one.
 */
export function mailtoUrl(options: {
    to?: string | null;
    subject: string;
    body: string;
}): string | null {
    const to = options.to === undefined ? FEEDBACK_EMAIL : options.to;
    if (!to) return null;
    const overhead = `mailto:${to}?subject=${encodeURIComponent(options.subject)}&body=`.length;
    const body = fitToBudget(options.body, overhead, MAILTO_URL_BUDGET);
    return `mailto:${to}?subject=${encodeURIComponent(options.subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The channels offered, in the order they should appear. Clipboard is always
 * available and always last — it is the fallback that needs no account, no
 * mail client, and no network of any kind.
 */
export function availableChannels(email: string | null = FEEDBACK_EMAIL): FeedbackChannel[] {
    return email ? ["github", "mail", "clipboard"] : ["github", "clipboard"];
}
