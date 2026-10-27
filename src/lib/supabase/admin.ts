import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Service-role client: bypasses RLS. Only for server code that has already established
// which workspace it is acting on (collector, alert engine, credential store).

export type AdminClient = SupabaseClient<Database>;

let cached: AdminClient | null = null;

export function adminClient(): AdminClient {
  if (typeof window !== "undefined") throw new Error("adminClient() must never run in the browser");
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  cached = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
