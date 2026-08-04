import type { ComponentType } from 'react'
import type { PaneKind } from '../core/types'
import { ChatPane } from '../chat/ChatPane'
import { CameraPane } from './CameraPane'
import { MediaPane } from './MediaPane'
import { ResultPane } from './ResultPane'
import { ConfirmPane, DeckPane, SystemPane } from './kinds'
import type { KindProps } from './kinds'

export const REGISTRY: Record<PaneKind, ComponentType<KindProps>> = {
  chat: ChatPane,
  result: ResultPane,
  media: MediaPane,
  camera: CameraPane,
  system: SystemPane,
  confirm: ConfirmPane,
  deck: DeckPane,
}
