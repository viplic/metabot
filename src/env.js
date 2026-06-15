import { promises as fs } from "node:fs";
import path from "node:path";

export async function loadDotEnv(filePath = path.resolve(".env")) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    let loaded = 0;

    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;

      const { key, value } = parsed;
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded += 1;
      }
    }

    return { loaded, filePath };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { loaded: 0, filePath, missing: true };
    }
    throw error;
  }
}

export function parseEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex <= 0) return null;

  const key = withoutExport.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = withoutExport.slice(equalsIndex + 1).trim();
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.at(-1) === quote) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    }
  } else {
    const commentIndex = value.search(/\s#/);
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
  }

  return { key, value };
}
