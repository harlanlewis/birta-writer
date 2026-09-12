/**
 * src/connectors/linear.ts
 *
 * The Linear connector's response mapper (MAR-198): one api.linear.app GraphQL
 * body to the provider-agnostic card the webview renders.
 *
 * Linear is the connector that proves the OTHER half of the auth ladder.
 * GitHub needs nothing from anybody because VS Code ships its authentication
 * provider; Linear has no such host support, so it is the first provider to go
 * through the OAuth-PKCE flow: a registered public client, browser consent, and
 * tokens in SecretStorage. It is also the first provider with no GET surface at
 * all, which is why `ConnectorApiRequest` grew a body.
 *
 * Hand-rolled against the GraphQL response with no client SDK, per MAR-198's
 * rule: a dependency here would be an unauditable surface and eager weight for
 * one card.
 *
 * Every string that leaves this module is sanitized (`sanitizeTitle`: entities
 * decoded, control characters stripped, whitespace collapsed, length capped)
 * before it crosses to the webview, which renders it as third-party content.
 */
import { sanitizeTitle } from "../utils/openGraph";
import { linearCardParts, type EmbedMatch } from "../../shared/embedProviders";
import type { EmbedCardData } from "../../shared/connectors";

/** One level of an untrusted JSON body, or null. */
function obj(value: unknown, key: string): Record<string, unknown> | null {
    const nested = (value as Record<string, unknown> | null)?.[key];
    return typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>)
        : null;
}

/** Read one string field off an untrusted body, sanitized or undefined. */
function str(value: unknown, key: string): string | undefined {
    const found = (value as Record<string, unknown> | null)?.[key];
    return typeof found === "string" ? (sanitizeTitle(found) ?? undefined) : undefined;
}

/**
 * Build the card for a recognized Linear embed from its GraphQL response, or
 * null when the body is not the shape the query promises.
 *
 * Null rather than a partial card in three cases that are worth telling apart
 * in the reading even though they share an outcome: a GraphQL `errors` array
 * (the query was refused, which a 200 can carry), an empty `nodes` list (the
 * issue does not exist or this grant cannot see it), and a node with no title
 * (a shape the query cannot actually produce, so it means the body is not what
 * it claims). The caller turns null into an `error` card, never a blank one.
 *
 * GraphQL's habit of answering 200 with an `errors` array is the reason the
 * first check exists: without it a refused query would read as a malformed
 * body, and a permissions problem would be reported as a provider fault.
 */
export function linearCard(match: EmbedMatch, body: unknown): EmbedCardData | null {
    const root = body as Record<string, unknown> | null;
    if (Array.isArray(root?.errors) && root.errors.length > 0) {
        return null;
    }
    const issues = obj(obj(root, "data"), "issues");
    const nodes = issues?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return null;
    }
    const node = nodes[0];
    const title = str(node, "title");
    if (title === undefined) {
        return null;
    }

    // The identifier the API returns rather than the one parsed from the URL:
    // they agree, and preferring the API's means the card shows what the
    // provider says this issue is rather than what the link claimed.
    const identifier = str(node, "identifier") ?? linearCardParts(match.id).key;
    const assignee = str(obj(node, "assignee"), "displayName");

    return {
        title,
        // The identifier leads because it is what a reader scans for, and the
        // assignee follows only when there is one: an unassigned issue gets a
        // subtitle of just its key rather than a trailing separator.
        subtitle: assignee ? `${identifier} · ${assignee}` : identifier,
        // Linear's workflow states are workspace-defined ("In Review",
        // "Shipped"), so the state's own name is passed through rather than
        // mapped onto a fixed vocabulary. A mapping would have to guess at
        // names this code cannot know, and would be wrong in exactly the
        // workspaces that customized them.
        ...(str(obj(node, "state"), "name") !== undefined
            ? { status: str(obj(node, "state"), "name")! }
            : {}),
    };
}
