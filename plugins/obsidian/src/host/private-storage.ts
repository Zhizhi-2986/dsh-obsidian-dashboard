import { constants, promises as fs } from 'node:fs'
import { chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const target = path.resolve(directory)
  await rejectExistingSymlinkDirectory(target)
  await fs.mkdir(target, { recursive: true, mode: PRIVATE_DIR_MODE })
  const before = await fs.lstat(target)
  if (!before.isDirectory() || before.isSymbolicLink()) throw invalidStorageDirectoryError()
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    handle = await fs.open(target, flags)
  } catch (error) {
    if (isLinkOrNotDirectory(error)) throw invalidStorageDirectoryError()
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidStorageDirectoryError()
    await handle.chmod(PRIVATE_DIR_MODE)
  } finally {
    await handle.close()
  }
}

export async function ensurePrivateFile(file: string): Promise<void> {
  let fileInfo
  try {
    fileInfo = await fs.lstat(file)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw invalidStorageFileError()
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    handle = await fs.open(file, flags)
  } catch (error) {
    if (isLinkOrNotDirectory(error)) throw invalidStorageFileError()
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== fileInfo.dev || opened.ino !== fileInfo.ino) throw invalidStorageFileError()
    await handle.chmod(PRIVATE_FILE_MODE)
  } finally {
    await handle.close()
  }
}

export async function writePrivateFile(file: string, content: string): Promise<void> {
  await ensurePrivateDirectory(path.dirname(file))
  await ensurePrivateFile(file)
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
    handle = await fs.open(temporary, flags, PRIVATE_FILE_MODE)
    if (process.platform !== 'win32') await handle.chmod(PRIVATE_FILE_MODE)
    await handle.writeFile(content, 'utf8')
    await handle.close()
    handle = undefined
    await fs.rename(temporary, file)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function ensurePrivateDirectorySync(directory: string): void {
  const target = path.resolve(directory)
  rejectExistingSymlinkDirectorySync(target)
  mkdirSync(target, { recursive: true, mode: PRIVATE_DIR_MODE })
  const before = lstatSync(target)
  if (!before.isDirectory() || before.isSymbolicLink()) throw invalidStorageDirectoryError()
  if (process.platform === 'win32') return
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  let descriptor: number
  try {
    descriptor = openSync(target, flags)
  } catch (error) {
    if (isLinkOrNotDirectory(error)) throw invalidStorageDirectoryError()
    throw error
  }
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidStorageDirectoryError()
    fchmodSync(descriptor, PRIVATE_DIR_MODE)
  } finally {
    closeSync(descriptor)
  }
}

export function ensurePrivateFileSync(file: string): void {
  if (process.platform === 'win32') {
    try {
      if (!lstatSync(file).isFile()) throw invalidStorageFileError()
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    return
  }
  ensurePrivateDirectorySync(path.dirname(file))
  const noFollow = constants.O_NOFOLLOW ?? 0
  let descriptor: number
  try {
    descriptor = openSync(file, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      if (isLinkOrNotDirectory(error)) throw invalidStorageFileError()
      throw error
    }
    try {
      descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, PRIVATE_FILE_MODE)
    } catch (createError) {
      if (errorCode(createError) === 'EEXIST') return ensurePrivateFileSync(file)
      if (isLinkOrNotDirectory(createError)) throw invalidStorageFileError()
      throw createError
    }
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw invalidStorageFileError()
    fchmodSync(descriptor, PRIVATE_FILE_MODE)
  } finally {
    closeSync(descriptor)
  }
}

async function rejectExistingSymlinkDirectory(target: string): Promise<void> {
  try {
    const info = await fs.lstat(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidStorageDirectoryError()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function rejectExistingSymlinkDirectorySync(target: string): void {
  try {
    const info = lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidStorageDirectoryError()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function invalidStorageDirectoryError(): Error & { code: string } {
  return Object.assign(new Error('private storage directory must not be a symlink'), { code: 'FS_INVALID_STORAGE_DIRECTORY' })
}

function invalidStorageFileError(): Error & { code: string } {
  return Object.assign(new Error('private storage path must be a regular file'), { code: 'FS_INVALID_STORAGE_FILE' })
}

function isLinkOrNotDirectory(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ELOOP' || code === 'ENOTDIR'
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
