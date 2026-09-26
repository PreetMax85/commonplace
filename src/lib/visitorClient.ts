import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | undefined;

// Makes sure the browser holds a session before it creates anything. Called
// only when a notebook is created, so reading the demo never makes an account.
//
// getUser asks the auth server rather than trusting the cookie, because a
// visitor removed by the 30 day cleanup still has a cookie that looks valid.
// Background refreshing is off: the server refreshes the token on each
// request, and two refreshers would keep rotating the same token.
export async function ensureVisitor(): Promise<void> {
  client ??= createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false } }
  );
  const { data } = await client.auth.getUser();
  if (data.user) return;
  await client.auth.signOut({ scope: "local" });
  const { error } = await client.auth.signInAnonymously();
  if (error) throw error;
}
