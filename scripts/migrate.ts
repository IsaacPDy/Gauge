// `npm run db:migrate` — applies db/migrations to the branch DATABASE_URL_UNPOOLED points at.
import { migrate } from "../src/db/migrate";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL) in .env.local first.");
  process.exit(1);
}

migrate(url).then(
  (applied) => console.info(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date."),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
