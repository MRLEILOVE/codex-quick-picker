# Codex Quick Picker

Codex 快捷选择器是一个 CodexPlusPlus 扩展，在 Codex 桌面端提供 MCP 和 Skill 两个入口。

| 入口 | 快捷符 | 默认插入 |
| --- | --- | --- |
| MCP | `#` | 实际 MCP 服务名 |
| Skill | `~` | `$技能名` |

也可以点击输入框旁的 **MCP** 或 **Skill** 按钮。两种列表均支持搜索、别名、分组、拖拽排序、置顶、最近使用和自定义插入模板。选择结果会写到草稿光标处。

## 安装

需要 CodexPlusPlus 2.8.0 或更新版本。

- **社区安装**：在 CodexPlusPlus 管理器打开「拓展 → 社区拓展」，搜索「Codex 快捷选择器」并安装。
- **手动安装**：在 [GitHub Releases](https://github.com/MRLEILOVE/codex-quick-picker/releases) 下载 `mcp-picker-v2.0.0.zip`，解压到本地拓展目录。Windows 上使用 `%APPDATA%\Codex++\user_scripts\mcp-picker\`，确保 `codexpp.json` 直接位于该目录。

安装或更新后，请退出 Codex，再通过 CodexPlusPlus 重新启动，使 Esc 预加载脚本生效。

## 插入模板

在选择器中点击 **插入模板**，可以预览并保存多行文本。MCP 模板使用 `{{mcp}}`，Skill 模板使用 `{{skill}}`。两者都支持 `{{alias}}`，未设置别名时会使用实际名称。

MCP 和 Skill 各自保存别名、分组、顺序、最近使用记录和模板。
