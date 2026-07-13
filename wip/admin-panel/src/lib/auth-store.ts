/**
 * In-memory access-token store. The refresh token lives in an httpOnly
 * cookie managed by the API, so nothing sensitive is persisted client-side.
 */

type Listener = () => void;

let accessToken: string | null = null;
const listeners = new Set<Listener>();

export const authStore = {
  getToken(): string | null {
    return accessToken;
  },
  setToken(token: string | null): void {
    accessToken = token;
    for (const listener of listeners) listener();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
