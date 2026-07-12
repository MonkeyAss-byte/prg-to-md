import JSZip from "jszip";
import { decode as msgpackDecode } from "@msgpack/msgpack";

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB chunks
  let result = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(result);
}

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

function extractTextFromAssociation(obj: unknown): string {
  const record = asRecord(obj);
  if (!record) return "";
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  if (typeof record.details === "string" && record.details.trim()) return record.details.trim();
  if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
  if (typeof record.title === "string" && record.title.trim()) return record.title.trim();
  if (typeof record.description === "string" && record.description.trim()) return record.description.trim();
  return "";
}

function collectNestedNodes(
  root: unknown[],
  existingNodes: Map<string, RawNode>,
): void {
  const seen = new Set<unknown>();

  function walk(obj: unknown): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj !== "object") return;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }

    const record = obj as Record<string, unknown>;
    const className = getString(record._);
    if (PROJECT_NODE_TYPES.has(className)) {
      const uuid = getString(record.uuid);
      if (uuid && !existingNodes.has(uuid)) {
        let text = "";
        if (className === "TextNode" || className === "Section") {
          text = getString(record.text);
        } else if (className === "UrlNode") {
          text = "🔗 " + getString(record.title) + " | " + getString(record.url);
        } else if (className === "ImageNode") {
          const aId = getString(record.attachmentId);
          text = "🖼️ Image " + (aId ? "[" + aId.slice(0, 8) + "...]" : "");
        } else if (className === "LatexNode") {
          text = "$$" + getString(record.latexSource) + "$$";
        } else if (className === "ConnectPoint") {
          text = "●";
        } else if (className === "ReferenceBlockNode") {
          text = "📄 " + getString(record.fileName);
        } else if (className === "ExtensionEntity") {
          const extId = getString(record.extensionId);
          const tn = getString(record.typeName);
          const cd = summarizeCustomData(record.customData);
          const h = [extId, tn].filter(Boolean).join(" · ");
          text = h ? "🧩 " + h : "🧩 扩展实体";
          if (cd) text += " | " + cd;
        }
        existingNodes.set(uuid, {
          uuid,
          type: className as NodeType,
          text,
          pos: getPosition(record),
          raw: record,
        });
      }
    }

    // Recurse into children, associationList, and any array
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (Array.isArray(val)) {
        for (const item of val) walk(item);
      } else if (typeof val === "object" && val !== null) {
        walk(val);
      }
    }
  }

  for (const item of root) walk(item);
}

