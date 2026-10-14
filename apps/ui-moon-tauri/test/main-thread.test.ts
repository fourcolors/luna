/**
 * Feature: the Main chat is a fixed go-to thread, not "whatever is open".
 * resolveMainThreadId is the pure rule; the DOM behavior is covered in
 * chat-window.test.ts ("Feature: Thread drawer").
 */
import { describe, it, expect } from 'vitest'
import { resolveMainThreadId } from '../frontend-react/src/chat/threadList'

const rows = [
  { id: 'new', title: 'New', lastMessageAt: 300 },
  { id: 'agent', title: 'Agent', lastMessageAt: 400, agentName: 'advisor' },
  { id: 'old', title: 'Old', lastMessageAt: 100 },
] as never[]

describe('resolveMainThreadId', () => {
  it('keeps the stored Main chat while it exists, whatever is open', () => {
    expect(resolveMainThreadId(rows, 'old', 'new')).toBe('old')
  })

  it('keeps the stored id when no thread list has loaded yet', () => {
    expect(resolveMainThreadId([], 'old', null)).toBe('old')
    expect(resolveMainThreadId(null, null, null)).toBeNull()
  })

  it('adopts the open chat on first run when it is a general chat', () => {
    expect(resolveMainThreadId(rows, null, 'old')).toBe('old')
  })

  it('prefers the newest general chat over an open agent chat', () => {
    expect(resolveMainThreadId(rows, null, 'agent')).toBe('new')
  })

  it('replaces a stored Main chat that was archived or deleted', () => {
    expect(resolveMainThreadId(rows, 'gone', null)).toBe('new')
  })

  it('falls back to an agent chat only when no general chat exists', () => {
    const onlyAgents = [{ id: 'x', agentName: 'a', lastMessageAt: 1 }] as never[]
    expect(resolveMainThreadId(onlyAgents, null, null)).toBe('x')
  })
})
