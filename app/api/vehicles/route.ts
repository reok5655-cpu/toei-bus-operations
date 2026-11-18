import { NextResponse } from "next/server";
import { getFeedStatus } from "@/lib/odpt";
export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json(await getFeedStatus(), { headers: { "Cache-Control": "no-store" } }); }
