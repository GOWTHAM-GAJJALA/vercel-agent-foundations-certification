import { Sandbox } from "@vercel/sandbox";

/**
 * The admin agent's persistent Vercel Sandbox.
 *
 * One named sandbox holds both the agent's memory file and the store data it
 * analyzes, so computation and memory share the same environment. Sandboxes
 * are persistent by default: when a session stops (timeout or explicit stop),
 * the filesystem is snapshotted and restored on the next `Sandbox.get`.
 *
 * Nothing secret ever goes into the sandbox: store data is fetched by the
 * application (which holds BYPASS_SECRET) and written in as plain JSON files.
 * Commands run in an isolated microVM, never on the app server.
 */

const SANDBOX_NAME = process.env.ADMIN_SANDBOX_NAME || "ship-shop-admin";
// Hobby plans allow sessions of up to 45 minutes.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export const SANDBOX_ROOT = "/vercel/sandbox";
export const MEMORY_PATH = `${SANDBOX_ROOT}/memory/MEMORY.md`;
export const DATA_DIR = `${SANDBOX_ROOT}/data`;

const MAX_OUTPUT_CHARS = 8000;

export async function getAdminSandbox(): Promise<Sandbox> {
  try {
    return await Sandbox.get({ name: SANDBOX_NAME });
  } catch {
    try {
      const sandbox = await Sandbox.create({
        name: SANDBOX_NAME,
        timeout: SESSION_TIMEOUT_MS,
      });
      await sandbox.runCommand("mkdir", ["-p", `${SANDBOX_ROOT}/memory`, DATA_DIR]);
      return sandbox;
    } catch (createError) {
      // Another request may have created it first.
      try {
        return await Sandbox.get({ name: SANDBOX_NAME });
      } catch {
        throw createError;
      }
    }
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} more characters truncated)`,
    truncated: true,
  };
}

export type BashResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};

/** Runs a bash command in the admin sandbox, starting in the sandbox root. */
export async function runBash(command: string): Promise<BashResult> {
  const sandbox = await getAdminSandbox();
  const startedAt = Date.now();
  await sandbox.runCommand("mkdir", ["-p", `${SANDBOX_ROOT}/memory`, DATA_DIR]);
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", command],
    cwd: SANDBOX_ROOT,
    signal: AbortSignal.timeout(90_000),
  });
  const stdout = truncate(await result.stdout());
  const stderr = truncate(await result.stderr());
  return {
    command,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    durationMs: Date.now() - startedAt,
  };
}

/** Writes a JSON data file into the sandbox; returns its absolute path. */
export async function writeDataFile(name: string, data: unknown): Promise<string> {
  const sandbox = await getAdminSandbox();
  const path = `${DATA_DIR}/${name}.json`;
  await sandbox.runCommand("mkdir", ["-p", DATA_DIR]);
  await sandbox.writeFiles([
    { path, content: Buffer.from(JSON.stringify(data, null, 2)) },
  ]);
  return path;
}

/** Reads the memory file. Returns "" when no memory has been saved yet. */
export async function readMemory(): Promise<string> {
  const sandbox = await getAdminSandbox();
  const buffer = await sandbox.readFileToBuffer({ path: MEMORY_PATH });
  return buffer ? buffer.toString("utf8") : "";
}

/** Appends one dated entry to the memory file and returns the new contents. */
export async function appendMemory(entry: string): Promise<string> {
  const sandbox = await getAdminSandbox();
  const existing = await readMemory();
  const header = existing.trim() ? "" : "# Admin agent memory\n\n";
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${entry.trim().replace(/\s+/g, " ")}\n`;
  const next = `${existing}${header}${line}`;
  await sandbox.runCommand("mkdir", ["-p", `${SANDBOX_ROOT}/memory`]);
  await sandbox.writeFiles([{ path: MEMORY_PATH, content: Buffer.from(next) }]);
  return next;
}
