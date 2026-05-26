import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { Condition, RunResult, TokenUsage, ToolCall } from "./types.ts";
import { log } from "./util.ts";

const BINARY = process.env.CURSOR_BINARY ?? "agent";

interface ParsedStream {
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
}

export function parseStreamJson(jsonl: string): ParsedStream {
  const events = jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e !== null);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const toolCalls: ToolCall[] = [];
  let assistantTurns = 0;
  let finalResponse = "";
  let sessionId: string | undefined;

  for (const e of events) {
    if (e?.type === "assistant") {
      assistantTurns++;
      const content = e.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            finalResponse = block.text;
          }
        }
      }
    }

    if (e?.type === "result" && e?.usage) {
      usage.inputTokens += e.usage.inputTokens ?? 0;
      usage.outputTokens += e.usage.outputTokens ?? 0;
      usage.cacheReadTokens += e.usage.cacheReadTokens ?? 0;
      usage.cacheCreationTokens += e.usage.cacheWriteTokens ?? 0;
    }

    if (typeof e?.sessionId === "string") sessionId = e.sessionId;
    if (typeof e?.session_id === "string") sessionId = e.session_id;

    if (e?.type === "tool_call" && e?.subtype === "started") {
      const tc = e.tool_call ?? {};
      const ts = e.timestamp_ms ?? 0;

      if (tc.mcpToolCall) {
        const mcp = tc.mcpToolCall.args ?? tc.mcpToolCall;
        let server = mcp.providerIdentifier ?? mcp.serverName ?? "unknown";
        let tool = mcp.toolName ?? "unknown";
        if (server === "unknown" && typeof mcp.name === "string" && mcp.name.includes("-")) {
          const idx = mcp.name.indexOf("-");
          server = mcp.name.slice(0, idx);
          tool = mcp.name.slice(idx + 1);
        }
        toolCalls.push({
          name: `mcp__${server}__${tool}`,
          args: mcp.args ?? {},
          timestamp: ts,
          isMcp: true,
          mcpServer: server,
        });
      } else if (tc.shellToolCall) {
        toolCalls.push({ name: "Shell", args: tc.shellToolCall.args ?? {}, timestamp: ts, isMcp: false });
      } else if (tc.readToolCall) {
        toolCalls.push({ name: "Read", args: tc.readToolCall.args ?? {}, timestamp: ts, isMcp: false });
      } else if (tc.writeToolCall) {
        toolCalls.push({ name: "Write", args: tc.writeToolCall.args ?? {}, timestamp: ts, isMcp: false });
      } else if (tc.editToolCall || tc.strReplaceToolCall) {
        toolCalls.push({ name: "Edit", args: (tc.editToolCall ?? tc.strReplaceToolCall).args ?? {}, timestamp: ts, isMcp: false });
      } else if (tc.globToolCall) {
        toolCalls.push({ name: "Glob", args: tc.globToolCall.args ?? {}, timestamp: ts, isMcp: false });
      } else if (tc.grepToolCall) {
        toolCalls.push({ name: "Grep", args: tc.grepToolCall.args ?? {}, timestamp: ts, isMcp: false });
      } else if (tc.listDirToolCall) {
        toolCalls.push({ name: "ListDir", args: tc.listDirToolCall.args ?? {}, timestamp: ts, isMcp: false });
      }
    }
  }

  return { tokenUsage: usage, toolCalls, assistantTurns, finalResponse, sessionId };
}

export function mcpDisable(identifier: string): void {
  log(`Disabling MCP: ${identifier}`);
  execSync(`${BINARY} mcp disable ${identifier}`, { stdio: "pipe" });
}

export function worktreePath(repoPath: string, name: string): string {
  const repoName = path.basename(repoPath);
  return path.join(os.homedir(), ".cursor", "worktrees", repoName, name);
}

export function removeWorktree(repoPath: string, name: string): void {
  const wtPath = worktreePath(repoPath, name);
  try {
    execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoPath, stdio: "pipe" });
  } catch {
    try { execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" }); } catch {}
  }
}

