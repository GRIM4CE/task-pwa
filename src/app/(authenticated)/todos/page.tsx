import { redirect } from "next/navigation";

export default function TodosIndexPage() {
  redirect("/todos/joined");
}
