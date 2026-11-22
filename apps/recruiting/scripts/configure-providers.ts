import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConvex } from "./local-deployment";

const names = [
  "CRUSTDATA_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "VERTEX_FLASH_MODEL",
  "VERTEX_NEON_MODEL",
];
const configured = names.flatMap((name) => {
  const value = process.env[name];
  return value ? [[name, value] as const] : [];
});
if (!configured.length) throw new Error("Set provider credentials in the ignored local environment first.");

const directory = mkdtempSync(join(tmpdir(), "domino-providers-"));
try {
  const path = join(directory, "providers.env");
  writeFileSync(path, configured.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n"), { mode: 0o600 });
  runConvex("env", "set", "--force", "--from-file", path);
  console.log("Configured these variables on local Convex:", configured.map(([name]) => name).join(", "));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
