/** Opens a file in the user's editor (`$VISUAL`, `$EDITOR`, else vi). False when it failed. */
export async function openEditor(path: string): Promise<boolean> {
  const editor = (process.env.VISUAL || process.env.EDITOR || "vi").split(/\s+/).filter(Boolean);
  const proc = Bun.spawn([...editor, path], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) === 0;
}
