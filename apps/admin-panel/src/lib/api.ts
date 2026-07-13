import { authStore } from "./auth-store";

const BASE_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/api/v1`;

export interface ListMeta {
  page?: number;
  perPage?: number;
  total?: number;
  totalPages?: number;
}

export interface ApiErrorDetail {
  field?: string;
  issue?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope {
  success?: boolean;
  data?: unknown;
  meta?: ListMeta;
  error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
}

export type QueryValue = string | number | boolean | null | undefined;

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Single-flight refresh: concurrent 401s share one refresh request. */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return false;
        const json = (await res.json().catch(() => null)) as Envelope | null;
        const data = (json?.data ?? {}) as { accessToken?: unknown };
        if (typeof data.accessToken === "string" && data.accessToken.length > 0) {
          authStore.setToken(data.accessToken);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
}

export interface ApiResult<T> {
  data: T;
  meta?: ListMeta;
}

/**
 * Fetch wrapper for the Get It Sasta API.
 * - unwraps the `{ success, data, meta }` envelope (throws ApiError otherwise)
 * - attaches the Bearer token from the in-memory auth store
 * - on 401: single-flight refresh, retry once, then redirect to /login
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const { method = "GET", body, query } = options;
  const url = `${BASE_URL}${path}${buildQuery(query)}`;

  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = authStore.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(url, {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();

  if (res.status === 401 && !path.startsWith("/auth/")) {
    const refreshed = await refreshSession();
    if (refreshed) res = await doFetch();
    if (!refreshed || res.status === 401) {
      authStore.setToken(null);
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.assign("/login");
      }
      throw new ApiError("Your session has expired. Please sign in again.", "UNAUTHENTICATED", 401);
    }
  }

  const json = (await res.json().catch(() => null)) as Envelope | null;

  if (!res.ok || !json || json.success === false) {
    const err = json?.error;
    throw new ApiError(
      err?.message ?? `Request failed with status ${res.status}`,
      err?.code ?? "UNKNOWN_ERROR",
      res.status,
      err?.details,
    );
  }

  return { data: json.data as T, meta: json.meta };
}

/** Convenience helper when the caller only needs the data payload. */
export async function apiData<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const result = await api<T>(path, options);
  return result.data;
}
