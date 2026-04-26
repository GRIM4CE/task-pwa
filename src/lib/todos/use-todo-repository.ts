"use client";

import { useState } from "react";
import { isGuestMode } from "@/lib/guest-mode";
import { apiTodoRepository } from "./api-repository";
import { localTodoRepository } from "./local-repository";
import type { TodoRepository } from "./repository";

// The authenticated layout gates rendering behind a client-side auth check,
// so this hook only ever runs in the browser — safe to read localStorage
// during the initializer.
export function useTodoRepository(): TodoRepository {
  const [repo] = useState<TodoRepository>(() =>
    isGuestMode() ? localTodoRepository : apiTodoRepository
  );
  return repo;
}
