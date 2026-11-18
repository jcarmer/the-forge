export const MAX_CAT_BYTES: number;
export const MAX_HEAD_TAIL_LINES: number | undefined;
export function checkBashCommand(command: string | undefined, cwd?: string, env?: Record<string, string | undefined>): string | null;

