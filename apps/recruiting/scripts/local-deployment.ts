import { spawnSync } from "node:child_process";

export function localDeploymentUrl() {
  const configured = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!configured) throw new Error("Start the local Convex deployment first.");
  const url = new URL(configured);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Demo setup and acceptance tests require a loopback Convex deployment.");
  }
  return url.origin;
}

export function runConvex(...args: string[]) {
  localDeploymentUrl();
  const deployment = process.env.CONVEX_DEPLOYMENT;
  if (!deployment?.startsWith("anonymous:") && !deployment?.startsWith("local:")) {
    throw new Error("Select the local Convex deployment before running this command.");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
  delete env.CONVEX_DEPLOY_KEY;
  const result = spawnSync("node_modules/.bin/convex", args, {
    env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || "Convex command failed.");
  }
  return result.stdout;
}
