import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Supabase names its cookies sb-<project>-auth-token, split into numbered
// parts when large.
const isAuthCookie = (name: string) => name.startsWith("sb-");
const secure = process.env.NODE_ENV === "production";

// Who is asking, read from the session cookie that anonymous sign-in sets in
// the browser. Null for a visitor who has not created a notebook yet, since
// sign-in only happens then. An expired access token is refreshed here and the
// new cookies go out on this response, so no proxy is needed: every request
// that depends on the visitor passes through this function.
export async function getVisitorId(): Promise<string | null> {
  const cookieStore = await cookies();
  // Most visitors only read the demo and never get a session, so without a
  // cookie there is nothing to check.
  if (!cookieStore.getAll().some((c) => isAuthCookie(c.name))) return null;

  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: { secure },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        },
      },
    }
  );
  const { data, error } = await supabase.auth.getClaims();
  // An unreachable auth server is an outage, not a stranger. Reading it as no
  // visitor would tell the owner their own notebook is someone else's.
  if (isAuthRetryableFetchError(error)) throw error;
  if (error || !data) return null;
  return data.claims.sub ?? null;
}

// Safari limits cookies written by page scripts to seven days, and sign-in
// writes the session cookie from the browser. A cookie the server sends is not
// limited, so after a notebook is created the same cookie is sent back from
// here. Without this, a visitor who never stayed an hour, long enough for a
// server-side refresh, would lose their notebooks after a week in Safari.
export async function persistVisitorCookies(): Promise<void> {
  // This reads the request's cookies as updated during the request, so a
  // token refreshed a moment ago is the one sent back. A cookie deleted during
  // the request reads as empty and is left deleted.
  const cookieStore = await cookies();
  for (const { name, value } of cookieStore.getAll()) {
    if (!isAuthCookie(name) || !value) continue;
    cookieStore.set(name, value, {
      path: "/",
      sameSite: "lax",
      secure,
      // The longest lifetime browsers accept. The 30 day cleanup is what
      // actually bounds an account.
      maxAge: 400 * 24 * 60 * 60,
    });
  }
}
