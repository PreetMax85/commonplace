import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rateLimit";
import { getVisitorId } from "@/lib/visitor";

export async function GET() {
  const visitorId = await getVisitorId();
  const { data, error } = await supabaseAdmin
    .from("notebooks")
    // sources(count) rides along on the same query, so the list can show how
    // much is in each notebook without a request per row.
    .select("*, sources(count)")
    // The demo plus this visitor's own. visitorId comes from a verified token,
    // so it is a uuid and safe inside the filter string.
    .or(visitorId ? `is_demo.eq.true,owner_id.eq.${visitorId}` : "is_demo.eq.true")
    // The demo leads the list so a first-time visitor opens it before anything else.
    .order("is_demo", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { name } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });

  // The browser signs in before creating, so no session here means sign-in
  // failed or the cookie was blocked.
  const visitorId = await getVisitorId();
  if (!visitorId) {
    return NextResponse.json({ error: "Could not start a private session. Try again." }, { status: 401 });
  }

  // The per-notebook source cap means nothing if notebooks are free to make.
  const limited = await enforceRateLimit(req, "notebook");
  if (limited) return limited;

  const { data, error } = await supabaseAdmin
    .from("notebooks")
    .insert({ name: name.trim(), owner_id: visitorId })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
