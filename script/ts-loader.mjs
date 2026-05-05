import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.cwd();

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@shared/")) {
    const target = path.join(root, "shared", `${specifier.slice("@shared/".length)}.ts`);
    return nextResolve(pathToFileURL(target).href, context);
  }

  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    const target = path.resolve(path.dirname(parentPath), specifier);
    if (!path.extname(target) && existsSync(`${target}.ts`)) {
      return nextResolve(pathToFileURL(`${target}.ts`).href, context);
    }
  }

  return nextResolve(specifier, context);
}
