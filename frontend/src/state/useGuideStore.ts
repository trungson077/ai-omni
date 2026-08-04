import { create } from 'zustand'
import type { Guide } from '../workspace/snapping'

interface GuideState {
  guides: Guide[]
  set: (g: Guide[]) => void
}

/**
 * Kept out of usePaneStore on purpose: snap guides change mid-drag, and
 * writing them into the pane store would re-render every pane on the canvas.
 * Only <SnapGuides/> subscribes here.
 */
export const useGuideStore = create<GuideState>((set) => ({
  guides: [],
  set: (guides) =>
    set((s) => {
      // Only commit when the guide set actually changes — crossing a snap
      // line, not every pointermove.
      if (
        s.guides.length === guides.length &&
        s.guides.every((g, i) => g.axis === guides[i].axis && g.at === guides[i].at)
      ) {
        return s
      }
      return { guides }
    }),
}))
