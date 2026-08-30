/**
 * The starter kit's own Agent model: create a workspace, start it, chat to it.
 *
 * This is a **verbatim move** out of App.tsx, not a rewrite. G6 is "zero
 * regression to the supplied Create -> Start -> Chat journey", and the cheapest
 * way to keep that true is for the same handlers to hit the same endpoints in
 * the same order. Only the surface around them changed.
 *
 * Not to be confused with WARRANT subtask Agents (`agent_<uuid>`), which are
 * minted by planning and never created by hand. These two models are genuinely
 * separate: different ids, different auth, different lifecycle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Agent, AgentRun, Message, SystemInfo } from "../types";

export interface AgentForm {
  name: string;
  description: string;
  instructions: string;
}

export const emptyForm: AgentForm = {
  name: "",
  description: "",
  instructions: "Help me build and test software in this workspace.",
};

export function useAgents(enabled: boolean) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [form, setForm] = useState<AgentForm>(emptyForm);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void Promise.all([refreshAgents(), api.system().then(setSystem)]).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [enabled, refreshAgents]);

  /** Resumes polling a run that was already in flight when the view opened. */
  const pollRun = useCallback(
    async (runId: string, agentId: string) => {
      if (pollingRunIds.current.has(runId)) return;
      pollingRunIds.current.add(runId);
      try {
        while (mountedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!mountedRef.current) return;
          const result = await api.run(runId);
          if (selectedIdRef.current === agentId) setActiveRun(result.run);
          if (!["queued", "running"].includes(result.run.status)) {
            await Promise.all([refreshMessages(agentId), refreshAgents()]);
            return;
          }
        }
      } finally {
        pollingRunIds.current.delete(runId);
      }
    },
    [refreshAgents, refreshMessages],
  );

  useEffect(() => {
    setActiveRun(null);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId, pollRun]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  const guard = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createAgent = (values: AgentForm) =>
    guard(async () => {
      const { agent } = await api.createAgent(values);
      await refreshAgents();
      setSelectedId(agent.id);
      setForm(emptyForm);
    });

  const saveAgent = (values: AgentForm) =>
    guard(async () => {
      if (!selected) return;
      await api.updateAgent(selected.id, values);
      await refreshAgents();
    });

  const toggleAgent = () =>
    guard(async () => {
      if (!selected) return;
      if (selected.status === "stopped") await api.startAgent(selected.id);
      else await api.stopAgent(selected.id);
      await refreshAgents();
    });

  const deleteAgent = () =>
    guard(async () => {
      if (!selected) return;
      // Deleting archives the workspace rather than destroying it, but it is
      // still the one irreversible-looking action here, so it still asks.
      if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
        return;
      }
      await api.deleteAgent(selected.id);
      await refreshAgents();
    });

  const sendMessage = async (content: string): Promise<void> => {
    if (!selected || !content.trim()) return;
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content.trim());
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  return {
    agents,
    selected,
    selectedId,
    setSelectedId,
    messages,
    system,
    form,
    setForm,
    activeRun,
    busy,
    error,
    setError,
    createAgent,
    saveAgent,
    toggleAgent,
    deleteAgent,
    sendMessage,
    refreshAgents,
  };
}
