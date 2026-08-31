/**
 * The Playground conversation, as an editor surface.
 *
 * Same endpoints and same sequence as the starter kit - send, poll the run,
 * refresh - so the baseline journey is unchanged. What differs is that it lives
 * in an editor tab and is painted with the workbench tokens instead of the old
 * paper palette.
 */

import { useEffect, useRef, useState } from "react";
import type { Agent, AgentRun, Message, SystemInfo } from "../types";
import { Codicon } from "../shell/Codicon";

const STARTERS = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AgentChat({
  agent,
  messages,
  activeRun,
  system,
  onSend,
}: {
  agent: Agent;
  messages: Message[];
  activeRun: AgentRun | null;
  system: SystemInfo | null;
  onSend: (content: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const running = activeRun != null && ["queued", "running"].includes(activeRun.status);
  const blocked = agent.status === "stopped" || agent.status === "busy" || running;

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <strong>{agent.name}</strong>
          <span>{agent.description || "No description"}</span>
        </div>
        <span className="chat-session">
          <Codicon name={agent.codexThreadId ? "debug-breakpoint-log" : "circle-outline"} />
          {agent.codexThreadId ? "Session connected" : "New session"}
        </span>
      </header>

      <div className="chat-log">
        {messages.length === 0 && !activeRun ? (
          <div className="chat-welcome">
            <h3>What should {agent.name} build?</h3>
            <p>
              It can inspect files, write code, run commands, and continue the same
              Codex session across messages.
            </p>
            {STARTERS.map((item) => (
              <button key={item} onClick={() => setPrompt(item)}>
                <Codicon name="arrow-right" />
                {item}
              </button>
            ))}
          </div>
        ) : (
          messages.map((message) => (
            <article className={"chat-message chat-" + message.role} key={message.id}>
              <div className="chat-meta">
                <strong>{message.role === "user" ? "You" : agent.name}</strong>
                <span>{formatTime(message.createdAt)}</span>
              </div>
              <div className="chat-body">{message.content}</div>
            </article>
          ))
        )}

        {running && (
          <article className="chat-message chat-assistant">
            <div className="chat-meta">
              <strong>{agent.name}</strong>
              <span>working in the Agent workspace</span>
            </div>
            <div className="chat-body chat-thinking">
              <Codicon name="loading" spin />
              Codex is reading, editing, or running commands…
            </div>
          </article>
        )}

        {activeRun?.status === "failed" && (
          <article className="chat-message chat-failed">
            <div className="chat-meta">
              <strong>Run failed</strong>
            </div>
            <div className="chat-body">{activeRun.error}</div>
          </article>
        )}

        <div ref={end} />
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = prompt.trim();
          if (!content) return;
          setPrompt("");
          void onSend(content);
        }}
      >
        <textarea
          value={prompt}
          rows={3}
          disabled={blocked}
          placeholder={
            agent.status === "stopped"
              ? "Start this Agent to continue…"
              : "Describe what you want the Agent to do…"
          }
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="chat-composer-foot">
          <span>
            Enter to send · Shift+Enter for a newline ·{" "}
            {system?.codexSandboxMode ?? "checking sandbox"}
          </span>
          <button disabled={blocked || !prompt.trim()} aria-label="Send message">
            <Codicon name="send" />
          </button>
        </div>
      </form>
    </div>
  );
}
