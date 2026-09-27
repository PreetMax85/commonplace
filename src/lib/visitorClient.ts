import { createBrowserClient } from "@supabase/ssr";
import { isAuthSessionMissingError } from "@supabase/supabase-js";

let client: ReturnType<typeof createBrowserClient> | undefined;

// Background refreshing is off: the server refreshes the token on each
// request, and two refreshers would keep rotating the same token.
function browserClient() {
  client ??= createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { autoRefreshToken: false },
      cookieOptions: { secure: window.location.protocol === "https:" },
    }
  );
  return client;
}

// Auth error codes meaning this browser's account or session no longer exists,
// for example after the 30 day cleanup removed it.
const GONE_CODES = [
  "user_not_found",
  "session_not_found",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "bad_jwt",
];

// Makes sure the browser holds a session before it creates anything. Called
// only when a notebook is created, so reading the demo never makes an account.
//
// getUser asks the auth server rather than trusting the cookie, because a
// visitor removed by the 30 day cleanup still has a cookie that looks valid.
export async function ensureVisitor(): Promise<void> {
  const client = browserClient();
  const { data, error } = await client.auth.getUser();
  if (data.user) return;
  // Starting over signs out, which deletes the cookie, and an anonymous
  // account cannot be recovered without it. So a dropped connection, a
  // server error or a rate limit must never be read as "no account": only a
  // missing session or an answer that the account is gone gets it replaced.
  const gone =
    !error ||
    isAuthSessionMissingError(error) ||
    [401, 403, 404].includes(error.status ?? 0) ||
    GONE_CODES.includes(error.code ?? "");
  if (!gone) throw error;
  await client.auth.signOut({ scope: "local" });
  const { error: signInError } = await client.auth.signInAnonymously();
  if (signInError) throw signInError;
}

// Sends a file straight to Storage with a one-time link from /uploads, since
// Vercel refuses request bodies over 4.5 MB. The link is the permission, so
// this works with the public key and no Storage policies. The type is set
// here because browsers often report none for .vtt and .srt, and the bucket
// accepts only the types it lists.
export async function uploadFile(path: string, token: string, file: File, contentType: string): Promise<void> {
  const { error } = await browserClient().storage.from("sources").uploadToSignedUrl(path, token, file, { contentType });
  if (error) throw error;
}