function collectNestedSectionHierarchy(
  root: unknown[],
  sectionChildren: Map<string, string[]>,
  childToParent: Map<string, string>,
): void {
  const seen = new Set<unknown>();

  function walk(obj: unknown): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj !== "object") return;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }

    const record = obj as Record<string, unknown>;
    if (getString(record._) === "Section") {
      const sectionUuid = getString(record.uuid);
      const childrenRaw = Array.isArray(record.children) ? record.children : [];
      if (sectionUuid && childrenRaw.length > 0 && !sectionChildren.has(sectionUuid)) {
        const children: string[] = [];
        for (const child of childrenRaw) {
          const uid = resolveRef(root, (child as Record<string, unknown>)?.$) || resolveUuid(root, child);
          if (uid) {
            children.push(uid);
            if (!childToParent.has(uid)) childToParent.set(uid, sectionUuid);
          }
        }
        sectionChildren.set(sectionUuid, children);
      }
    }

    // Recurse
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (Array.isArray(val)) {
        for (const item of val) walk(item);
      } else if (typeof val === "object" && val !== null) {
        walk(val);
      }
    }
  }

  for (const item of root) walk(item);
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

      // 从 edge.text 和 associationList 嵌套对象中提取文本
      let edgeText = getString(item.text);
      const assocTexts: string[] = [];
      for (let ai = 0; ai < assoc.length; ai += 1) {
        const t = extractTextFromAssociation(assoc[ai]);
        if (t) assocTexts.push(t);
      }
      if (!edgeText && assocTexts.length > 0) {
        edgeText = assocTexts.join(" · ");
      } else if (edgeText && assocTexts.length > 0) {
        edgeText = edgeText + " · " + assocTexts.join(" · ");
      }

      edges.push({
        source,
        target,
        text: edgeText,
        targets: [],
        type: className,
      });
      continue;
    }

    if (className === "MultiTargetUndirectedEdge") {
      const targets: string[] = [];
      const assoc = Array.isArray(item.associationList) ? item.associationList : [];
      const assocTexts: string[] = [];
      for (const a of assoc) {
        const uid = resolveUuid(serializedStageObjects, a);
        if (uid) { targets.push(uid); }
        else {
          const t = extractTextFromAssociation(a);
          if (t) assocTexts.push(t);
        }
      }
      if (targets.length === 0) {
        const fallbackTargets = Array.isArray(item.targets) ? item.targets : [];
        for (const a of fallbackTargets) {
          const uid = resolveUuid(serializedStageObjects, a);
          if (uid) targets.push(uid);
        }
      }
      const uniqueTargets = Array.from(new Set(targets));
      let edgeText = getString(item.text);
      if (!edgeText && assocTexts.length > 0) {
        edgeText = assocTexts.join(" · ");
      } else if (edgeText && assocTexts.length > 0) {
        edgeText = edgeText + " · " + assocTexts.join(" · ");
      }
      edges.push({
        source: uniqueTargets[0] ?? null,
        target: uniqueTargets[0] ?? null,
        text: edgeText,
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
): { markdown: string; imageRefs: Map<string, string>; missedCount: number } {
  const imageRefs = new Map<string, string>();
  let refIndex = 0;
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

  function writeImageNode(node: RawNode, indent: string): boolean {
    const attachmentId = getString(node.raw.attachmentId);
    const dataUri = imageDataUriMap.get(attachmentId);
    if (dataUri) {
      const refKey = "img-" + (++refIndex);
      imageRefs.set(refKey, dataUri);
      lines.push(`${indent}- ![图片][${refKey}]`);
      return true;
    }
    lines.push(`${indent}- 🖼️ *(图片附件未找到)*`);
    return false;
  }

  function writeNodeContent(uuid: string, indent: string, asHeading: boolean, depth: number): void {
    if (visited.has(uuid)) return;
    visited.add(uuid);
    const node = nodes.get(uuid);
    if (!node) return;
    const text = node.text.trim();

    if (asHeading) {
      if (node.type === "TextNode") {
        const heading = "#".repeat(Math.min(depth + 2, 6));
        lines.push(`${heading} ${text || "(无文本)"}`);
      } else if (node.type === "Section") {
        const heading = "#".repeat(Math.min(depth + 2, 6));
        lines.push(`${heading} 📁 ${text || "未命名分组"}`);
      } else if (node.type === "ImageNode") {
        writeImageNode(node, indent);
      } else {
        lines.push(`${indent}- ${text || node.type}`);
      }
    } else {
      // 列表模式：边的目标节点用缩进列表
      if (node.type === "TextNode") {
        lines.push(`${indent}- ${text || "(无文本)"}`);
      } else if (node.type === "Section") {
        lines.push(`${indent}- **${text || "未命名分组"}**`);
      } else if (node.type === "ImageNode") {
        writeImageNode(node, indent);
      } else {
        lines.push(`${indent}- ${text || node.type}`);
      }
    }

    // 1. 先渲染 Section 包含的子节点
    const children = sectionChildren.get(uuid) ?? [];
    const childIndent = asHeading ? "  ".repeat(depth + 1) : indent + "  ";
    for (const child of children) {
      writeNodeContent(child, childIndent, asHeading, depth + 1);
    }

    // 2. 再渲染边连接节点（用列表模式，不带 # 标题）
    const outgoing = edgeGraph.get(uuid) ?? [];
    const sortedOut = sortByPosition(nodes, outgoing.map(e => e.target));
    for (const targetId of sortedOut) {
      if (visited.has(targetId)) continue;
      const edge = outgoing.find(e => e.target === targetId);
      const edgeText = edge?.text?.trim() ?? "";
      const targetNode = nodes.get(targetId);
      const targetText = targetNode?.text?.trim() ?? "";

      // 边标签与目标节点同名 → 不重复显示边标签
      if (edgeText && edgeText !== targetText) {
        lines.push(`${indent}  > 💬 *${edgeText}*`);
      }
      writeNodeContent(targetId, indent + "  ", false, depth + 1);
    }
  }

  // 渲染顶层节点（使用 # 标题模式）
  for (const uuid of topLevel) {
    if (nodes.get(uuid)?.type === "Section") { writeNodeContent(uuid, "", true, 0); lines.push(""); }
  }
  for (const uuid of topLevel) {
    if (nodes.get(uuid)?.type !== "Section") { writeNodeContent(uuid, "", true, 0); lines.push(""); }
  }

  const leftovers = sortByPosition(
    nodes,
    [...nodes.keys()].filter((uuid) => !visited.has(uuid)),
  );

  if (leftovers.length > 0) {
    lines.push("---");
    lines.push("## 📌 未归类节点");
    lines.push("");
    for (const uuid of leftovers) {
      const node = nodes.get(uuid);
      if (!node) continue;
      if (node.type === "ImageNode") writeImageNode(node, "");
      else {
        const display = node.text.trim() || "(无文本)";
        const prefix = node.type === "Section" ? "📁 " : "";
        lines.push(`- ${prefix}${display}`);
      }
    }
  }

  return { markdown: lines.join("\n"), imageRefs, missedCount: leftovers.length };
}

async function exportCurrentProjectAsMarkdownToClipboard(): Promise<void> {
  await prg.toast("⏳ 正在准备导出...");
  const project = await prg.tabs_getCurrentProject();
  if (!project) throw new Error("当前没有打开的项目标签页");

  // 1. 获取 .prg 文件路径
  const uri: any = await project.uri;
  let prgPath = "";
  if (typeof uri === "string") prgPath = uri;
  else { prgPath = await uri.fsPath; if (!prgPath) prgPath = await uri.path; }
  if (!prgPath) throw new Error("无法获取文件路径");

  // 2. PowerShell 读取 .prg 为 base64，JS 侧解析 ZIP + msgpack
  await prg.toast("⏳ 正在解析项目文件...");
  const imageDataUriMap = new Map<string, string>();

  const psCmd = `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${prgPath.replace(/'/g, "''")}'))`;
  const { code, stdout } = await prg.shell_execute("powershell", ["-NoProfile", "-Command", psCmd]);
  if (code !== 0 || !stdout) throw new Error("读取项目文件失败");

  // 解码 base64 → ZIP → msgpack
  const zipData = Uint8Array.from(atob(stdout.trim()), (c) => c.charCodeAt(0));
  const zip = await JSZip.loadAsync(zipData);

  const stageFile = zip.file("stage.msgpack");
  if (!stageFile) throw new Error("stage.msgpack 未找到");
  const stageBytes = await stageFile.async("uint8array");
  const stageData: any = msgpackDecode(stageBytes);

  // 提取附件图片
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", tiff: "image/tiff",
    ico: "image/x-icon", jfif: "image/jpeg",
  };
  const attachRe = /^attachments\/([a-f0-9-]+)\.(\w+)$/i;
  for (const [name, file] of Object.entries(zip.files)) {
    const m = name.match(attachRe);
    if (!m) continue;
    const ext = m[2].toLowerCase();
    const mime = mimeMap[ext] || "image/png";
    const bytes = await file.async("uint8array");
    const b64 = uint8ToBase64(bytes);
    imageDataUriMap.set(m[1], `data:${mime};base64,${b64}`);
  }

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
  collectNestedNodes(serializedStageObjects, nodes);
  collectNestedSectionHierarchy(serializedStageObjects, sectionChildren, childToParent);

  await prg.toast(`⏳ 已提取 ${nodes.size} 个节点 · ${edges.length} 条连线，正在排版...`);
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

  // 计算仅通过边可达的节点（不作为顶层，仅通过边渲染）
  const edgeTargetSet = new Set<string>();
  for (const [, targets] of edgeGraph) {
    for (const t of targets) edgeTargetSet.add(t.target);
  }
  // edgeOnly: 是边的目标 且 不在包含层级中
  const edgeOnlyNodes = new Set<string>();
  for (const uuid of edgeTargetSet) {
    if (!childToParent.has(uuid)) edgeOnlyNodes.add(uuid);
  }

  const topLevel = sortByPosition(
    nodes,
    [...nodes.keys()].filter((uuid) => !childToParent.has(uuid) && !edgeOnlyNodes.has(uuid)),
  );

  const title = getString(await project.title) || "Untitled";
  const { markdown, imageRefs, missedCount } = generateMarkdown(title, nodes, topLevel, sectionChildren, edgeGraph, imageDataUriMap);

  // 追加未引用的附件图片 + 所有引用定义
  let finalMarkdown = markdown;
  let refIndex = imageRefs.size;
  for (const [uuid, dataUri] of imageDataUriMap) {
    if ([...imageRefs.values()].includes(dataUri)) continue;
    refIndex++;
    const refKey = "img-" + refIndex;
    imageRefs.set(refKey, dataUri);
    if (finalMarkdown.indexOf("## 📎 附件图片") === -1) {
      finalMarkdown += "\n\n---\n## 📎 附件图片\n\n";
    }
    finalMarkdown += `![附件][${refKey}]\n\n`;
  }

  // 所有图片引用定义放在最底部
  if (imageRefs.size > 0) {
    finalMarkdown += "\n\n---\n";
    for (const [key, uri] of imageRefs) {
      finalMarkdown += `[${key}]: ${uri}\n`;
    }
  }

  await prg.dialog_copy("导出完成", `节点 ${nodes.size} · 连线 ${edges.length} · 图片 ${imageDataUriMap.size}`, finalMarkdown);
  await prg.toast_success(`✅ 已复制 · ${nodes.size} 节点 · ${edges.length} 连线`);
}

// ── 注册快捷键 ──

await prg.keybinds_register(
  "prgToMarkdownClipboard",
  { $lucide: "FileText" },
  "m n f",
  Comlink.proxy(async () => {
    await prg.toast("⏳ 正在导出 Markdown...");
    try {
      await exportCurrentProjectAsMarkdownToClipboard();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prg.toast_error("导出失败：" + msg);
    }
  }),
);
