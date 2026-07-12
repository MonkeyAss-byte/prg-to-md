type NodeType =
  | "TextNode"
  | "Section"
  | "ImageNode"
  | "UrlNode"
  | "SvgNode"
  | "LatexNode"
  | "ConnectPoint"
  | "ReferenceBlockNode"
  | "ExtensionEntity";

type RawNode = {
  uuid: string;
  type: NodeType;
  text: string;
  pos: { x: number; y: number } | null;
  raw: Record<string, unknown>;
};

type RawEdge = {
  source: string | null;
  target: string | null;
  text: string;
  targets: string[];
  type: string;
};

const PROJECT_NODE_TYPES = new Set<string>([
  "TextNode",
  "Section",
  "ImageNode",
  "UrlNode",
  "SvgNode",
  "LatexNode",
  "ConnectPoint",
  "ReferenceBlockNode",
  "ExtensionEntity",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
}

function getString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function getPosition(item: Record<string, unknown>): { x: number; y: number } | null {
  const collisionBox = asRecord(item.collisionBox);
  if (!collisionBox) return null;
  const shapes = Array.isArray(collisionBox.shapes) ? collisionBox.shapes : [];
  if (shapes.length === 0) return null;
  const shape0 = asRecord(shapes[0]);
  if (!shape0) return null;
  const location = asRecord(shape0.location);
  if (!location) return null;
  const x = Number(location.x ?? 0);
  const y = Number(location.y ?? 0);
  return { x, y };
}

function resolveRef(root: unknown, path: unknown): unknown {
  if (typeof path !== "string" || !path) return null;
  const normalized = path.startsWith("#") ? path.slice(1) : path;
  const parts = normalized
    .replace(/^\/+/, "")
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return null;
      current = current[idx];
      continue;
    }
    const record = asRecord(current);
    if (!record) return null;
    if (part in record) {
      current = record[part];
      continue;
    }
    const idx = Number(part);
    if (!Number.isInteger(idx) || !(idx in record)) return null;
    current = record[idx];
  }
  return current;
}

function resolveUuid(root: unknown, value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.uuid === "string") return record.uuid;
  if ("source" in record) {
    const source = resolveUuid(root, record.source);
    if (source) return source;
  }
  if ("target" in record) {
    const target = resolveUuid(root, record.target);
    if (target) return target;
  }
  if (typeof record.$ === "string") {
    const ref = resolveRef(root, record.$);
    const resolved = asRecord(ref);
    if (resolved && typeof resolved.uuid === "string") return resolved.uuid;
  }
  return null;
}

function summarizeCustomData(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = JSON.stringify(value);
  if (text.length <= 120) return text;
  return `${text.slice(0, 120)}...`;
}

