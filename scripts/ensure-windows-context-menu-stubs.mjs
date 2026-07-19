import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = path.join(root, "src-tauri", "windows", "shell", "out");
mkdirSync(outDir, { recursive: true });
for (const name of ["zinnia_shell.dll", "ZinniaContextMenu.msix"]) {
  const filePath = path.join(outDir, name);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, "");
    console.log(`[ensure-windows-context-menu-stubs] created empty ${filePath}`);
  }
}
