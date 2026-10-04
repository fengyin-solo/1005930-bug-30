import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 事务式提交：调用方拿到全量快照做修改，要么整笔写进去，要么抛错并保持原缓存不动。
// 纯前端没有数据库事务，用「先在草稿上改、最后一次写盘」模拟：写不进去就整体回退，
// 绝不让指令与电站台账落在两个版本上。
export function commitAll(mutate: (snapshot: Record<string, EntryRow[]>) => void): void {
  const snapshot = clone(allRows())
  mutate(snapshot)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写盘成功，再换内存缓存：持久化这步抛错时缓存仍是旧数据，等于回滚。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }
  cache = snapshot
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