function extractAll(serializedStageObjects: unknown[]): {
  nodes: Map<string, RawNode>;
  edges: RawEdge[];
} {
  const nodes = new Map<string, RawNode>();
  const edges: RawEdge[] = [];

  for (let i = 0; i < serializedStageObjects.length; i += 1) {
    const item = asRecord(serializedStageObjects[i]);
    if (!item) continue;
    const className = getString(item._);
    if (!PROJECT_NODE_TYPES.has(className)) continue;

    const uuid = getString(item.uuid) || `idx_${i}`;
    let text = "";

    if (className === "TextNode" || className === "Section") {
      text = getString(item.text);
    } else if (className === "UrlNode") {
      text = `🔗 ${getString(item.title)} | ${getString(item.url)}`;
    } else if (className === "ImageNode") {
      const attachmentId = getString(item.attachmentId);
      text = `🖼️ Image ${attachmentId ? `[${attachmentId.slice(0, 8)}...]` : ""}`;
    } else if (className === "LatexNode") {
      text = `$$${getString(item.latexSource)}$$`;
    } else if (className === "ConnectPoint") {
      text = "●";
    } else if (className === "ReferenceBlockNode") {
      text = `📄 ${getString(item.fileName)}`;
    } else if (className === "ExtensionEntity") {
      const extensionId = getString(item.extensionId);
      const typeName = getString(item.typeName);
      const customData = summarizeCustomData(item.customData);
      const head = [extensionId, typeName].filter(Boolean).join(" · ");
      text = head ? `🧩 ${head}` : "🧩 扩展实体";
      if (customData) text += ` | ${customData}`;
    }

    nodes.set(uuid, {
      uuid,
      type: className as NodeType,
      text,
      pos: getPosition(item),
      raw: item,
    });
  }

  for (const stageItem of serializedStageObjects) {
    const item = asRecord(stageItem);
    if (!item) continue;
    const className = getString(item._);

    if (className === "LineEdge" || className === "ArcEdge" || className === "CubicCatmullRomSplineEdge") {
      const assoc = Array.isArray(item.associationList) ? item.associationList : [];
      let source: string | null = assoc.length > 0 ? resolveUuid(serializedStageObjects, assoc[0]) : null;
      let target: string | null = assoc.length > 1 ? resolveUuid(serializedStageObjects, assoc[1]) : null;
      if (!source) source = resolveUuid(serializedStageObjects, item.source);
      if (!target) target = resolveUuid(serializedStageObjects, item.target);
      edges.push({
        source,
        target,
        text: getString(item.text),
        targets: [],
        type: className,
      });
      continue;
    }

    if (className === "MultiTargetUndirectedEdge") {
      const targets: string[] = [];
      const assoc = Array.isArray(item.associationList) ? item.associationList : [];
      for (const a of assoc) {
        const uid = resolveUuid(serializedStageObjects, a);
        if (uid) targets.push(uid);
      }
      if (targets.length === 0) {
        const fallbackTargets = Array.isArray(item.targets) ? item.targets : [];
        for (const a of fallbackTargets) {
          const uid = resolveUuid(serializedStageObjects, a);
          if (uid) targets.push(uid);
        }
      }
      const uniqueTargets = Array.from(new Set(targets));
      edges.push({
        source: uniqueTargets[0] ?? null,
        target: uniqueTargets[0] ?? null,
        text: "",
        targets: uniqueTargets,
        type: className,
      });
    }
  }

  return { nodes, edges };
}

function buildSectionHierarchy(
  serializedStageObjects: unknown[],
): {
  sectionChildren: Map<string, string[]>;
  childToParent: Map<string, string>;
} {
  const sectionChildren = new Map<string, string[]>();
  const childToParent = new Map<string, string>();

  for (const stageItem of serializedStageObjects) {
    const item = asRecord(stageItem);
    if (!item || getString(item._) !== "Section") continue;
    const sectionUuid = getString(item.uuid);
    if (!sectionUuid) continue;
    const childrenRaw = Array.isArray(item.children) ? item.children : [];
    const children: string[] = [];
    for (const child of childrenRaw) {
      const uid = resolveUuid(serializedStageObjects, child);
      if (!uid) continue;
      children.push(uid);
      childToParent.set(uid, sectionUuid);
    }
    sectionChildren.set(sectionUuid, children);
  }

  return { sectionChildren, childToParent };
}

function sortByPosition(nodes: Map<string, RawNode>, uuids: string[]): string[] {
  return [...uuids].sort((a, b) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    if (!na?.pos && !nb?.pos) return 0;
    if (!na?.pos) return 1;
    if (!nb?.pos) return -1;
    if (na.pos.y !== nb.pos.y) return na.pos.y - nb.pos.y;
    return na.pos.x - nb.pos.x;
  });
}

