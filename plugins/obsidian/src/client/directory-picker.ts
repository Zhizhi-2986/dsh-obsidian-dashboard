/** Select a directory through the DSH Desktop chooser when available. */
export async function pickDirectory(
  desktop: { pick(): Promise<string | null> } | undefined,
  workspace: { pickDirectory(): Promise<string | null> } | undefined,
): Promise<string | null> {
  if (desktop) return desktop.pick()
  if (workspace) return workspace.pickDirectory()
  throw new Error('Directory selection is unavailable')
}
