import { NextResponse } from "next/server";
import { getRoutes } from "@/lib/static-data";
export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json(await getRoutes(), { headers: { "Cache-Control": "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400" } }); }
