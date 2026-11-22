import { fetchQuery } from "convex/nextjs";
import { api } from "../../../convex/_generated/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return Response.json({ ok: false, backend: "unconfigured" }, { status: 503 });
  try {
    return Response.json(await fetchQuery(api.system.health, {}, { url }));
  } catch {
    return Response.json({ ok: false, backend: "unavailable" }, { status: 503 });
  }
}
