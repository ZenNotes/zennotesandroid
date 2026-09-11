export interface PasteContext { vault: object; editor: object; document: object; path: string; from: number; to: number }
export async function runImagePaste<T, R>(options: {
  current: () => PasteContext | null;
  read: () => Promise<T>;
  save: (context: PasteContext, image: T) => Promise<R>;
  insert: (context: PasteContext, asset: R) => void;
}): Promise<void> {
  const context = options.current()
  if (!context) throw new Error('Open an editable note before pasting an image.')
  const unchanged = (): boolean => {
    const current = options.current()
    return current !== null && current.vault === context.vault && current.editor === context.editor &&
      current.document === context.document && current.path === context.path &&
      current.from === context.from && current.to === context.to
  }
  const image = await options.read()
  if (!unchanged()) throw new Error('The note or cursor changed. Please paste the image again.')
  const asset = await options.save(context, image)
  if (!unchanged()) throw new Error('The image was saved in assets, but the note changed. Insert it from the vault assets.')
  options.insert(context, asset)
}
