import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: ["./db/schema.ts", "./db/billing-schema.ts", "./db/email-auth-schema.ts"],
  dialect: "sqlite",
});
