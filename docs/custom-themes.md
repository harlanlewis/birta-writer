# 自定义主题配置

Markdown WYSIWYG Editor 支持自定义主题颜色，可以在 `.vscode/settings.json` 中配置。

## 配置方式

在 `.vscode/settings.json` 中添加 `markdownWysiwyg.customThemes` 配置项：

```json
{
    "markdownWysiwyg.customThemes": [
        {
            "name": "My Custom Theme",
            "colors": {
                "editor.background": "#ffffff",
                "editor.foreground": "#333333"
            }
        }
    ]
}
```

## 配置项说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 主题名称，用于在主题选择列表中显示 |
| `colors` | object | 是 | VS Code 颜色 ID 到颜色值的映射 |

## 常用颜色 ID

### 编辑器颜色
| 颜色 ID | 说明 |
|---------|------|
| `editor.background` | 编辑器背景色 |
| `editor.foreground` | 编辑器前景色 |
| `editor.selectionBackground` | 选中文本背景色 |
| `editorCursor.foreground` | 光标颜色 |
| `editor.lineHighlightBackground` | 当前行高亮背景色 |

### 文本颜色
| 颜色 ID | 说明 |
|---------|------|
| `textLink.foreground` | 链接文字颜色 |
| `textCodeBlock.background` | 行内代码背景色 |
| `textBlockQuote.border` | 引用块边框颜色 |
| `textBlockQuote.background` | 引用块背景色 |

### UI 颜色
| 颜色 ID | 说明 |
|---------|------|
| `panel.border` | 面板边框颜色 |
| `input.background` | 输入框背景色 |
| `input.foreground` | 输入框文字颜色 |
| `button.background` | 按钮背景色 |
| `button.foreground` | 按钮文字颜色 |

## 示例配置

### 深色主题示例
```json
{
    "markdownWysiwyg.customThemes": [
        {
            "name": "Dark Blue",
            "colors": {
                "editor.background": "#1a1a2e",
                "editor.foreground": "#e0e0e0",
                "textLink.foreground": "#4fc3f7",
                "textCodeBlock.background": "#2d2d2d",
                "panel.border": "#3d3d3d"
            }
        }
    ]
}
```

### 浅色主题示例
```json
{
    "markdownWysiwyg.customThemes": [
        {
            "name": "Warm Light",
            "colors": {
                "editor.background": "#faf8f5",
                "editor.foreground": "#2d2d2d",
                "textLink.foreground": "#0066cc",
                "textCodeBlock.background": "#f5f5f5",
                "panel.border": "#e0e0e0"
            }
        }
    ]
}
```

## 使用方式

1. 在 `.vscode/settings.json` 中配置自定义主题
2. 按 `Cmd+Shift+P`（macOS）或 `Ctrl+Shift+P`（Windows）
3. 输入 "Select Color Theme"
4. 在主题列表中找到带 🎨 图标的自定义主题
5. 选择该主题

## 注意事项

- 主题名称必须唯一，用于在设置中标识主题
- 颜色值使用标准 CSS 颜色格式（如 `#ffffff`、`rgb(255, 255, 255)` 等）
- 修改配置后需要重新加载窗口或重启 VSCode 才能生效
- 如果配置了多个同名主题，只有第一个会被使用
