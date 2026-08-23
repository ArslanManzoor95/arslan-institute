/** Tiny leveled logger. Everything goes to stderr so stdout stays pipeable. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold: number =
  LEVELS[(process.env.PRESSROOM_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const line = `${stamp} ${level.padEnd(5)} ${msg}`;
  if (extra === undefined) process.stderr.write(line + "\n");
  else process.stderr.write(`${line} ${format(extra)}\n`);
}

function format(extra: unknown): string {
  if (extra instanceof Error) return `${extra.message}`;
  if (typeof extra === "string") return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
  /** A step heading, so a long run reads like a run sheet. */
  step: (m: string) => emit("info", `\n── ${m}`),
};
