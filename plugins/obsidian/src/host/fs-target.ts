import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

/** Use DSH's containment API; FsTarget.targetKey is opaque, not an inode identity. */
export async function resolveContainedFsTarget(context: Context, sourcePath: string, absolutePath: string): Promise<FsTarget | null> {
  const sourceTarget = await context.fs.resolve(sourcePath)
  const target = await context.fs.resolve(absolutePath)
  return context.fs.contains(sourceTarget, target) ? target : null
}
