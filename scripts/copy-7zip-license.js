#!/usr/bin/env node

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, "public", "7zip-license.txt");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(join(root, "assets", "7ZIP_LICENSE.txt"), destination);
console.log(`[licenses:7zip] Wrote ${destination}`);
