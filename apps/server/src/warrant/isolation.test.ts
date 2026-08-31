/**
 * Closing L2: the cross-owner denial is PHYSICAL, not only logical.
 *
 * Two independent properties are asserted here, and the point is that either one
 * alone would hold if the other were broken:
 *
 *   logical  - the PDP refuses the request              (WB-6.cross-owner-denied)
 *   physical - the sibling is absent from the namespace (no bind mount exists)
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { buildContainerRunArgs } from "../container-codex-runner.js";
import {
  assertWorkspaceIsolation,
  bindMountsIn,
  hardenContainerArgs,
  isolationEvidence,
  SandboxProfileError,
} from "../aegis/sandbox/args.js";
import { WarrantBindingError } from "./binding.js";
import { MOCK_HUMANS, WarrantPlane } from "./index.js";
import { workspaceResource } from "./resources.js";

let dir = "";
let plane: WarrantPlane;

interface Planned {
  id: string;
  ownerId: string;
  agentId: string;
  warrantId: string;
}

async function planTask(): Promise<Planned[]> {
  const result = await plane.orchestrator.plan({
    title: "Add rate limiting to the API",
    createdBy: "human:alice",
    owners: ["human:alice", "human:bob"],
    maxSubtasks: 3,
  });
  return result.subtasks as unknown as Planned[];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "warrant-iso-"));
  plane = await WarrantPlane.bootstrap(
    loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dir,
      AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
      CODEX_HOME: path.join(dir, "codex-home"),
      AEGIS_ENABLED: "false",
    } as NodeJS.ProcessEnv),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe("each subtask gets a real, separate directory", () => {
  it("creates one workspace per subtask with an owner-specific brief", async () => {
    const subtasks = await planTask();
    const root = plane.workspaces.parent;

    const entries = (await readdir(root)).filter((e) => e !== ".archived");
    expect(entries.sort()).toEqual(subtasks.map((s) => s.id).sort());

    for (const subtask of subtasks) {
      const brief = await readFile(
        path.join(plane.workspaces.pathFor(subtask.id), "AGENTS.md"),
        "utf8",
      );
      expect(brief).toContain(subtask.ownerId);
      expect(brief).toContain("Other subtasks");
    }
  });

  it("gives every subtask a distinct path", async () => {
    const subtasks = await planTask();
    const paths = subtasks.map((s) => plane.workspaces.pathFor(s.id));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("binding: no live warrant means no workspace at all", () => {
  it("binds the warranted subtask workspace and nothing else", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;

    const bound = plane.binder.bind(alices.agentId, "do the work");
    expect(bound.request.workspacePath).toBe(plane.workspaces.pathFor(alices.id));
    expect(bound.ownerId).toBe(alices.ownerId);
    expect(bound.isolation.siblingWorkspaces).toHaveLength(subtasks.length - 1);
    expect(bound.isolation.siblingWorkspaces).not.toContain(
      bound.request.workspacePath,
    );
  });

  it("refuses to produce a runner request once the warrant is revoked", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    expect(() => plane.binder.bind(alices.agentId, "x")).not.toThrow();

    plane.registry.revoke(alices.warrantId, alices.ownerId, "reassigned");

    // No RunnerRequest means no container is ever constructed.
    let caught: unknown;
    try {
      plane.binder.bind(alices.agentId, "x");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WarrantBindingError);
    expect((caught as WarrantBindingError).decision.ruleId).toBe(
      "WB-1.no-live-warrant",
    );
  });

  it("refuses an agent that holds no warrant at all", () => {
    expect(() => plane.binder.bind("agent_nobody", "x")).toThrow(WarrantBindingError);
  });
});

describe("PHYSICAL isolation in the generated container argv", () => {
  async function argvFor(agentId: string): Promise<{ args: string[]; bound: ReturnType<WarrantPlane["binder"]["bind"]> }> {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dir,
      AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
      CODEX_HOME: path.join(dir, "codex-home"),
      RUNTIME_PROVIDER: "container",
    } as NodeJS.ProcessEnv);

    const bound = plane.binder.bind(agentId, "implement the limiter");
    const baseline = buildContainerRunArgs(bound.request, config);
    const args = hardenContainerArgs(baseline, {
      networkMode: "aegis-egress",
      seccompProfilePath: null,
      brokerUrl: "http://aegis-broker:8080",
      runToken: "tok",
      codexHome: config.codexHome,
      forbiddenMounts: [],
    });
    return { args, bound };
  }

  it("mounts ONLY the warranted workspace", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    const { args, bound } = await argvFor(alices.agentId);

    const workspaceMounts = bindMountsIn(args).filter((m) => m.dst === "/workspace");
    expect(workspaceMounts).toHaveLength(1);
    expect(workspaceMounts[0]?.src).toBe(plane.workspaces.pathFor(alices.id));

    // The whole claim, stated as one assertion: nothing anywhere in the argv
    // references a sibling's directory, so those files exist at no path inside
    // the namespace.
    for (const sibling of bound.isolation.siblingWorkspaces) {
      expect(args.join(" ")).not.toContain(sibling);
    }
  });

  it("passes the isolation assertion for a correctly bound run", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    const { args, bound } = await argvFor(alices.agentId);
    expect(() => assertWorkspaceIsolation(args, bound.isolation)).not.toThrow();
    expect(plane.binder.verifyArgv(bound, args)).toMatchObject({
      workspace: plane.workspaces.pathFor(alices.id),
    });
  });

  it("REFUSES argv that binds a sibling workspace directly", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    const bobs = subtasks[1] as Planned;
    const { args, bound } = await argvFor(alices.agentId);

    const tampered = [
      ...args.slice(0, 1),
      "--mount",
      "type=bind,src=" + plane.workspaces.pathFor(bobs.id) + ",dst=/peek",
      ...args.slice(1),
    ];
    expect(() => assertWorkspaceIsolation(tampered, bound.isolation)).toThrow(
      SandboxProfileError,
    );
  });

  it("REFUSES argv that binds the shared parent directory", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    const { args, bound } = await argvFor(alices.agentId);

    // The subtle escape: no sibling path appears literally, but the parent
    // exposes every sibling at once, including ones created later.
    const tampered = [
      ...args.slice(0, 1),
      "--mount",
      "type=bind,src=" + plane.workspaces.parent + ",dst=/all",
      ...args.slice(1),
    ];
    expect(args.join(" ")).not.toContain(plane.workspaces.pathFor(subtasks[1]!.id));
    expect(() => assertWorkspaceIsolation(tampered, bound.isolation)).toThrow(
      SandboxProfileError,
    );
  });

  it("refuses the shared parent even when there is not yet a sibling", async () => {
    // With siblings present the sibling rule already catches a parent mount, so
    // the parent rule only earns its place here: a one-subtask task, where the
    // exposure is of subtasks that do not exist YET.
    const single = await plane.orchestrator.plan({
      title: "Single owner task",
      createdBy: "human:alice",
      owners: ["human:alice"],
      maxSubtasks: 1,
    });
    const only = single.subtasks[0]!;
    const bound = plane.binder.bind(only.agentId, "x");
    expect(bound.isolation.siblingWorkspaces).toHaveLength(0);

    const tampered = [
      "run",
      "--mount",
      "type=bind,src=" + plane.workspaces.parent + ",dst=/all",
      "--mount",
      "type=bind,src=" + bound.request.workspacePath + ",dst=/workspace",
      "image",
      "codex",
    ];
    expect(() => assertWorkspaceIsolation(tampered, bound.isolation)).toThrow(
      /shared workspace directory/,
    );
  });

  it("REFUSES argv whose workspace mount points somewhere else", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    const bobs = subtasks[1] as Planned;
    const { args, bound } = await argvFor(alices.agentId);

    const swapped = args.map((arg) =>
      arg.includes("dst=/workspace")
        ? "type=bind,src=" + plane.workspaces.pathFor(bobs.id) + ",dst=/workspace"
        : arg,
    );
    expect(() => assertWorkspaceIsolation(swapped, bound.isolation)).toThrow(
      /but the warrant names/,
    );
  });

  it("reports what the run could reach, for the audit event", async () => {
    const subtasks = await planTask();
    const { args } = await argvFor((subtasks[0] as Planned).agentId);
    const evidence = isolationEvidence(args);
    expect(evidence["bindMounts"]).toBeGreaterThanOrEqual(1);
    expect(evidence["workspace"]).toContain("sub_");
  });
});

describe("logical and physical denials agree", () => {
  it("denies the same access twice, by two independent mechanisms", async () => {
    const subtasks = await planTask();
    const alices = subtasks[0] as Planned;
    const bobs = subtasks[1] as Planned;

    // Write a secret into Bob's workspace so "unreachable" is a real claim.
    await writeFile(
      path.join(plane.workspaces.pathFor(bobs.id), "secret.txt"),
      "bob's private working notes",
      "utf8",
    );

    // 1. Logical: the PDP refuses the request.
    const decision = plane.check({
      agentId: alices.agentId,
      action: "workspace.read",
      resource: workspaceResource(bobs.id),
    });
    expect(decision.decision).toBe("Deny");
    expect(decision.ruleId).toBe("WB-6.cross-owner-denied");

    // 2. Physical: Bob's directory is bound nowhere in Alice's container.
    const bound = plane.binder.bind(alices.agentId, "x");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dir,
      AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
      CODEX_HOME: path.join(dir, "codex-home"),
      RUNTIME_PROVIDER: "container",
    } as NodeJS.ProcessEnv);
    const args = buildContainerRunArgs(bound.request, config);

    expect(args.join(" ")).not.toContain(plane.workspaces.pathFor(bobs.id));
    expect(bindMountsIn(args).map((m) => m.src)).not.toContain(
      plane.workspaces.pathFor(bobs.id),
    );
  });
});
