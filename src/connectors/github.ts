/**
 * src/connectors/github.ts
 *
 * The GitHub connector's response mapper (MAR-198, MAR-186 P1 item 3): one
 * api.github.com JSON body to the provider-agnostic card the webview renders.
 *
 * GitHub is the connector that proves the seam, because it is the one rung on
 * the auth ergonomics ladder that needs nothing from anybody: VS Code ships a
 * GitHub authentication provider, so there is no app to register, no client
 * secret to hide, and no token for the user to paste or for us to refresh.
 *
 * Hand-rolled against the REST shape, with no client SDK, per
 * NETWORK_POSTURE invariant 5's sibling rule in MAR-198: a dependency here
 * would be an unauditable surface and eager weight for one card.
 *
 * Every string that leaves this module is sanitized (`sanitizeTitle`: entities
 * decoded, control characters stripped, whitespace collapsed, length capped)
 * before it crosses to the webview, which renders it as third-party content.
 */
import * as vscode from "vscode";
import { sanitizeTitle } from "../utils/openGraph";
import { githubCardParts, type EmbedMatch } from "../../shared/embedProviders";
import type { EmbedCardData } from "../../shared/connectors";

/** Read one string field off an untrusted JSON body, sanitized or undefined. */
function str(body: unknown, key: string): string | undefined {
    const value = (body as Record<string, unknown> | null)?.[key];
    return typeof value === "string" ? (sanitizeTitle(value) ?? undefined) : undefined;
}

/** The `login` of a nested user object (`user`, `owner`), sanitized. */
function login(body: unknown, key: string): string | undefined {
    const nested = (body as Record<string, unknown> | null)?.[key];
    return typeof nested === "object" && nested !== null ? str(nested, "login") : undefined;
}

/**
 * The state word for a pull request. `merged` outranks `state`, because
 * GitHub reports a merged PR as closed and the two are not the same news.
 */
function pullStatus(body: unknown): string {
    const record = body as Record<string, unknown> | null;
    if (record?.merged === true || typeof record?.merged_at === "string") {
        return vscode.l10n.t("Merged");
    }
    if (record?.state === "open") {
        return record.draft === true ? vscode.l10n.t("Draft") : vscode.l10n.t("Open");
    }
    return vscode.l10n.t("Closed");
}

/**
 * Build the card for a recognized GitHub embed from its API response, or null
 * when the body is not the shape this endpoint promises (which the caller
 * turns into an `error` card rather than a blank one).
 */
export function githubCard(match: EmbedMatch, body: unknown): EmbedCardData | null {
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const parts = githubCardParts(match.id);
    if (parts.kind === "repo") {
        const title = str(body, "full_name") ?? `${parts.owner}/${parts.repo}`;
        const description = str(body, "description");
        const record = body as Record<string, unknown>;
        return {
            title,
            ...(description ? { subtitle: description } : {}),
            // Whether the repository is private is the one fact a rung-0 card
            // provably cannot know, and the one a reader most often wants: it
            // says why the link opens to a 404 for a colleague.
            ...(record.private === true ? { status: vscode.l10n.t("Private") } : {}),
        };
    }
    const title = str(body, "title");
    if (!title) {
        return null;
    }
    const author = login(body, "user");
    const number = parts.number ? `#${parts.number}` : "";
    // One placeholder string rather than a concatenated preposition: "by" on
    // its own is not a translatable unit.
    const subtitle = author ? vscode.l10n.t("{0} by {1}", number, author).trim() : number;
    const status = parts.kind === "pull"
        ? pullStatus(body)
        : (body as Record<string, unknown>).state === "open"
            ? vscode.l10n.t("Open")
            : vscode.l10n.t("Closed");
    return { title, ...(subtitle ? { subtitle } : {}), status };
}
