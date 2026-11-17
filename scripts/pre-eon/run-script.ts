// scripts/pre-eon/run-script.ts
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./sitting-lib.js";

export interface ScriptRun {
  code: number;
  /**
   * Unredacted, and for the caller's memory only: the setup command's output
   * carries the grant issuer's secret, which the caller reads out of it.
   */
  text: string;
}

export interface RunScriptOptions {
  /** Where the step's log goes, as <label>.log. */
  folder: string;
  label: string;
  script: string;
  args: string[];
  env?: Record<string, string>;
  /** Read at each line, not copied, so a secret learned while the script runs is hidden from then on. */
  secrets: readonly string[];
  /** Called with each redacted line; omitted for a step whose lines are only logged. */
  show?: (line: string) => void;
}

/**
 * Runs one of the repo's own scripts in a single node process, with no shell
 * between, so stopping it stops the script and not a wrapper around it. Every
 * line is logged and shown with secrets removed; the text returned is not.
 */
export function runScript(options: RunScriptOptions): Promise<ScriptRun> {
  const logFile = join(options.folder, `${options.label}.log`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", options.script, ...options.args], {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    const emit = (line: string): void => {
      text += `${line}\n`;
      const shown = redactSecrets(line, options.secrets);
      appendFileSync(logFile, `${shown}\n`);
      options.show?.(shown);
    };
    const flushers: Array<() => void> = [];
    // One buffer per stream: a chunk can end in the middle of a line, and a line
    // redacted in two halves would show the half of a secret that fell in each.
    const sink = (): ((chunk: Buffer) => void) => {
      let pending = "";
      flushers.push(() => {
        if (pending.length > 0) emit(pending);
        pending = "";
      });
      return (chunk) => {
        pending += chunk.toString("utf8");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) emit(line);
      };
    };
    child.stdout.on("data", sink());
    child.stderr.on("data", sink());
    child.on("close", (code) => {
      for (const flush of flushers) flush();
      resolve({ code: code ?? 1, text });
    });
  });
}