export async function runCursor(opts: {
  prompt: string;
  repoPath: string;
  model: string;
  branch: string;
  condition: Condition;
  timeoutMs: number;
  outDir: string;
}): Promise<RunResult> {
  const suffix = randomBytes(4).toString("hex");
  const wtName = `${opts.condition}-${suffix}`;
  const jsonlPath = path.join(opts.outDir, `${opts.condition}.jsonl`);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--yolo",
    "--trust",
    "--model", opts.model,
    "--workspace", opts.repoPath,
    "--worktree", wtName,
    "--worktree-base", opts.branch,
    opts.prompt,
  ];

  const started = Date.now();

  const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const p = spawn(BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = fs.createWriteStream(jsonlPath);
    let partial = "";
    let toolCount = 0;
    let editCount = 0;
    let turnCount = 0;
    let thinkBuf = "";
    const tag = opts.condition;
    let killed = false;

    p.stdout.on("data", (chunk: Buffer) => {
      out.write(chunk);
      partial += chunk.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);

          if (e?.type === "thinking" && e?.subtype === "delta") {
            thinkBuf += e.text ?? "";
          } else if (e?.type === "thinking" && e?.subtype === "completed") {
            if (thinkBuf) {
              const trimmed = thinkBuf.trim().replace(/\s+/g, " ");
              log(`[${tag}] 💭 ${trimmed.slice(0, 200)}${trimmed.length > 200 ? "..." : ""}`);
              thinkBuf = "";
            }
          } else if (e?.type === "assistant") {
            turnCount++;
            const content = e.message?.content;
            let text = "";
            if (Array.isArray(content)) {
              for (const b of content) {
                if (b?.type === "text" && b.text) text += b.text;
              }
            }
            log(`[${tag}] 🗣️  Turn ${turnCount}: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
          } else if (e?.type === "tool_call" && e?.subtype === "started") {
            toolCount++;
            const tc = e.tool_call ?? {};
            let label = "";
            if (tc.mcpToolCall) {
              const mcp = tc.mcpToolCall.args ?? tc.mcpToolCall;
              const server = mcp.providerIdentifier ?? mcp.serverName ?? "";
              const tool = mcp.toolName ?? "";
              label = `MCP:${server}/${tool}`;
              const query = (mcp.args?.query as string) ?? "";
              if (query) label += ` "${query.slice(0, 80)}"`;
            } else if (tc.shellToolCall) {
              const cmd = tc.shellToolCall.args?.command ?? "";
              label = `Shell: ${cmd.slice(0, 100)}`;
            } else if (tc.editToolCall || tc.strReplaceToolCall) {
              editCount++;
              const ep = (tc.editToolCall ?? tc.strReplaceToolCall)?.args?.path ?? "";
              label = `✏️  Edit #${editCount}: ...${ep.slice(-60)}`;
            } else if (tc.readToolCall) {
              const rp = tc.readToolCall.args?.path ?? "";
              label = `Read: ...${rp.slice(-60)}`;
            } else if (tc.grepToolCall) {
              label = `Grep: ${tc.grepToolCall.args?.pattern?.slice(0, 80) ?? ""}`;
            } else if (tc.globToolCall) {
              label = `Glob: ${tc.globToolCall.args?.globPattern ?? ""}`;
            }
            if (label) log(`[${tag}]   #${toolCount} ${label}`);

            if (opts.condition === "baseline" && !killed) {
              const tc = e.tool_call ?? {};
              const isUnblockedMcp = tc.mcpToolCall &&
                ((tc.mcpToolCall.args?.providerIdentifier ?? tc.mcpToolCall.args?.serverName ?? tc.mcpToolCall.providerIdentifier ?? tc.mcpToolCall.serverName ?? "")
                  .toLowerCase().includes("unblocked"));
              const isUnblockedCli = tc.shellToolCall &&
                /^unblocked\s+context[_-]/.test(tc.shellToolCall.args?.command ?? "");
              if (isUnblockedMcp || isUnblockedCli) {
                log(`[${tag}] ⛔ CONTAMINATION: baseline called Unblocked — killing run`);
                killed = true;
                p.kill("SIGTERM");
                setTimeout(() => p.kill("SIGKILL"), 5_000);
              }
            }
          } else if (e?.type === "tool_call" && e?.subtype === "completed") {
            const tc = e.tool_call ?? {};
            if (tc.shellToolCall?.result?.success) {
              const out = tc.shellToolCall.result.success.stdout ?? "";
              if (out) log(`[${tag}]   ↳ ${out.trim().slice(0, 150)}`);
            } else if (tc.globToolCall?.result?.success) {
              const files = tc.globToolCall.result.success.files ?? [];
              log(`[${tag}]   ↳ ${files.length} files: ${files.map((f: string) => f.split("/").pop()).join(", ").slice(0, 120)}`);
            } else if (tc.grepToolCall?.result?.success) {
              const matches = tc.grepToolCall.result.success.numMatches ?? tc.grepToolCall.result.success.matches?.length ?? "?";
              log(`[${tag}]   ↳ ${matches} matches`);
            }
          }
        } catch {}
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5_000);
    }, opts.timeoutMs);

    p.stderr.on("data", (d: Buffer) => process.stderr.write(`[cursor:${opts.condition}] ${d}`));

    p.on("close", (code) => {
      clearTimeout(timer);
      out.end();
      resolve({ exitCode: code, timedOut });
    });

    p.on("error", reject);
  });

  const jsonl = fs.readFileSync(jsonlPath, "utf8");
  const parsed = parseStreamJson(jsonl);

  return {
    durationMs: Date.now() - started,
    tokenUsage: parsed.tokenUsage,
    toolCalls: parsed.toolCalls,
    assistantTurns: parsed.assistantTurns,
    finalResponse: parsed.finalResponse,
    sessionId: parsed.sessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    jsonlPath,
    worktreeName: wtName,
  };
}
