import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Who is asking, read from the session cookie that anonymous sign-in sets in
// the browser. Null for a visitor who has not created a notebook yet, since
// sign-in only happens then. An expired access token is refreshed here and the
// new cookies go out on this response, so no proxy is needed: every request
// that depends on the visitor passes through this function.
export async function getVisitorId(): Promise<string | null> {
  const cookieStore = await cookies();
  // Most visitors only read the demo and never get a session. Supabase names
  // its cookies sb-<project>-auth-token, so without one there is nothing to check.
  if (!cookieStore.getAll().some((c) => c.name.startsWith("sb-"))) return null;
  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        },
      },
    }
  );
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  return data.claims.sub ?? null;
}
