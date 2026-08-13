/**
 * src/connectors/commands.ts
 *
 * The palette surface of the connector foundation (MAR-198): "Birta: Connect
 * service…" and "Birta: Disconnect service…", plus the broadcast that tells
 * open webviews which services are connected.
 *
 * The picker states the cost before the user commits: what the grant covers,
 * and for a connector whose scope cannot be narrowed, that it is wider than
 * the card needs (NETWORK_POSTURE invariant 9). A user learns that here rather
 * than at the provider's consent screen, where the only remaining choice is
 * to accept or abandon.
 *
 * Everything credential-shaped lives in ConnectorService; this module only
 * asks, reports, and rebroadcasts.
 */
import * as vscode from "vscode";
import { CONNECTOR_IDS, CONNECTORS, type ConnectorId } from "../../shared/connectors";
import type { ConnectorService } from "./connectorService";

/** A picker row, carrying the id its label stands for. */
interface ConnectorPick extends vscode.QuickPickItem {
    id: ConnectorId;
}

/**
 * Ask which service, showing its current state and what connecting grants.
 * Returns null when the user dismissed the picker.
 */
async function pickConnector(
    service: ConnectorService,
    wanted: "connected" | "disconnected",
    placeHolder: string,
): Promise<ConnectorId | null> {
    const rows: ConnectorPick[] = [];
    for (const id of CONNECTOR_IDS) {
        const connected = await service.isConnected(id);
        if (connected !== (wanted === "connected")) {
            continue;
        }
        const spec = CONNECTORS[id];
        rows.push({
            id,
            label: spec.label,
            description: connected ? vscode.l10n.t("Connected") : undefined,
            detail: wanted === "disconnected" ? spec.scopeNote : undefined,
        });
    }
    if (rows.length === 0) {
        vscode.window.showInformationMessage(
            wanted === "connected"
                ? vscode.l10n.t("No services are connected.")
                : vscode.l10n.t("Every available service is already connected."),
        );
        return null;
    }
    const chosen = await vscode.window.showQuickPick(rows, { placeHolder });
    return chosen?.id ?? null;
}

/**
 * Run the connect flow and report its outcome. Shared by the palette command
 * and the locked card's just-in-time affordance so the two cannot drift: the
 * card is a shortcut into the same flow, never a second one.
 */
export async function runConnectFlow(
    service: ConnectorService,
    id: ConnectorId,
    broadcast: () => void,
): Promise<void> {
    const result = await service.connect(id);
    if (!result) {
        // Cancelled at the provider's consent screen. Silence is the right
        // answer to a deliberate no.
        return;
    }
    if (!result.ok) {
        vscode.window.showWarningMessage(result.message ?? vscode.l10n.t("Could not connect."));
        return;
    }
    broadcast();
    vscode.window.setStatusBarMessage(
        vscode.l10n.t("Birta: {0} connected — its links now show live cards", CONNECTORS[id].label),
        5000,
    );
}

/** Is this string one of the connectors we know? Guards the webview's message. */
export function asConnectorId(value: string): ConnectorId | null {
    return (CONNECTOR_IDS as readonly string[]).includes(value) ? (value as ConnectorId) : null;
}

/**
 * Register both commands. `broadcast` re-sends the connection map to every
 * open webview, so a card locked a moment ago unlocks without a reload.
 */
export function registerConnectorCommands(
    context: vscode.ExtensionContext,
    service: ConnectorService,
    broadcast: () => void,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("birta.connectService", async () => {
            const id = await pickConnector(
                service,
                "disconnected",
                vscode.l10n.t("Connect a service so its links show live cards (read-only)"),
            );
            if (id) {
                await runConnectFlow(service, id, broadcast);
            }
        }),
        vscode.commands.registerCommand("birta.disconnectService", async () => {
            const id = await pickConnector(
                service,
                "connected",
                vscode.l10n.t("Disconnect a service and forget its credential"),
            );
            if (!id) {
                return;
            }
            await service.disconnect(id);
            broadcast();
            vscode.window.setStatusBarMessage(
                vscode.l10n.t("Birta: {0} disconnected — its credential is deleted", CONNECTORS[id].label),
                5000,
            );
        }),
    );
}
