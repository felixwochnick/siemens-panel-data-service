import { ConfirmModal } from '#components'

export interface ConfirmModalOptions {
  title?: string
  question?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

/** Öffnet einen Bestätigungsdialog und liefert true, wenn bestätigt wurde */
export function useConfirmModal() {
  const overlay = useOverlay()

  return (options: ConfirmModalOptions): Promise<boolean> => {
    const modal = overlay.create(ConfirmModal, { destroyOnClose: true, props: options })
    return modal.open().then(result => result === true)
  }
}
