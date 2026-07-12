import JSZip from "jszip";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "out");

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
// 文件名必须与扩展 ID 完全一致，否则 Project Graph 会弹出"名称不一致"警告
const fileName = `${pkg.name}.prg`;
const outputPath = join(OUT, fileName);

const entries = await readdir(DIST, { withFileTypes: true });
const zip = new JSZip();

for (const entry of entries) {
  if (!entry.isFile()) continue;
  const fullPath = join(DIST, entry.name);
  const data = await readFile(fullPath);
  zip.file(entry.name, data);
}

const content = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
await mkdir(OUT, { recursive: true });
await writeFile(outputPath, content);

console.log("Package created:", outputPath);

