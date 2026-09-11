import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { normalizeCatalog } from "./catalog-schema.js";
import { CatalogStore } from "./catalog-store.js";
import type { DashyCatalog } from "./types.js";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function migrateDashyConfig(value: unknown): DashyCatalog {
  const root = objectValue(value);
  if (!root || !Array.isArray(root.sections)) {
    throw new Error("Dashy source must contain a sections array");
  }
  const pageInfo = objectValue(root.pageInfo) ?? {};
  const appConfig = objectValue(root.appConfig) ?? {};
  const webSearch = objectValue(appConfig.webSearch) ?? {};
  const rawEngine = String(webSearch.searchEngine ?? "duckduckgo").toLowerCase();
  const defaultSearchEngine = ["google", "duckduckgo", "bing"].includes(rawEngine)
    ? rawEngine
    : "duckduckgo";
  return normalizeCatalog(
    {
      schemaVersion: 1,
      settings: {
        title: typeof pageInfo.title === "string" ? pageInfo.title : "栖页",
        subtitle:
          typeof pageInfo.description === "string"
            ? pageInfo.description
            : "常去的网站和家里的服务",
        defaultSearchEngine,
        localAccessHosts: ["127.0.0.1", "localhost", ".local"],
      },
      groups: root.sections.map((sectionValue) => {
        const section = objectValue(sectionValue) ?? {};
        return {
          name: section.name,
          icon: section.icon,
          items: (Array.isArray(section.items) ? section.items : []).map((itemValue) => {
            const item = objectValue(itemValue) ?? {};
            return {
              title: item.title,
              url: item.url,
              localUrl: item.localUrl,
              description: item.description,
              icon: item.icon,
              tags: item.tags,
            };
          }),
        };
      }),
    },
    true,
  );
}

export async function loadCatalogSource(path: string): Promise<DashyCatalog> {
  const text = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return normalizeCatalog(JSON.parse(text), true);
  if ([".yaml", ".yml"].includes(extension)) return migrateDashyConfig(parseYaml(text));
  throw new Error("Migration source must be .json, .yaml, or .yml");
}

async function runCli(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --input and --output arguments");
    values.set(key, value);
  }
  const input = values.get("--input");
  const output = values.get("--output");
  if (!input || !output) throw new Error("Usage: migration.js --input <source> --output <catalog.json> [--backups <dir>]");
  try {
    await stat(output);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const catalog = await loadCatalogSource(input);
  await CatalogStore.initializeFile({
    catalogPath: resolve(output),
    backupDir: resolve(values.get("--backups") ?? `${output}.backups`),
    catalog,
  });
  const itemCount = catalog.groups.reduce((total, group) => total + group.items.length, 0);
  console.info(`Migrated ${catalog.groups.length} groups / ${itemCount} items to ${output}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
