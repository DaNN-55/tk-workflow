const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readTaskIdArgument(args: string[]): string | null {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--task-id" || !uuidPattern.test(args[1])) {
    throw new Error("用法：worker:run [--task-id <UUID>]");
  }
  return args[1].toLowerCase();
}