function generateMarkdown(
  title: string,
  nodes: Map<string, RawNode>,
  topLevel: string[],
  sectionChildren: Map<string, string[]>,
  edgeGraph: Map<string, Array<{ target: string; text: string }>>,
  imageDataUriMap: Map<string, string>,
): { markdown: string; imageIds: Set<string> } {
  const usedImageIds = new Set<string>();
  const lines: string[] = [
    "---",
    `title: ${title}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    "tags:",
    "  - 思维导图",
    "  - ProjectGraph",
    `description: ${title} - 自动导出 markdown`,
    "---",
    "",
    `# ${title}`,
    "",
  ];

  const textCount = [...nodes.values()].filter((n) => n.type === "TextNode").length;
  const sectionCount = [...nodes.values()].filter((n) => n.type === "Section").length;
  const edgeCount = [...edgeGraph.values()].reduce((acc, list) => acc + list.length, 0);
  lines.push(`> 📊 **${textCount}** 个文本节点 · **${sectionCount}** 个分组 · **${edgeCount}** 条连线`);
  lines.push("");

  const visited = new Set<string>();

  const renderNode = (uuid: string, depth: number) => {
    if (visited.has(uuid)) return;
    visited.add(uuid);
    const node = nodes.get(uuid);
    if (!node) return;
    const text = node.text.trim();

    if (node.type === "TextNode") {
      if (!text) return;
      const heading = "#".repeat(Math.min(depth + 2, 6));
      lines.push(`${heading} ${text}`);
    } else if (node.type === "Section") {
      const heading = "#".repeat(Math.min(depth + 2, 6));
      lines.push(`${heading} 📁 ${text || "未命名分组"}`);
    } else if (node.type === "UrlNode") {
      const rawUrl = getString(node.raw.url).trim();
      const rawTitle = getString(node.raw.title).trim() || rawUrl || "链接";
      const indent = "  ".repeat(depth);
      lines.push(rawUrl ? `${indent}- 🔗 [${rawTitle}](${rawUrl})` : `${indent}- ${text || "🔗 链接"}`);
    } else if (node.type === "LatexNode" || node.type === "ReferenceBlockNode" || node.type === "ExtensionEntity") {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- ${text}`);
    } else if (node.type === "ImageNode") {
      const indent = "  ".repeat(depth);
      const attachmentId = getString(node.raw.attachmentId);
      const dataUri = imageDataUriMap.get(attachmentId);
      if (dataUri) {
        usedImageIds.add(attachmentId);
        lines.push(`${indent}![图片](${dataUri})`);
      } else {
        lines.push(`${indent}> 🖼️ *(图片附件未找到)*`);
      }
    }

    const children = sectionChildren.get(uuid) ?? [];
    for (const child of children) renderNode(child, depth + 1);

    const outgoing = edgeGraph.get(uuid) ?? [];
    let count = 0;
    for (const edge of outgoing) {
      if (visited.has(edge.target)) continue;
      if (edge.text) {
        const indent = "  ".repeat(Math.max(0, depth));
        lines.push(`${indent}> 💬 *${edge.text}*`);
      }
      renderNode(edge.target, depth + 1);
      count += 1;
      if (count >= 8) break;
    }
  };

  for (const uuid of topLevel) {
    renderNode(uuid, 0);
    lines.push("");
  }

  const leftovers = sortByPosition(
    nodes,
    [...nodes.keys()].filter((uuid) => !visited.has(uuid) && (nodes.get(uuid)?.type === "TextNode")),
  );
  if (leftovers.length > 0) {
    lines.push("---");
    lines.push("## 📌 其他概念");
    lines.push("");
    for (const uuid of leftovers) {
      const node = nodes.get(uuid);
      if (node?.text.trim()) lines.push(`- ${node.text.trim()}`);
    }
  }

  return { markdown: lines.join("\n"), imageIds: usedImageIds };
}

async function exportCurrentProjectAsMarkdownToClipboard(): Promise<void> {
  const project = await prg.tabs_getCurrentProject();
  if (!project) throw new Error("当前没有打开的项目标签页");

  // 1. 获取 .prg 文件路径
  const uri: any = await project.uri;
  let prgPath = "";
  if (typeof uri === "string") prgPath = uri;
  else { prgPath = await uri.fsPath; if (!prgPath) prgPath = await uri.path; }
  if (!prgPath) throw new Error("无法获取文件路径");

  // 2. 通过 shell_execute + Python 提取图片（base64 二进制可靠，避免 PS 编码问题）
  const imageDataUriMap = new Map<string, string>();
  try {
    const py = `
import zipfile,base64,json,re,sys
m={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp','gif':'image/gif','bmp':'image/bmp','svg':'image/svg+xml'}
r={}
with zipfile.ZipFile(sys.argv[1]) as z:
 for n in z.namelist():
  if n.startswith('attachments/'):
   a=re.match(r'attachments/([a-f0-9-]+)\\.(\\w+)$',n)
   if a: r[a.group(1)]=f'data:{m.get(a.group(2),"")};base64,{base64.b64encode(z.read(n)).decode()}'
print(json.dumps(r))`.trim();
    const { code: pyCode, stdout: pyOut } = await prg.shell_execute("python", ["-c", py, prgPath]);
    if (pyCode === 0 && pyOut.trim()) {
      const map = JSON.parse(pyOut);
      for (const [k, v] of Object.entries(map)) imageDataUriMap.set(k, v as string);
    }
  } catch {}

  // 3. 通过 PowerShell 读 .prg 文件 → JSZip → 解析 stage.msgpack
  const psScript = `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${prgPath.replace(/'/g, "''")}'))`;
  const { code, stdout } = await prg.shell_execute("powershell", ["-Command", psScript]);
  if (code !== 0 || !stdout) throw new Error("读取文件失败");
  const binaryStr = atob(stdout.replace(/\s/g, ""));
  const fileBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) fileBytes[i] = binaryStr.charCodeAt(i);

  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fileBytes);

  // 3. 解析 stage.msgpack
  const stageEntry = zip.file("stage.msgpack");
  if (!stageEntry) throw new Error("stage.msgpack not found");
  const stageRaw = await stageEntry.async("uint8array");
  // 动态 import msgpack
  const { decode } = await import("@msgpack/msgpack");
  const stageData: any = decode(stageRaw);

  // 4. 处理 dict 格式：{ stageObjects: [...] } 或 { objects: [...] }
  let serializedStageObjects: any[];
  if (Array.isArray(stageData)) {
    serializedStageObjects = stageData;
  } else if (stageData && typeof stageData === "object") {
    serializedStageObjects = stageData.stageObjects || stageData.objects || [];
  } else {
    serializedStageObjects = [];
  }

  const { nodes, edges } = extractAll(serializedStageObjects);
  const { sectionChildren, childToParent } = buildSectionHierarchy(serializedStageObjects);

  const edgeGraph = new Map<string, Array<{ target: string; text: string }>>();
  const pushEdge = (source: string, target: string, text: string) => {
    const arr = edgeGraph.get(source) ?? [];
    arr.push({ target, text });
    edgeGraph.set(source, arr);
  };
  for (const edge of edges) {
    if (edge.source && edge.target) pushEdge(edge.source, edge.target, edge.text);
    if (edge.type === "MultiTargetUndirectedEdge") {
      for (let i = 0; i < edge.targets.length; i += 1) {
        for (let j = 0; j < edge.targets.length; j += 1) {
          if (i === j) continue;
          pushEdge(edge.targets[i], edge.targets[j], "");
        }
      }
    }
  }

  const topLevel = sortByPosition(
    nodes,
    [...nodes.keys()].filter((uuid) => !childToParent.has(uuid)),
  );

  const title = getString(await project.title) || "Untitled";
  const { markdown, imageIds } = generateMarkdown(title, nodes, topLevel, sectionChildren, edgeGraph, imageDataUriMap);

  let finalMarkdown = markdown;
  if (imageDataUriMap.size > imageIds.size) {
    finalMarkdown += "\n\n---\n## 📎 附件图片\n\n";
    for (const [uuid, dataUri] of imageDataUriMap) {
      if (!imageIds.has(uuid)) {
        finalMarkdown += `![附件](${dataUri})\n\n`;
      }
    }
  }

  await prg.dialog_copy("已复制 markdown", "可直接粘贴到你的文档中", finalMarkdown);
  await prg.toast_success("已生成并复制当前 .prg 的 markdown");
}

// ── 注册快捷键 ──

await prg.keybinds_register(
  "prgToMarkdownClipboard",
  { $lucide: "FileText" },
  "m d s",
  Comlink.proxy(async () => {
    try {
      await exportCurrentProjectAsMarkdownToClipboard();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prg.toast_error("导出失败：" + msg);
    }
  }),
);
