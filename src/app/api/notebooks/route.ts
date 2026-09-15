import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rateLimit";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("notebooks")
    .select("*")
    // The demo leads the list so a first-time visitor opens it before anything else.
    .order("is_demo", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { name } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });

  // The per-notebook source cap means nothing if notebooks are free to make.
  const limited = await enforceRateLimit(req, "notebook");
  if (limited) return limited;

  const { data, error } = await supabaseAdmin
    .from("notebooks")
    .insert({ name: name.trim() })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
