import { createInterface } from "node:readline";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(`${question}${suffix}`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}
