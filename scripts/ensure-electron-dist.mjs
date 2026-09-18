// Postinstall: restaura node_modules/electron/dist si pnpm lo borró en este install (hallazgo de N:\saurio-smoke\RESULTADOS-electron.md §7.2).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const electronDir = path.join(rootDir, "node_modules", "electron");
const distExe = path.join(electronDir, "dist", "electron.exe");

if (!existsSync(electronDir)) {
  console.log("[ensure-electron-dist] node_modules/electron no existe todavía (workspace aún no instalado); nada que hacer.");
  process.exit(0);
}

if (existsSync(distExe)) {
  console.log("[ensure-electron-dist] node_modules/electron/dist/electron.exe ya presente.");
  process.exit(0);
}

console.log("[ensure-electron-dist] falta electron.exe: pnpm borró dist/ en este install, restaurando con install.js...");
const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
  cwd: electronDir,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error("[ensure-electron-dist] install.js de electron terminó con código", result.status);
  process.exit(result.status ?? 1);
}

console.log("[ensure-electron-dist] electron/dist restaurado.");
