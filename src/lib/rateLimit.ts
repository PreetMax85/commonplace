import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "./supabase";

// Per-IP and site-wide request limits, counted in Postgres by hit_rate_limits
// (migration 0005). The site-wide numbers are sized to the Groq free tier:
// 200k tokens a day at roughly 3k per answer and 5k per roadmap, so 40 answers
// and 8 roadmaps leave headroom for testing. The per-minute bucket is shared by
// both routes because they draw on the same 8k tokens a minute.

type Scope = "ip" | "site";
// weight is how many slots one request takes. The counter has no notion of
// cost, so a weighted rule is simply sent that many times.
type Rule = { name: string; scope: Scope; windowSeconds: number; limit: number; weight?: number };

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

const GROQ_PER_MINUTE: Rule = { name: "groq:minute", scope: "site", windowSeconds: MINUTE, limit: 2 };

const RULES = {
  query: [
    { name: "query:10min", scope: "ip", windowSeconds: 10 * MINUTE, limit: 4 },
    { name: "query:day", scope: "ip", windowSeconds: DAY, limit: 15 },
    { name: "query:day", scope: "site", windowSeconds: DAY, limit: 40 },
    GROQ_PER_MINUTE,
  ],
  roadmap: [
    { name: "roadmap:day", scope: "ip", windowSeconds: DAY, limit: 2 },
    { name: "roadmap:day", scope: "site", windowSeconds: DAY, limit: 8 },
    // A roadmap spends about as many tokens as two answers.
    { ...GROQ_PER_MINUTE, weight: 2 },
  ],
  notebook: [
    { name: "notebook:day", scope: "ip", windowSeconds: DAY, limit: 2 },
    { name: "notebook:day", scope: "site", windowSeconds: DAY, limit: 20 },
  ],
  source: [
    { name: "source:day", scope: "ip", windowSeconds: DAY, limit: 8 },
    { name: "source:day", scope: "site", windowSeconds: DAY, limit: 40 },
  ],
  // Checked on top of the source limits, because a YouTube source that falls
  // back to the transcript service spends one of 100 free credits a month.
  youtube: [
    { name: "youtube:day", scope: "ip", windowSeconds: DAY, limit: 2 },
    { name: "youtube:day", scope: "site", windowSeconds: DAY, limit: 3 },
  ],
} satisfies Record<string, Rule[]>;

export type RateLimitedAction = keyof typeof RULES;

const ACTION_LABELS: Record<RateLimitedAction, string> = {
  query: "questions",
  roadmap: "roadmaps",
  notebook: "new notebooks",
  source: "adding or re-indexing sources",
  youtube: "adding YouTube videos",
};

// One IPv6 subscriber is normally handed a whole /64, so counting full
// addresses would give each visitor billions of separate allowances.
function networkOf(ip: string): string {
  if (!ip.includes(":")) return ip;
  const mappedV4 = ip.match(/(\d{1,3}\.){3}\d{1,3}$/);
  if (mappedV4) return mappedV4[0];
  const [head, tail] = ip.split("%")[0].split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

// Vercel sets x-forwarded-for itself and drops any value the client sent, so
// the first entry is the real client address. Only a hash is stored.
function clientKey(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(networkOf(ip)).digest("hex").slice(0, 24);
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 90 * MINUTE) return `${Math.ceil(seconds / MINUTE)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

// Returns a 429 response when the request is over a limit, or null to proceed.
// A failure to reach the counter lets the request through: a brief Supabase
// timeout should not take the whole demo down with it.
export async function enforceRateLimit(
  req: Request,
  action: RateLimitedAction
): Promise<NextResponse | null> {
  const rules: Rule[] = (RULES[action] as Rule[]).flatMap((r) => Array(r.weight ?? 1).fill(r));
  const client = clientKey(req);
  const keys = rules.map((r) => (r.scope === "ip" ? `${r.name}:ip:${client}` : `${r.name}:site`));

  const { data, error } = await supabaseAdmin.rpc("hit_rate_limits", {
    p_keys: keys,
    p_windows: rules.map((r) => r.windowSeconds),
    p_limits: rules.map((r) => r.limit),
  });
  const result = Array.isArray(data) ? data[0] : data;
  if (error || !result) {
    console.error(`Rate limit check failed for ${action}, allowing request:`, error);
    return null;
  }
  if (result.allowed) return null;

  const retryAfter = Math.max(1, result.retry_after ?? 60);
  const blockedKey = typeof result.blocked_key === "string" ? result.blocked_key : "";
  const wait = formatWait(retryAfter);
  const message = !blockedKey.endsWith(":site")
    ? `You have reached the limit for ${ACTION_LABELS[action]}. Try again in ${wait}.`
    : blockedKey.includes(":day:")
      ? `The demo has used today's shared allowance for ${ACTION_LABELS[action]}. It resets in ${wait}.`
      : `The demo is busy right now. Try again in ${wait}.`;

  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}
