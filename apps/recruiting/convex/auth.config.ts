import type { AuthConfig } from "convex/server";
import { demoAudience, demoIssuer } from "../shared/contract";

const providers: AuthConfig["providers"] = [];

function optionalEnv(name: string) {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

const clerkIssuer = optionalEnv("CLERK_JWT_ISSUER_DOMAIN");
const demoJwks = optionalEnv("DOMINO_DEMO_JWKS");

if (clerkIssuer) providers.push({ domain: clerkIssuer, applicationID: "convex" });
if (demoJwks) {
  providers.push({
    type: "customJwt",
    issuer: demoIssuer,
    applicationID: demoAudience,
    algorithm: "RS256",
    jwks: demoJwks,
  });
}

export default { providers } satisfies AuthConfig;
