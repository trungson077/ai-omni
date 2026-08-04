import { useAgentStore } from '../state/useAgentStore'
import { usePaneStore } from '../state/usePaneStore'
import { toast } from '../state/useToastStore'
import { on, uid } from './bus'

/**
 * The only place bus events touch application state.
 *
 * Keeping this translation in one function is what let the scripted agent be
 * swapped for a live backend: the new source emits the same events, and this
 * file barely changed.
 *
 * Note what is *absent* — there is no `speak()` here any more. The server owns
 * text-to-speech now, so also calling the browser's synthesiser on `agent.done`
 * would have Nova answering in two voices at once.
 */
export function installBridge() {
  return on((e) => {
    const agent = useAgentStore.getState()
    const panes = usePaneStore.getState()

    switch (e.t) {
      case 'agent.state':
        agent.setState(e.state)
        break

      case 'agent.message':
        agent.addMessage({
          id: e.id ?? uid('msg'),
          role: e.role,
          text: e.text,
          at: Date.now(),
          streaming: e.role === 'nova' && e.text === '',
        })
        if (e.role === 'user') agent.setInterim('')
        break

      case 'agent.token':
        agent.appendToken(e.id, e.text)
        break

      case 'agent.done':
        agent.endMessage(e.id)
        break

      case 'pane.spawn':
        panes.spawn({
          id: e.id,
          kind: e.kind,
          title: e.title,
          payload: e.payload,
          originPaneId: e.originPaneId,
          ttl: e.ttl,
          size: e.size,
          pinned: e.pinned,
        })
        break

      case 'pane.update':
        panes.update(e.id, e.payload, e.title, e.ttl)
        break

      case 'pane.close':
        panes.close(e.id)
        break

      case 'toast':
        // Deliberately not a pane. A notice is not something you work with, so
        // it does not get a solver slot, a tether, or a place in the deck.
        toast(e.text, { detail: e.detail, tone: e.tone })
        break
    }
  })
}
