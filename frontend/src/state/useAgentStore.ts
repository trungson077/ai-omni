import { create } from 'zustand'
import type { AgentState, Message } from '../core/types'

interface AgentStore {
  state: AgentState
  messages: Message[]
  /** Live partial transcript from the mic, before it's committed. */
  interim: string
  setState: (s: AgentState) => void
  setInterim: (s: string) => void
  addMessage: (m: Message) => void
  appendToken: (id: string, text: string) => void
  endMessage: (id: string) => void
  clear: () => void
}

export const useAgentStore = create<AgentStore>((set) => ({
  state: 'idle',
  messages: [],
  interim: '',
  setState: (state) => set({ state }),
  setInterim: (interim) => set({ interim }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  appendToken: (id, text) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)),
    })),
  endMessage: (id) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
    })),
  clear: () => set({ messages: [], interim: '' }),
}))
