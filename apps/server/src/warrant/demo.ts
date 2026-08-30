/**
 * Track B demo walkthrough. Run it with:  npm run demo:warrant
 *
 * Drives the real HTTP surface in-process (no server, no Ark key needed) and
 * prints the authorization decisions as a judge would see them. Use it to
 * rehearse the three minutes, and to prove the denials are backend decisions
 * rather than UI states.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import { WarrantPlane } from "./index.js";
import { workspaceResource } from "./resources.js";
import { readdir } from "node:fs/promises";
import { buildContainerRunArgs } from "../container-codex-runner.js";
import { bindMountsIn } from "../aegis/sandbox/args.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const BOLD = "[1m";
const DIM = "[2m";
const GREEN = "[32m";
const RED = "[31m";
const CYAN = "[36m";
const OFF = "[0m";

const beat = (n: string, title: string): void => {
  console.log("\n" + BOLD + "── " + n + "  " + title + OFF);
};
const note = (text: string): void => console.log(DIM + "   " + text + OFF);

/** A demo that silently no-ops is worse than one that fails loudly. */
function expect(actual: number, wanted: number, what: string): void {
  if (actual !== wanted) {
    throw new Error(
      "demo step failed: " + what + " returned " + actual + ", expected " + wanted,
    );
  }
}

const short = (id: string): string => id.slice(0, 12);

