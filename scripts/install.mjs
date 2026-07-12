import { access, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

await access(join(DIST, "extension.js"));
await access(join(DIST, "metadata.msgpack"));

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));

// Tauri appDataDir 在 Windows 上为 %APPDATA%/<identifier>
const appDataDir = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "liren.project-graph",
);
const targetDir = join(appDataDir, "extensions", pkg.name);

await mkdir(targetDir, { recursive: true });
await cp(DIST, targetDir, { recursive: true });

console.log(`Extension installed to: ${targetDir}`);
console.log("在 Project Graph 中点击 设置 → 扩展 → 重载扩展 即可激活。");
