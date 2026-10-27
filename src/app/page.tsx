import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

export default async function Root() {
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  redirect(user ? "/home" : "/login");
}
