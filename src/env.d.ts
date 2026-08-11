/// <reference types="vite/client" />
import type { ZenBridge } from '@zennotes/bridge-contract/bridge'

interface ImportMetaEnv {
  readonly VITE_ZENNOTES_CLOUD_DEV_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    zen: ZenBridge
  }
}

export {}
