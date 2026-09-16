import { Capacitor } from '@capacitor/core'
// Included only by the isolated native-validation build, never by index.html.
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { getShellSnapshot } from '@zennotes/app-core/shell'
import { getWorkspaceSnapshot, openLocalVault, flushWorkspace, persistWorkspace } from '@zennotes/app-core/workspace'
import { openNote } from '@zennotes/app-core/navigation'
import { runEditorCommand, captureEditorInsertion, attachFiles } from '@zennotes/app-core/editor'
import { requestRenameNote, requestTrashNote, restoreNote } from '@zennotes/app-core/notes'
import { refreshTasks, getTasksSnapshot } from '@zennotes/app-core/tasks'
import { VAULT_ROOT_PREFIX, renameVault } from '../src/bridge/mobile-bridge'
import { captureMobileWorkspace } from '../src/ui-mobile/workspace-context'
import { captureAssetImporter } from '../src/ui-mobile/editor-host'

const checks: string[] = []
const vaultName = 'Boundary package validation ' + Date.now()
const key = 'zn:isolated-boundary-validation'
const exact = '# Boundary runtime\n\nExact café 日本語.  \n- [ ] Native task\n'
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => unknown | Promise<unknown>, label: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (await predicate()) return; await wait(80) }
  throw new Error('Timed out: ' + label)
}
function check(value: unknown, label: string) { if (!value) throw new Error(label); checks.push(label) }
async function report(status: string, error?: unknown) {
  const result = {status, checks, error: error instanceof Error ? {message:error.message,stack:error.stack} : error, app: window.zen.getAppInfo(), at: new Date().toISOString()}
  await Filesystem.writeFile({directory: Capacitor.getPlatform() === 'android' ? Directory.Data : Directory.Documents, path:'boundary-validation.json', data:JSON.stringify(result,null,2), encoding:Encoding.UTF8})
  console.log('BOUNDARY_VALIDATION', JSON.stringify(result))
}
async function confirmAction(pending: Promise<string>, label: string) {
  await until(() => document.querySelector('.z-modal'), label + ' dialog')
  const button = [...document.querySelectorAll<HTMLButtonElement>('.z-modal button')].find(button => button.textContent?.trim() === label)
  if (!button) throw new Error('Missing action button: ' + label)
  button.click()
  check(await pending === 'completed', label + ' completed through public action')
}
async function run() {
  // Exercise native onboarding rather than setting private core preferences.
  const onboarding = window.setInterval(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.zn-onboard button')]
    buttons.find(button => /^(Get started|Start writing|On this iPhone|On this iPad)/.test(button.textContent ?? ''))?.click()
  }, 150)
  try { await until(() => getShellSnapshot().workspaceRestored, 'native workspace restoration') }
  finally { clearInterval(onboarding) }
  await wait(500)
  const saved = localStorage.getItem(key)
  if (saved) {
    const expected = JSON.parse(saved)
    check(getShellSnapshot().vault?.name === expected.vaultName, 'cold launch retains isolated native vault')
    check(getShellSnapshot().selectedPath === expected.path, 'cold launch restores selected note')
    check((await window.zen.readNote(expected.path)).body === expected.body, 'cold launch retains exact saved bytes')
    await report('restart-passed'); return
  }
  await openLocalVault(VAULT_ROOT_PREFIX + vaultName)
  check(getShellSnapshot().vault?.name === vaultName && !getWorkspaceSnapshot().transitioning, 'public vault switch reaches native storage')
  const note = await window.zen.createNote('inbox','Boundary runtime')
  await window.zen.writeNote(note.path, '')
  await until(() => getShellSnapshot().notes.some(item => item.path === note.path), 'native note index')
  await openNote(note.path,{mode:'edit'})
  await until(() => document.querySelector('.cm-content'), 'native editor')
  const content = document.querySelector<HTMLElement>('.cm-content')!
  check(content.getAttribute('autocorrect') === 'on' && content.getAttribute('spellcheck') === 'true', 'native typing configured before focus')
  content.focus()
  document.execCommand('insertText',false,exact)
  await until(async () => (await window.zen.readNote(note.path)).body === exact, 'exact native editor save')
  check(true, 'editor saves exact Unicode and trailing whitespace through native filesystem')
  check(runEditorCommand('open-search'), 'public toolbar opens native editor search')
  check(runEditorCommand('close-search'), 'public toolbar closes native editor search')
  await refreshTasks()
  check(getTasksSnapshot().tasks.some(task => task.sourcePath === note.path && task.content === 'Native task'), 'native task scan uses shared task model')
  const importer = captureAssetImporter()
  const insertion = importer && captureEditorInsertion(importer)
  check(insertion, 'native attachment context captured')
  const result = await attachFiles(insertion!,[new File(['native attachment bytes'],'boundary.txt',{type:'text/plain'})])
  check(result.status === 'inserted', 'public attachment inserts into native editor')
  check(atob(await window.zen.readVaultAssetBase64(result.assets[0].path)) === 'native attachment bytes', 'native attachment bytes preserved')
  await flushWorkspace()
  const attachedBody = (await window.zen.readNote(note.path)).body
  await window.zen.writeNoteComments(note.path,[{notePath:note.path,anchorStart:0,anchorEnd:1,anchorText:'#',body:'Native discussion'}])
  const renamed = requestRenameNote(captureMobileWorkspace(),note.path)
  await until(() => document.querySelector('.z-modal input'), 'rename prompt')
  const input = document.querySelector<HTMLInputElement>('.z-modal input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Boundary renamed')
  input.dispatchEvent(new Event('input',{bubbles:true}))
  await wait(50)
  await confirmAction(renamed,'Rename')
  const renamedPath = getShellSnapshot().selectedPath!
  check(renamedPath.endsWith('Boundary renamed.md'), 'native canonical rename reconciles editor')
  const renamedBody = (await window.zen.readNote(renamedPath)).body
  check(renamedBody === (attachedBody.startsWith('# Boundary runtime') ? attachedBody.replace('# Boundary runtime','# Boundary renamed') : attachedBody), 'native rename preserves bytes and follows leading-title rule')
  check((await window.zen.readNoteComments(renamedPath))[0]?.body === 'Native discussion', 'native rename retains comments')
  await confirmAction(requestTrashNote(captureMobileWorkspace(),renamedPath),'Move to Trash')
  const trashed = (await window.zen.listNotes()).find(item => item.folder === 'trash' && item.title === 'Boundary renamed')!
  check(trashed, 'native trash returns canonical destination')
  check(await restoreNote(captureMobileWorkspace(),trashed.path) === 'completed','public restore completes on native storage')
  const restored = (await window.zen.listNotes()).find(item => item.folder === 'inbox' && item.title === 'Boundary renamed')!
  check((await window.zen.readNote(restored.path)).body === renamedBody && (await window.zen.readNoteComments(restored.path))[0]?.body === 'Native discussion','native trash and restore retain exact body and comments')
  await openNote(restored.path,{mode:'edit'})
  await flushWorkspace(); persistWorkspace(); await wait(800)
  const previousHost = captureMobileWorkspace()
  const relocatedName = vaultName + ' renamed'
  await renameVault({root:VAULT_ROOT_PREFIX+vaultName,name:vaultName,tier:'local'}, relocatedName)
  check(getShellSnapshot().vault?.name === relocatedName && !getWorkspaceSnapshot().transitioning, 'native vault rename reopens within shared transition')
  check(!previousHost.isCurrent(), 'vault relocation invalidates captured native gestures')
  check((await window.zen.readNote(restored.path)).body === renamedBody && (await window.zen.readNoteComments(restored.path))[0]?.body === 'Native discussion', 'vault rename retains exact notes and comments')
  await openNote(restored.path,{mode:'edit'})
  await flushWorkspace(); persistWorkspace(); await wait(800)
  localStorage.setItem(key,JSON.stringify({path:restored.path,body:renamedBody,vaultName:relocatedName}))
  await report('passed-awaiting-restart')
}
void run().catch(error=>report('failed',error))
