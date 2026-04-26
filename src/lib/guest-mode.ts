import { clearGuestTodos } from "./todos/local-repository";

const FLAG_KEY = "todo-pwa:guest:enabled";

export function isGuestMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(FLAG_KEY) === "1";
}

export function enterGuestMode(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FLAG_KEY, "1");
}

export function exitGuestMode(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(FLAG_KEY);
  clearGuestTodos();
}