function show(label: string, decision: Record<string, unknown>): void {
  const allowed = decision["decision"] === "Allow";
  const mark = allowed ? GREEN + "ALLOW" + OFF : RED + "DENY " + OFF;
  console.log(
    "   " + mark + "  " + label + "\n" +
      DIM + "          rule     " + String(decision["ruleId"]) + "\n" +
      "          human    " + String(decision["humanId"]) + "\n" +
      "          agent    " + String(decision["agentId"]) + "\n" +
      "          resource " + String(decision["resource"]) + "\n" +
      "          reason   " +
      String(decision["reason"]).replace(/([a-z]+_)[0-9a-f-]{36}/g, "$1…") + OFF,
  );
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "warrant-demo-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AEGIS_ENABLED: "false",
    ARK_MODEL: "ep-demo-balanced",
  } as NodeJS.ProcessEnv);
  const plane = await WarrantPlane.bootstrap(config);
  const app = await createApp(config, service, undefined, plane);

  const login = async (handle: string): Promise<string> =>
    (
      await app.inject({
        method: "POST",
        url: "/api/warrant/session",
        payload: { handle },
      })
    ).json().token as string;

  const act = async (agentId: string, action: string, resource: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/warrant/act",
        payload: { agentId, action, resource },
      })
    ).json().decision as Record<string, unknown>;

  console.log(
    BOLD + "\nWARRANT · CodeJam Track B (The Bouncer)" + OFF +
      DIM + "\ndelegation and authorization for multi-agent fan-out\n" + OFF,
  );

  // ---------------------------------------------------------------- 1
  beat("1", "Three humans sign in");
  const alice = await login("alice");
  const bob = await login("bob");
  const orchestrator = await login("orchestrator");
  note("Session tokens issued. Identity is derived from the token and nothing else.");

  // ---------------------------------------------------------------- 2
  beat("2", "One task is split, and each subtask gets an owner + agent + warrant");
  const planned = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks",
    headers: { authorization: "Bearer " + alice },
    payload: {
      title: "Add rate limiting to the API",
      owners: ["human:alice", "human:bob"],
      maxSubtasks: 3,
      sharedPaths: ["docs/CHANGELOG.md"],
    },
  });
  const { task, subtasks, splitter } = planned.json();
  note("splitter: " + splitter);
  for (const s of subtasks) {
    console.log(
      "   " + CYAN + s.id.slice(0, 12) + OFF +
        "  owner=" + s.ownerId.padEnd(13) +
        "model=" + String(s.model).padEnd(18) +
        "paths=" + s.paths.join(","),
    );
  }

  const aliceSub = subtasks.find((s: { ownerId: string }) => s.ownerId === "human:alice");
  const bobSub = subtasks.find((s: { ownerId: string }) => s.ownerId === "human:bob");

  // ---------------------------------------------------------------- 3
  beat("3", "POSITIVE — Alice's agent works inside its own warrant");
  show(
    "alice's agent reads its own workspace",
    await act(aliceSub.agentId, "workspace.read", workspaceResource(aliceSub.id)),
  );

  // ---------------------------------------------------------------- 4
  beat("4", "DENIAL — the same agent reaches for Bob's workspace");
  show(
    "alice's agent reads bob's workspace",
    await act(aliceSub.agentId, "workspace.read", workspaceResource(bobSub.id)),
  );
  note("Denied in the backend. The UI is not involved in this decision.");

  // ---------------------------------------------------------------- 4b
  beat("5", "PHYSICAL — the denial is not just a decision");
  const containerConfig = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    RUNTIME_PROVIDER: "container",
  } as NodeJS.ProcessEnv);

  const bound = plane.binder.bind(aliceSub.agentId, "implement the limiter");
  const argv = buildContainerRunArgs(bound.request, containerConfig);
  const mounts = bindMountsIn(argv);

  const onDisk = (await readdir(plane.workspaces.parent)).filter(
    (e) => e !== ".archived",
  );
  note(onDisk.length + " subtask workspaces exist on disk");
  console.log("   mounts bound into alice's agent container:");
  for (const m of mounts) {
    console.log(
      "     " + CYAN + m.dst + OFF + "  <-  " +
        m.src.replace(plane.workspaces.parent, "<workspaces>") +
        (m.readonly ? DIM + "  (ro)" + OFF : ""),
    );
  }
  const bobPath = plane.workspaces.pathFor(bobSub.id);
  const reachable = argv.join(" ").includes(bobPath);
  console.log(
    "   " + (reachable ? RED + "REACHABLE" + OFF : GREEN + "UNREACHABLE" + OFF) +
      "  bob's workspace inside alice's namespace",
  );
  note("Bob's files are at no path in this container. Nothing to ask for.");

  // ---------------------------------------------------------------- 5b
  beat("6", "SHARED STATE — both agents edit one document, no race");
  const SHARED = "docs/CHANGELOG.md";
  const docs = plane.docs;

  await docs.write(SHARED, aliceSub.agentId, 0, "# Changelog\n\n- TBD\n- TBD\n- TBD");
  await docs.read(SHARED, aliceSub.agentId);
  await docs.read(SHARED, bobSub.agentId);
  const base = (await docs.read(SHARED, aliceSub.agentId)).version;
  note("both agents hold version " + base + " of " + SHARED);

  // Fired simultaneously, editing different lines.
  const [aliceWrite, bobWrite] = await Promise.all([
    docs.write(SHARED, aliceSub.agentId, base, "# Changelog\n\n- rate limiter (alice)\n- TBD\n- TBD"),
    docs.write(SHARED, bobSub.agentId, base, "# Changelog\n\n- TBD\n- TBD\n- config validation (bob)"),
  ]);
  console.log(
    "   alice -> " + GREEN + aliceWrite.status + OFF +
      "     bob -> " + GREEN + bobWrite.status + OFF +
      DIM + "  (concurrent, disjoint lines)" + OFF,
  );
  const converged = (await docs.read(SHARED, aliceSub.agentId)).content;
  for (const line of converged.split("\n")) {
    if (line.trim()) console.log("     " + DIM + line + OFF);
  }
  note("Both edits survived. Serialised writes, three-way merge, no lost update.");

  // Now the same line, from the same base.
  await docs.read(SHARED, aliceSub.agentId);
  await docs.read(SHARED, bobSub.agentId);
  const v2 = (await docs.read(SHARED, aliceSub.agentId)).version;
  const lines = converged.split("\n");
  await docs.write(SHARED, aliceSub.agentId, v2, [...lines.slice(0, 2), "- ALICE OWNS THIS LINE", ...lines.slice(3)].join("\n"));
  const clash = await docs.write(SHARED, bobSub.agentId, v2, [...lines.slice(0, 2), "- BOB OWNS THIS LINE", ...lines.slice(3)].join("\n"));
  console.log(
    "   same line -> " + RED + clash.status + OFF +
      DIM + "   reported, not silently resolved" + OFF,
  );

  // ---------------------------------------------------------------- 5
  beat("7", "SUCCESS TEST — forging the user id changes nothing");
  const forged = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks/" + task.id + "/integrate?humanId=human:orchestrator",
    headers: {
      authorization: "Bearer " + alice,
      "x-acting-user": "human:orchestrator",
      "x-user-id": "human:orchestrator",
    },
    payload: { humanId: "human:orchestrator", isOrchestrator: true },
  });
  show("alice integrates while claiming to be the orchestrator", forged.json().decision);
  note("Query param, two headers and a body field all claimed orchestrator.");
  note("Identity came from the session token, so the caller is still alice.");

  // ---------------------------------------------------------------- 7
  beat("8", "INTEGRATION GATE — the orchestrator cannot merge unapproved work");
  for (const s of subtasks) {
    const submitted = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + s.id + "/submit",
    });
    expect(submitted.statusCode, 200, "submit " + short(s.id));
  }
  const early = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks/" + task.id + "/integrate",
    headers: { authorization: "Bearer " + orchestrator },
  });
  show("orchestrator integrates with approvals pending", early.json().decision);

  for (const s of subtasks) {
    const approved = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + s.id + "/approve",
      headers: {
        authorization: "Bearer " + (s.ownerId === "human:alice" ? alice : bob),
      },
    });
    expect(approved.statusCode, 200, "approve " + short(s.id));
  }
  const merged = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks/" + task.id + "/integrate",
    headers: { authorization: "Bearer " + orchestrator },
  });
  show("orchestrator integrates after every owner approves", merged.json().decision);

  // ---------------------------------------------------------------- 6
  beat("9", "REVOCATION — Alice pulls her agent's authority mid-flight");
  const revoked = await app.inject({
    method: "POST",
    url: "/api/warrant/revoke",
    headers: { authorization: "Bearer " + alice },
    payload: { warrantId: aliceSub.warrantId, reason: "Reassigning this subtask" },
  });
  expect(revoked.statusCode, 200, "revoke");
  show(
    "the same read that worked in beat 3",
    await act(aliceSub.agentId, "workspace.read", workspaceResource(aliceSub.id)),
  );

  // ---------------------------------------------------------------- 8
  beat("10", "EVIDENCE — every decision, in one verifiable chain");
  // The chain is viewer-scoped, so the evidence beat reads it as the
  // orchestrator - the one principal whose view is "all".
  const events = (
    await app.inject({
      method: "GET",
      url: "/api/warrant/events",
      headers: { authorization: "Bearer " + orchestrator },
    })
  ).json();
  console.log(
    "   " + String(events.events.length) + " decisions recorded · chain " +
      (events.chainValid ? GREEN + "VALID" + OFF : RED + "BROKEN" + OFF) +
      DIM + " · head " + String(events.chainHead).slice(0, 12) + OFF,
  );
  for (const e of events.events.slice(-6)) {
    const d = e.verdict.decision === "Allow" ? GREEN + "ALLOW" + OFF : RED + "DENY " + OFF;
    console.log(
      "   " + d + " " + DIM + String(e.evidence.human).padEnd(19) +
        String(e.evidence.action).padEnd(18) + String(e.verdict.ruleId) + OFF,
    );
  }

  console.log(
    "\n" + DIM + "Limitations: human sign-in is mock (anyone reachable can be alice), " +
      "and the\nregistry is in-memory. Next: OIDC, and a live container run under " +
      "the profile.\n" + OFF,
  );

  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

await main();
