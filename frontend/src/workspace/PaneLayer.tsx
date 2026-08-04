import { usePaneStore } from '../state/usePaneStore'
import { REGISTRY } from '../panes/registry'
import { Pane } from './Pane'

export function PaneLayer() {
  const panes = usePaneStore((s) => s.panes)
  return (
    <>
      {panes.map((p) => {
        const Body = REGISTRY[p.kind]
        return (
          <Pane key={p.id} pane={p}>
            <Body id={p.id} payload={p.payload} />
          </Pane>
        )
      })}
    </>
  )
}
