import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ArrowDownToLine, Eraser, Maximize2, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { ConsoleLine, ConsoleStream, InstanceDetailDto } from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useConsoleHistory, useInstanceMutations } from "@/api/instances";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { commandAllowed } from "@/lib/status";
import { cn } from "@/lib/utils";
import { uiSocket } from "@/ws/ui-socket";

const THEME = {
  background: "#0b0d12",
  foreground: "#e6e8ee",
  cursor: "#a78bfa",
  selectionBackground: "rgba(167,139,250,0.3)",
  black: "#1a1d26",
  brightBlack: "#5c6370",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#67e8f9",
  white: "#e6e8ee",
};

function stamp(at: number) {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `\x1b[90m${hh}:${mm}:${ss}\x1b[0m `;
}

/** Read-only xterm fed from the console history and the live socket, plus a command line. */
export function InstanceConsole({ instance }: { instance: InstanceDetailDto }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [stream, setStream] = useState<ConsoleStream>(
    instance.status === "installing" || instance.status === "install_failed"
      ? "install"
      : "console",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const historyQ = useConsoleHistory(instance.id, stream);
  const { command: send } = useInstanceMutations();
  const canCommand = roleAllows(instance.myRole, "command") && commandAllowed(instance.status);

  // Create the terminal once.
  useEffect(() => {
    const term = new XTerm({
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "underline",
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10_000,
      convertEol: true,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(hostRef.current!);
    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    fitRef.current?.fit();
  }, [fullscreen]);

  // History replaces the buffer whenever the stream changes or it is (re)fetched.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.reset();
    if (historyQ.data) {
      for (const l of historyQ.data) term.writeln(stamp(l.at) + l.text);
      if (historyQ.data.length === 0) {
        term.writeln("\x1b[90mNo output yet.\x1b[0m");
      }
    } else if (historyQ.error) {
      term.writeln(`\x1b[31m${errorMessage(historyQ.error)}\x1b[0m`);
    }
    term.scrollToBottom();
  }, [historyQ.data, historyQ.error]);

  // Live lines for the stream we are showing.
  useEffect(() => {
    return uiSocket.subscribeConsole(instance.id, (d) => {
      const term = termRef.current;
      if (!term || d.stream !== stream) return;
      for (const l of d.lines as ConsoleLine[]) term.writeln(stamp(l.at) + l.text);
    });
  }, [instance.id, stream]);

  // A fresh install run should be watched from the start.
  useEffect(() => {
    if (instance.status === "installing") setStream("install");
  }, [instance.status]);

  const submit = () => {
    const text = command.trim();
    if (!text || !canCommand) return;
    send.mutate({ id: instance.id, command: text }, {
      onError: (e) => toast.error(errorMessage(e)),
    });
    setHistory((h) => [text, ...h.filter((c) => c !== text)].slice(0, 100));
    setHistIdx(-1);
    setCommand("");
    termRef.current?.writeln(`\x1b[90m>\x1b[0m \x1b[35m${text}\x1b[0m`);
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        fullscreen && "fixed inset-0 z-50 bg-background p-3",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={stream} onValueChange={(v) => setStream(v as ConsoleStream)}>
          <TabsList>
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="install">Install output</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => termRef.current?.scrollToBottom()}
          aria-label="Scroll to bottom"
        >
          <ArrowDownToLine />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => termRef.current?.clear()}
          aria-label="Clear"
        >
          <Eraser />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFullscreen((f) => !f)}
          aria-label="Fullscreen"
        >
          <Maximize2 />
        </Button>
      </div>
      <div
        ref={hostRef}
        className={cn(
          "min-h-0 overflow-hidden rounded-md border bg-[#0b0d12] p-2",
          fullscreen ? "flex-1" : "h-[min(60vh,32rem)]",
        )}
      />
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="font-mono text-xs text-muted-foreground">&gt;</span>
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={canCommand
            ? "Type a console command and press Enter"
            : roleAllows(instance.myRole, "command")
            ? "The server is not running"
            : "You can watch the console but not send commands"}
          disabled={!canCommand}
          className="font-mono"
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              const idx = Math.min(history.length - 1, histIdx + 1);
              if (idx >= 0) {
                setHistIdx(idx);
                setCommand(history[idx]);
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const idx = histIdx - 1;
              setHistIdx(Math.max(-1, idx));
              setCommand(idx >= 0 ? history[idx] : "");
            }
          }}
        />
        <Button type="submit" size="sm" disabled={!canCommand || !command.trim()}>
          <SendHorizontal /> Send
        </Button>
      </form>
    </div>
  );
}
