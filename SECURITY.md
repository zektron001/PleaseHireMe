# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## What this fork adds

The upstream starter kit shipped with no middleware at all. This fork adds three
planes. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full matrix.

- **WARRANT** - per-human delegation and server-side authorization. Each Agent
  acts under a scoped, expiring, revocable warrant from one human; cross-owner
  access is denied in the backend with full actor attribution.
- **CONCORD** - serialised writes and three-way merge on shared documents, with
  the authority check inside the write's critical section.
- **AEGIS** - hardened sandbox profile, protected-asset attestation, budget and
  step limits, kill switch, and a hash-chained, access-controlled decision log.

## Known limitations

Still true, and stated plainly:

- **Human sign-in is mock.** Anyone who can reach the server can open a session
  as any listed user. Authorization *after* delegation is enforced; proving who
  a human is, is not. This is the single largest gap.
- **The egress broker is specified but not implemented**, so network
  confinement is detective rather than topological.
- **No container has yet been run under the hardened profile.** Isolation is
  asserted over generated argv in CI, not observed in a live namespace.
- Ordinary local containers, not hardened multi-tenant sandboxes; a kernel
  escape defeats the boundary.
- No CSRF protection.
- No per-Agent container boundary in ECS mode.
- Prompt-triggered command and file execution is the platform's purpose, not a
  defect - it is what the sandbox exists to bound.
- The Ark key is available to the server and, until the broker lands, to the
  active Runtime container.
- Ark key stored in Terraform POC state.
- State is in-memory or single-process JSON; warrants and shared documents do
  not survive a restart.

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
