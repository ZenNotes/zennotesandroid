/** The only native failures sync may interpret as a verified missing path. */
export function isNotFoundError(error: unknown): boolean {
  const candidate = error as { code?: unknown }
  return candidate?.code === 'OS-PLUG-FILE-0008' || candidate?.code === 'ZN-SAF-NOT-FOUND'
}
