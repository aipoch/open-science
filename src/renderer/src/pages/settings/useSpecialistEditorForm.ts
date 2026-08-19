import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { CreateSpecialistInput, SpecialistProfileView } from '../../../../shared/specialist'
import {
  CREATE_SPECIALIST_DRAFT_KEY,
  useSpecialistStore,
  type SpecialistEditorFormDraft
} from '@/stores/specialist-store'

// Seeds a form from a stored profile. Used both at mount (edit mode) and after an
// explicit Reload following a revision conflict.
export const formFromProfile = (profile: SpecialistProfileView): SpecialistEditorFormDraft => ({
  id: profile.id,
  name: profile.displayName ?? profile.name,
  packageVersion: profile.packageVersion ?? '0.1.0',
  description: profile.description,
  systemPrompt: profile.systemPrompt,
  iconKey: profile.iconKey ?? 'brain',
  colorKey: profile.colorKey ?? 'purple',
  capabilityMode: profile.capabilityMode,
  excludedSkillIds: profile.fullAccess.excludedSkillIds,
  selectedSkillIds: profile.selectedCapabilities.skillIds,
  excludedConnectorIds: profile.fullAccess.excludedConnectorIds,
  connectorIds: profile.selectedCapabilities.connectorIds,
  // Pin base revision so concurrent remote writes do not silently refresh it.
  // Only a successful save or an explicit Reload may update it.
  baseRevision: profile.revision
})

export const formFromCreateInput = (
  input: CreateSpecialistInput | undefined
): SpecialistEditorFormDraft => ({
  id: input?.id ?? '',
  name: input?.name ?? '',
  packageVersion: '0.1.0',
  description: input?.description ?? '',
  systemPrompt: input?.systemPrompt ?? '',
  iconKey: input?.iconKey ?? 'brain',
  colorKey: input?.colorKey ?? 'purple',
  capabilityMode: input?.capabilityMode ?? 'full',
  excludedSkillIds: input?.fullAccess?.excludedSkillIds ?? [],
  selectedSkillIds: input?.selectedCapabilities?.skillIds ?? [],
  excludedConnectorIds: input?.fullAccess?.excludedConnectorIds ?? [],
  connectorIds: input?.selectedCapabilities?.connectorIds ?? [],
  baseRevision: 0
})

type UseSpecialistEditorFormOptions = {
  editSpecialist?: SpecialistProfileView
  initialInput?: CreateSpecialistInput
}

export type SpecialistEditorFormState = {
  form: SpecialistEditorFormDraft
  setForm: Dispatch<SetStateAction<SpecialistEditorFormDraft>>
  idTouched: boolean
  setIdTouched: Dispatch<SetStateAction<boolean>>
  activeCapTab: 'skills' | 'connectors'
  setActiveCapTab: Dispatch<SetStateAction<'skills' | 'connectors'>>
  // Removes the stored draft so a later remount starts clean. Call after anything
  // that settles the form: a successful save or an explicit cancel.
  clearDraft: () => void
  // Flags the next form change (the post-save baseRevision advance) to skip the
  // draft write so a successful save's clearDraft is not immediately undone.
  suppressNextDraftWrite: () => void
}

// Owns the specialist editor's form state machine: mount-time seeding (profile,
// create prefill, or restorable draft), and the unsaved-form draft kept in the
// specialist store so any unmount loses nothing. The editor only consumes the
// returned state and setters; persistence details stay here.
export const useSpecialistEditorForm = ({
  editSpecialist,
  initialInput
}: UseSpecialistEditorFormOptions): SpecialistEditorFormState => {
  const saveEditorDraft = useSpecialistStore((state) => state.saveEditorDraft)
  const clearEditorDraft = useSpecialistStore((state) => state.clearEditorDraft)
  // Editor drafts survive unmounts — opening a capability's detail page navigates Settings away —
  // so a returning editor re-seeds from the draft instead of the stored profile. A draft restores
  // only while the profile revision it was taken from still matches; the create form additionally
  // yields to a provided initialInput (e.g. a marketplace import's prefill) so an abandoned
  // earlier draft cannot swallow the new prefill.
  const draftKey = editSpecialist ? editSpecialist.id : CREATE_SPECIALIST_DRAFT_KEY
  const storedDraft = useSpecialistStore.getState().editorDrafts[draftKey]
  const restoredDraft =
    storedDraft !== undefined &&
    (editSpecialist !== undefined
      ? storedDraft.form.baseRevision === editSpecialist.revision
      : initialInput === undefined)
      ? storedDraft
      : undefined
  const [form, setForm] = useState<SpecialistEditorFormDraft>(() =>
    restoredDraft !== undefined
      ? restoredDraft.form
      : editSpecialist
        ? formFromProfile(editSpecialist)
        : formFromCreateInput(initialInput)
  )
  const [idTouched, setIdTouched] = useState(
    restoredDraft !== undefined ? restoredDraft.idTouched : initialInput?.id !== undefined
  )
  const [activeCapTab, setActiveCapTab] = useState<'skills' | 'connectors'>(
    restoredDraft !== undefined ? restoredDraft.activeCapTab : 'skills'
  )

  // Keep the editor draft in the specialist store in sync with the live form so any unmount —
  // detail navigation, panel switch, closing Settings — can restore the unsaved edits. A
  // successful save suppresses the next write (the baseRevision advance) so the just-cleared
  // draft is not immediately re-created.
  const suppressDraftWriteRef = useRef(false)
  useEffect(() => {
    if (suppressDraftWriteRef.current) {
      suppressDraftWriteRef.current = false
      return
    }
    saveEditorDraft(draftKey, { form, idTouched, activeCapTab })
  }, [saveEditorDraft, draftKey, form, idTouched, activeCapTab])

  const clearDraft = useCallback(() => clearEditorDraft(draftKey), [clearEditorDraft, draftKey])
  const suppressNextDraftWrite = useCallback(() => {
    suppressDraftWriteRef.current = true
  }, [])

  return {
    form,
    setForm,
    idTouched,
    setIdTouched,
    activeCapTab,
    setActiveCapTab,
    clearDraft,
    suppressNextDraftWrite
  }
}
