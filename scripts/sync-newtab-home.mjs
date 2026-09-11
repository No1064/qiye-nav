import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(root, "extension");
const targetDir = resolve(root, "services/ingest/public/home");
const checkOnly = process.argv.includes("--check");
const files = new Map([
  ["newtab.html", "index.html"],
  ["newtab.css", "newtab.css"],
  ["newtab-theme.js", "newtab-theme.js"],
  ["newtab-runtime.js", "newtab-runtime.js"],
  ["shared.js", "shared.js"],
  ["newtab-core.js", "newtab-core.js"],
  ["newtab.js", "newtab.js"],
  ["assets/brand-mark.svg", "assets/brand-mark.svg"],
  ["assets/favicon.svg", "assets/favicon.svg"],
  ["assets/icon-16.png", "assets/icon-16.png"],
  ["assets/icon-32.png", "assets/icon-32.png"],
  ["assets/icon-48.png", "assets/icon-48.png"],
  ["assets/icon-128.png", "assets/icon-128.png"]
]);

await mkdir(targetDir, { recursive: true });
const mismatches = [];
for (const [sourceName, targetName] of files) {
  const source = await readFile(resolve(sourceDir, sourceName));
  const targetPath = resolve(targetDir, targetName);
  if (checkOnly) {
    let target = Buffer.alloc(0);
    try { target = await readFile(targetPath); } catch (_error) { /* Report as mismatch. */ }
    if (!target.equals(source)) mismatches.push(targetName);
  } else {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
  }
}

if (mismatches.length) {
  console.error(`网页首页不是新标签页的最新同步产物：${mismatches.join("、")}`);
  process.exit(1);
}

console.log(checkOnly
  ? `首页同步校验通过：${files.size} 个文件与新标签页一致`
  : `已从扩展新标签页同步 ${files.size} 个首页文件`);
