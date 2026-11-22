import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { demoAudience, demoIdentity, demoIssuer } from "../shared/contract";
import { localDeploymentUrl, runConvex } from "./local-deployment";

localDeploymentUrl();
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "domino-local";
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwksUri = "data:text/plain;charset=utf-8;base64," + Buffer.from(JSON.stringify({ keys: [jwk] })).toString("base64");
runConvex("env", "set", "DOMINO_DEMO_JWKS", jwksUri);
runConvex("run", "demo:seed", JSON.stringify({ reset: false }));

function token(sub: string) {
  const iat = Math.floor(Date.now() / 1000);
  const body = [
    encode({ kid, alg: "RS256", typ: "JWT" }),
    encode({ iss: demoIssuer, aud: demoAudience, sub, iat, exp: iat + 8 * 3600 }),
  ].join(".");
  return body + "." + sign("sha256", Buffer.from(body), privateKey).toString("base64url");
}

const tokens = [
  ["DOMINO_DEMO_CANDIDATE_TOKEN", demoIdentity.candidate],
  ["DOMINO_DEMO_RECRUITER_TOKEN", demoIdentity.recruiter],
  ["DOMINO_DEMO_OTHER_RECRUITER_TOKEN", demoIdentity.otherRecruiter],
  ["DOMINO_DEMO_MERIDIAN_TOKEN", "domino-meridian-recruiter"],
];
writeFileSync(".env.demo", tokens.map(([name, subject]) => `${name}=${token(subject)}`).join("\n") + "\n", { mode: 0o600 });
console.log("Seeded the local fixture and saved eight-hour demo tokens in .env.demo.");
