import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function Root() {
  const { data } = await auth.getSession();
  redirect(data?.user ? "/home" : "/login");
}
