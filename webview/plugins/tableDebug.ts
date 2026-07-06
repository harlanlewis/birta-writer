// Debug log switch: toggle dynamically via setLogTableSel(true/false) (no page reload needed)
let logTableSel = Boolean(window.__i18n?.debugMode);

export function setLogTableSel(enabled: boolean): void {
    logTableSel = enabled;
}

export function isLogTableSelEnabled(): boolean {
    return logTableSel;
}
