/**
 * Run and Debug: the starter kit's Agents, in the shell instead of behind it.
 *
 * The list, the Create button and the runtime card are the Playground's own,
 * re-parented into a side bar view. The chat moved to an editor tab, because
 * that is where a thing you read and type into belongs in this layout.
 *
 * The two Agent models are kept visibly apart on purpose. These are workspace
 * Agents you create by hand. The ones in Sessions are WARRANT subtask Agents,
 * minted by planning and accountable to a warrant - showing them in one list
 * would imply a shared lifecycle that does not exist.
 */

import type { Agent, SystemInfo } from "../types";
import { Codicon } from "../shell/Codicon";

const STATUS_ICON: Record<Agent["status"], string> = {
  ready: "pass-filled",
  busy: "loading",
  stopped: "circle-outline",
  error: "error",
};

export function RunView({
  agents,
  selectedId,
  system,
  busy,
  onSelect,
  onCreate,
  onToggle,
  onDelete,
}: {
  agents: Agent[];
  selectedId: string | null;
  system: SystemInfo | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  return (
    <>
      <div className="view-actions">
        <button className="view-button" onClick={onCreate}>
          <Codicon name="add" />
          Create Agent
        </button>
      </div>

      <div className="view-section">
        Your Agents <span className="activity-badge">{agents.length}</span>
      </div>

      {agents.length === 0 && (
        <p className="panel-empty">
          None yet. An Agent is a persistent workspace folder plus a resumable
          Codex session.
        </p>
      )}

      {agents.map((agent) => (
        <button
          key={agent.id}
          className="tree-row"
          data-active={agent.id === selectedId}
          onClick={() => onSelect(agent.id)}
          title={agent.description || agent.name}
        >
          <Codicon
            name={STATUS_ICON[agent.status]}
            spin={agent.status === "busy"}
            className={"status-" + agent.status}
          />
          <span className="tree-name">{agent.name}</span>
          <span className="tree-meta">{agent.status}</span>
        </button>
      ))}

      {selected && (
        <div className="view-actions">
          <button className="view-button" disabled={busy} onClick={onToggle}>
            <Codicon name={selected.status === "stopped" ? "play" : "debug-stop"} />
            {selected.status === "stopped" ? "Start" : "Stop"}
          </button>
          <button className="view-button danger" disabled={busy} onClick={onDelete}>
            <Codicon name="trash" />
            Delete
          </button>
        </div>
      )}

      {system && (
        <>
          <div className="view-section">Runtime</div>
          <div className="runtime-lines">
            <div>
              <Codicon name={system.codexAvailable ? "pass" : "warning"} />
              {system.codexAvailable
                ? "Codex CLI available"
                : "Codex CLI not found — turns will fail"}
            </div>
            <div>
              <Codicon name={system.arkConfigured ? "pass" : "warning"} />
              {system.arkConfigured ? "Ark configured" : "Ark not configured"}
              {system.arkModel ? " · " + system.arkModel : ""}
            </div>
            <div>
              <Codicon name="server-environment" />
              {system.runtime}
            </div>
          </div>
        </>
      )}
    </>
  );
}
