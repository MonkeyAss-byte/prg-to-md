# PRG to Markdown (with Pic)

将当前打开的 `.prg` 工程文件导出为 Markdown（含内嵌图片），一键复制到剪贴板。

## 功能

- 解析所有节点：TextNode、Section、ImageNode、UrlNode、LatexNode、ExtensionEntity 等
- 递归提取边内嵌节点和层级关系
- 解析所有连线：LineEdge、ArcEdge、CubicCatmullRomSplineEdge、MultiTargetUndirectedEdge
- 包含关系用 `#` 标题层级，边连接用 `-` 缩进列表
- 图片内嵌为 base64 引用
- 零外部依赖（PowerShell 读文件 + JS 解析）

## 使用方式

1. 安装扩展，**重启 Project Graph**
2. 打开 `.prg` 工程，依次按 **`m` → `n` → `f`**
3. Markdown 自动复制到剪贴板

## 开发

```bash
npm install
npm run build          # 构建
npm run install:ext    # 安装到本地 Project Graph
npm run package        # 打包为 .prg
```

产物：`out/com.monkeyass-byte.prg-to-md-with-pic.prg`
