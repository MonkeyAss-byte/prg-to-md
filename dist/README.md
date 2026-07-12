# PRG Markdown Helper

将当前打开的 `.prg` 工程文件解析为 Markdown 并复制到剪贴板。

## 功能

- 解析所有节点类型：TextNode、Section、ImageNode、UrlNode、LatexNode、ExtensionEntity 等
- 解析所有连线类型：LineEdge、ArcEdge、CubicCatmullRomSplineEdge、MultiTargetUndirectedEdge
- 保留 Section 层级结构和节点位置排序
- 生成带 YAML frontmatter 的完整 Markdown
- 一键复制到剪贴板

## 使用方式

1. 安装扩展，**重启 Project Graph**
2. 打开 `.prg` 工程，依次按 **`m` → `d` → `s`**
3. Markdown 自动复制到剪贴板

## 开发

```bash
npm install
npm run build          # 构建
npm run install:ext    # 安装到本地 Project Graph
npm run package        # 打包为 .prg
```

产物：`out/com.quking.prg-markdown-helper.prg`
