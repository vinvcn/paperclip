import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("registers every migration with a finite timestamp and numeric index", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
  const migrations = (await readdir(migrationsDir)).filter(file => file.endsWith(".sql")).sort();
  expect(journal.entries.map(entry => `${entry.tag}.sql`)).toEqual(migrations);
  for (const entry of journal.entries) {
    expect(Number.isInteger(entry.idx), entry.tag).toBe(true);
    expect(Number.isFinite(entry.when), entry.tag).toBe(true);
    expect(entry.when).toBeGreaterThanOrEqual(0);
  }
});
