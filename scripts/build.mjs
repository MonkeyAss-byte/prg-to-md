import { build } from "esbuild";
import { encode } from "@msgpack/msgpack";
import { mkdir, readFile, rm, writeFile, access, copyFile } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src", "extension.ts");
const DIST = join(ROOT, "dist");

await access(SRC);
await access(join(ROOT, "package.json"));

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const result = await build({
  entryPoints: [SRC],
  bundle: true,
  minify: true,
  platform: "browser",
  conditions: ["worker"],
  format: "esm",
  write: false,
});

await writeFile(join(DIST, "extension.js"), result.outputFiles[0].text, "utf-8");

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
const metadata = {
  version: "2.0.0",
  extension: {
    id: pkg.name,
    name: pkg.displayName || pkg.name,
    version: pkg.version,
    description: pkg.description || "",
    author: pkg.author || "",
  },
};

await writeFile(join(DIST, "metadata.msgpack"), encode(metadata));

async function tryCopyOptional(relativePath, targetName = relativePath) {
  const source = join(ROOT, relativePath);
  try {
    await access(source);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await copyFile(source, join(DIST, targetName));
  return true;
}

await tryCopyOptional("README.md");

const icon = pkg.icon;
if (icon) {
  const ext = extname(icon).toLowerCase();
  if ([".svg", ".webp", ".png", ".jpg"].includes(ext)) {
    await tryCopyOptional(icon, `icon${ext}`);
  }
}

console.log("Build completed:", DIST);
