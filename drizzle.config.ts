import type { Config } from "drizzle-kit";

export default {
  // The schema is split by domain under src/db/schema/ and re-exported from
  // its index. Pointing at the directory keeps drizzle-kit reading all of it.
  schema: "./src/db/schema",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: "file:flexfit.db",
  },
} satisfies Config;
