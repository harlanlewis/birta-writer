// 调试日志开关：可通过 setLogTableSel(true/false) 动态切换（无需重载页面）
let logTableSel = Boolean(window.__i18n?.debugMode);

export function setLogTableSel(enabled: boolean): void {
    logTableSel = enabled;
}

export function isLogTableSelEnabled(): boolean {
    return logTableSel;
}
