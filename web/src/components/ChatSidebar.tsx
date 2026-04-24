/**
 * ChatSidebar — structured-events panel that sits next to the xterm.js
 * terminal in the dashboard Chat tab.
 *
 * The terminal pane (`<ChatPage>`) renders the literal TUI process via PTY
 * — full fidelity, byte-identical to `hermes --tui` in a regular terminal.
 * That's the canonical chat surface; everything inside the agent loop is
 * painted there.
 *
 * This sidebar runs a *parallel* JSON-RPC WebSocket to the same gateway
 * dispatcher and renders the structural metadata that PTY can't surface
 * to the surrounding chrome: model badge with live connection state,
 * model picker, error banner.
 *
 * Tool-call mirroring is intentionally NOT here. The PTY pane spawns
 * `hermes --tui` as a child process with its own `tui_gateway` and its
 * own `_sessions` dict; the WS sidecar runs in-process in the dashboard
 * server with a separate `_sessions` dict. Events emitted on the child's
 * gateway never cross the process boundary, so a sidebar listener on
 * `tool.start` would always be empty. Surfacing tool calls in the
 * sidebar requires cross-process event forwarding (PTY child opens a
 * back-WS to the dashboard, gateway tees emits onto both stdio and the
 * sidecar transport) — a follow-up that's a proper feature, not a
 * cosmetic add-on.
 *
 * Best-effort: if the WebSocket can't connect (older gateway, network
 * hiccup, missing token) the terminal pane keeps working unimpaired.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { GatewayClient, type ConnectionState } from "@/lib/gatewayClient";

import { AlertCircle, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface SessionInfo {
  cwd?: string;
  model?: string;
  provider?: string;
  credential_warning?: string;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: "idle",
  connecting: "connecting",
  open: "live",
  closed: "closed",
  error: "error",
};

const STATE_TONE: Record<ConnectionState, string> = {
  idle: "bg-muted text-muted-foreground",
  connecting: "bg-primary/10 text-primary",
  open: "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400",
  closed: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

export function ChatSidebar() {
  // `version` bumps on reconnect; gw is derived so we never call setState
  // for it inside an effect (React 19's set-state-in-effect rule). The
  // counter is the dependency on purpose — it's not read in the memo body,
  // it's the signal that says "rebuild the client".
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gw = useMemo(() => new GatewayClient(), [version]);

  const [state, setState] = useState<ConnectionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo>({});
  const [modelOpen, setModelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const offState = gw.onState(setState);

    const offSessionInfo = gw.on<SessionInfo>("session.info", (ev) => {
      if (ev.session_id) {
        setSessionId(ev.session_id);
      }

      if (ev.payload) {
        setInfo((prev) => ({ ...prev, ...ev.payload }));
      }
    });

    const offError = gw.on<{ message?: string }>("error", (ev) => {
      const message = ev.payload?.message;

      if (message) {
        setError(message);
      }
    });

    // Adopt whichever session the gateway hands us. session.create on the
    // sidecar is independent of the PTY pane's session by design — we
    // only need a sid to drive the model picker's slash.exec calls.
    gw.connect()
      .then(() => gw.request<{ session_id: string }>("session.create", {}))
      .then((created) => {
        if (created?.session_id) {
          setSessionId(created.session_id);
        }
      })
      .catch((e: Error) => setError(e.message));

    return () => {
      offState();
      offSessionInfo();
      offError();
      gw.close();
    };
  }, [gw]);

  const reconnect = useCallback(() => {
    setError(null);
    setVersion((v) => v + 1);
  }, []);

  // Picker hands us a fully-formed slash command (e.g. "/model anthropic/...").
  // Fire-and-forget through `slash.exec`; the TUI pane will render the result
  // via PTY, so the sidebar doesn't need to surface output of its own.
  const onModelSubmit = useCallback(
    (slashCommand: string) => {
      if (!sessionId) {
        return;
      }

      void gw.request("slash.exec", {
        session_id: sessionId,
        command: slashCommand,
      });
      setModelOpen(false);
    },
    [gw, sessionId],
  );

  const canPickModel = state === "open" && !!sessionId;
  const modelLabel = (info.model ?? "—").split("/").slice(-1)[0] ?? "—";
  const banner = error ?? info.credential_warning ?? null;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-3 normal-case">
      <Card className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            model
          </div>

          <button
            type="button"
            disabled={!canPickModel}
            onClick={() => setModelOpen(true)}
            className="flex items-center gap-1 truncate text-sm font-medium hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
            title={info.model ?? "switch model"}
          >
            <span className="truncate">{modelLabel}</span>

            {canPickModel && (
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            )}
          </button>
        </div>

        <Badge className={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
      </Card>

      {banner && (
        <Card className="flex items-start gap-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />

          <div className="min-w-0 flex-1">
            <div className="break-words text-destructive">{banner}</div>

            {error && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 px-1.5 text-xs"
                onClick={reconnect}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                reconnect
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card className="flex flex-1 flex-col items-center justify-center gap-1 px-3 py-4 text-center text-xs text-muted-foreground">
        <div className="font-medium">tool calls render in the terminal</div>
        <div className="text-[0.7rem] opacity-80">
          cross-process forwarding to this sidecar lands in a follow-up
        </div>
      </Card>

      {modelOpen && canPickModel && sessionId && (
        <ModelPickerDialog
          gw={gw}
          sessionId={sessionId}
          onClose={() => setModelOpen(false)}
          onSubmit={onModelSubmit}
        />
      )}
    </aside>
  );
}
