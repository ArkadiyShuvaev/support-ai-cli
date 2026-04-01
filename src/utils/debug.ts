import * as readline from 'readline';

const GRAY = '\x1b[90m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

export function isDebugMode(): boolean {
  return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
}

export function debugLog(message: string): void {
  if (!isDebugMode()) return;
  console.log(`${GRAY}[debug] ${message}${RESET}`);
}

/**
 * Pauses execution in debug mode with an optional Y/n confirmation.
 * - Without `confirm`: waits for Enter, always returns true.
 * - With `confirm: true`: asks [Y/n], returns false if the operator aborts.
 */
export function debugPause(label: string, confirm?: true): Promise<boolean> {
  if (!isDebugMode()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const prompt = confirm
      ? `${YELLOW}[debug] ── ${label} ── Continue? [Y/n]: ${RESET}`
      : `${YELLOW}[debug] ── ${label} ── Press Enter to continue...${RESET}`;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(!confirm || answer.trim().toLowerCase() !== 'n');
    });
  });
}
