import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaperclipSkillsDir } from "./server-utils.js";

describe("packaged skills directory resolution", () => {
  it("prefers the caller's explicit source root over a broader fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-skill-root-preference-"));
    try {
      const moduleDir = path.join(root, "repo", "server", "src", "services");
      const explicit = path.join(root, "explicit-skills");
      await mkdir(moduleDir, { recursive: true });
      await mkdir(path.join(root, "skills"), { recursive: true });
      await mkdir(explicit, { recursive: true });
      expect(await resolvePaperclipSkillsDir(moduleDir, [explicit])).toBe(explicit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
