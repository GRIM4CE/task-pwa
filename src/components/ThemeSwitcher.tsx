"use client";

import { useEffect, useSyncExternalStore } from "react";

const THEMES = [
  { id: "default", label: "Jon" },
  { id: "juliette", label: "Juliette" },
] as const;

type ThemeId = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "todo-theme";
const CHANGE_EVENT = "todo-theme-change";

function isThemeId(value: string | null): value is ThemeId {
  return !!value && THEMES.some((t) => t.id === value);
}

function readTheme(): ThemeId {
  const saved = localStorage.getItem(STORAGE_KEY);
  return isThemeId(saved) ? saved : "default";
}

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function applyTheme(theme: ThemeId) {
  const root = document.documentElement;
  if (theme === "default") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

function ThemeSwitcherImpl() {
  const theme = useSyncExternalStore(
    subscribe,
    readTheme,
    () => "default" as ThemeId,
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (!isThemeId(next)) return;
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <select
      value={theme}
      onChange={onChange}
      aria-label="Switch theme"
      title="Switch theme (dev only)"
      className="h-9 rounded-lg bg-surface-hover px-2 text-xs font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {THEMES.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

export function ThemeSwitcher() {
  if (process.env.NODE_ENV === "production") return null;
  return <ThemeSwitcherImpl />;
}
