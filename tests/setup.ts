import { vi } from "vitest";

// src/db/index.ts opens a libsql client at import time. Point it at an
// throwaway in-memory database so importing the routers never touches the
// developer's real flexfit.db file.
process.env.DB_FILE = "file::memory:";

// The auth router and createContext() reach for Next's request-scoped cookie
// store, which does not exist outside a request. Tests that care about cookies
// assert against this fake; every other test just needs the import to resolve.
const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

export { cookieJar };
