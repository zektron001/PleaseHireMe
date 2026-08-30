/**
 * Create Agent, as a native <dialog> - same reasoning as the command palette:
 * Escape, the focus trap and the inert backdrop are free from the platform.
 *
 * The three fields and the endpoint behind them are the starter kit's, so the
 * baseline journey is the same three clicks it always was.
 */

import { useEffect, useRef, useState } from "react";
import type { AgentForm } from "../state/useAgents";
import { emptyForm } from "../state/useAgents";

export function CreateAgentDialog({
  open,
  busy,
  onCreate,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  onCreate: (values: AgentForm) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<AgentForm>(emptyForm);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValues(emptyForm);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog className="wb-dialog" ref={ref} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate(values).then(onClose);
        }}
      >
        <h2>Create an Agent</h2>
        <p>Each Agent gets a persistent workspace folder and a resumable Codex session.</p>

        <label>
          Name
          <input
            autoFocus
            required
            maxLength={80}
            placeholder="Frontend Builder"
            value={values.name}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
          />
        </label>

        <label>
          Description
          <input
            maxLength={500}
            placeholder="Builds polished React prototypes"
            value={values.description}
            onChange={(event) => setValues({ ...values, description: event.target.value })}
          />
        </label>

        <label>
          System instructions
          <textarea
            rows={5}
            maxLength={10_000}
            value={values.instructions}
            onChange={(event) => setValues({ ...values, instructions: event.target.value })}
          />
        </label>

        <div className="wb-dialog-foot">
          <button type="button" className="view-button" onClick={onClose}>
            Cancel
          </button>
          <button className="view-button primary" disabled={busy || !values.name.trim()}>
            {busy ? "Creating…" : "Create Agent"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
