import { describe, expect, it } from "vitest";
import { compareMaintenanceNodes, maintenanceNodeList } from "./maintenance";
import type { ParsedNode } from "../types/node";

const node = (name: string, fields = {}): ParsedNode => ({ name, type: "ss", server: "example.com", port: 443, cipher: "aes-128-gcm", password: "private-password", ...fields });
describe("subscription maintenance differences", () => {
  it("distinguishes additions, removals, credentials changed, renames and metadata-only changes", () => {
    const before = [node("kept"), node("changed"), node("removed", { server: "old.example.com" }), node("old-name", { port: 8443 })];
    const after = [node("kept", { _meta: { latency: 12 } }), node("changed", { password: "new-private-password" }), node("new-name", { port: 8443 }), node("added", { server: "new.example.com" })];
    const diff = compareMaintenanceNodes(before, after);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.changes).toEqual(expect.arrayContaining([
      { kind: "changed", name: "changed", previousName: undefined, fields: ["password"] },
      { kind: "renamed", name: "new-name", previousName: "old-name", fields: ["name"] },
      { kind: "removed", name: "removed", fields: [] },
      { kind: "added", name: "added", fields: [] },
    ]));
    expect(JSON.stringify(diff)).not.toContain("private-password");
    expect(JSON.stringify(diff)).not.toContain("example.com");
  });
  it("reserves same-name nodes before pairing duplicate endpoint renames", () => {
    const diff = compareMaintenanceNodes([node("gone"), node("kept")], [node("kept"), node("renamed")]);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.changes).toEqual([{ kind: "renamed", name: "renamed", previousName: "gone", fields: ["name"] }]);
  });
  it("node listings omit servers, credentials and subscription URLs", () => {
    const list = maintenanceNodeList([node("one", { _sourceIds: ["s1"] })], [{ id: "s1", tag: "来源一" }]);
    expect(list).toEqual([{ id: "node-0", name: "one", type: "ss", source: "来源一" }]);
  });
});
