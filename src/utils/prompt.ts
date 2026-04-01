import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

export async function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`\n⚠️  ${question} [Y/n]: `);
  rl.close();

  const normalized = answer.trim().toLowerCase();
  // Default to 'yes' if the user just hits Enter
  return normalized === "" || normalized === "y";
}
