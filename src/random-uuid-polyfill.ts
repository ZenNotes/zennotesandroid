/**
 * bootstrap.ts imports this first, so crypto.randomUUID exists before main.tsx
 * and the core it pulls in are even loaded: bootstrap reaches them through a
 * dynamic import. Android's oldest supported WebView (Chrome 92, which the
 * bundle's syntax needs) already has it, so this is a guard, as on the iPhone
 * for iOS 15.0 to 15.3: the core and this app's bridge route their own calls
 * through the getRandomValues fallback in bridge/uuid.ts, and this covers code
 * that calls crypto.randomUUID directly.
 */
import { installRandomUUIDPolyfill } from '@zennotes/portable-vault/uuid'

installRandomUUIDPolyfill()
