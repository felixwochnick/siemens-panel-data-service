<script setup lang="ts">
import type { AnalysisInfo, UploadResponse } from '~~/shared/types/api'

/*
 * Projektarchiv (.zw1) hochladen: wählen oder ziehen, Fortschritt, danach liefert der Dialog die eingereihte Analyse.
 * Der Body ist die Datei selbst (keine Multipart-Form, siehe UploadResponse); XMLHttpRequest statt fetch, weil nur er
 * den Fortschritt des Hochladens meldet. Den Origin-Header setzt der Browser selbst (CSRF-Schutz in core).
 */
const emit = defineEmits<{ close: [analysis?: AnalysisInfo] }>()
const { t, locale } = useI18n()
const { errorText } = useLabels()
const toast = useToast()

const file = ref<File | null>(null)
const progress = ref<number | null>(null)
const failure = ref('')
/** offene Analyse bei analysis_already_queued */
const openAnalysisId = ref<number | null>(null)
let request: XMLHttpRequest | null = null

const uploading = computed(() => progress.value !== null)
const invalidType = computed(() => !!file.value && !/\.zw1$/i.test(file.value.name))

watch(file, () => {
  failure.value = ''
  openAnalysisId.value = null
})

function onReject() {
  failure.value = t('errors.upload_invalid_type')
}

function upload() {
  const selected = file.value
  if (!selected || invalidType.value || uploading.value) return
  failure.value = ''
  openAnalysisId.value = null
  progress.value = 0
  const xhr = new XMLHttpRequest()
  request = xhr
  xhr.open('POST', `/api/projects/upload?name=${encodeURIComponent(selected.name)}`)
  xhr.setRequestHeader('content-type', 'application/octet-stream')
  xhr.responseType = 'json'
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100)
  }
  xhr.onload = () => {
    request = null
    const body = xhr.response as (UploadResponse & { message?: string, data?: Record<string, unknown> }) | null
    if (xhr.status === 201 && body?.analysis) {
      progress.value = 100
      toast.add({ title: t('projects.upload.done', { name: body.project.name }), color: 'success', icon: 'siemens:circle-checkmark' })
      emit('close', body.analysis)
      return
    }
    progress.value = null
    // Fehlerantwort von h3: { statusCode, message: <code>, data: { …Werte } }
    failure.value = errorText({ status: xhr.status, data: body ?? undefined })
    const analysisId = Number(body?.data?.analysisId)
    if (Number.isInteger(analysisId) && analysisId > 0) openAnalysisId.value = analysisId
  }
  xhr.onerror = () => {
    request = null
    progress.value = null
    failure.value = t('projects.upload.networkError')
  }
  xhr.onabort = () => {
    request = null
    progress.value = null
  }
  xhr.send(selected)
}

function cancel() {
  request?.abort()
  emit('close')
}

// Schließen über das X bricht ein laufendes Hochladen ab
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <UModal
    :title="t('projects.upload.title')"
    :description="t('projects.upload.description')"
    :dismissible="!uploading"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <div
        class="flex flex-col gap-4"
        data-testid="upload-dialog"
      >
        <UFileUpload
          v-model="file"
          accept=".zw1"
          layout="list"
          :file-image="false"
          file-icon="siemens:document-zip"
          icon="siemens:upload"
          :label="t('projects.upload.drop')"
          :description="t('projects.upload.dropHint')"
          :disabled="uploading"
          class="min-h-40 w-full"
          data-testid="upload-input"
          @reject="onReject"
        />
        <p
          v-if="file && !invalidType"
          class="text-sm text-muted"
        >
          {{ t('projects.upload.selected', { name: file.name, size: formatBytes(file.size, locale) }) }}
        </p>
        <div
          v-if="uploading"
          class="flex flex-col gap-1"
          data-testid="upload-progress"
        >
          <UProgress
            :model-value="progress"
            :max="100"
          />
          <span class="text-xs text-muted tabular-nums">{{ t('projects.upload.progress', { percent: progress }) }}</span>
        </div>
        <UAlert
          v-if="failure || invalidType"
          color="error"
          variant="subtle"
          icon="siemens:circle-error"
          :title="failure || t('errors.upload_invalid_type')"
          data-testid="upload-error"
        >
          <template
            v-if="openAnalysisId"
            #description
          >
            <NuxtLink
              :to="`/analyses/${openAnalysisId}`"
              class="font-semibold underline"
              @click="emit('close')"
            >{{ t('projects.upload.openAnalysis') }}</NuxtLink>
          </template>
        </UAlert>
      </div>
    </template>
    <template #footer>
      <UButton
        color="tertiary"
        :label="t('common.cancel')"
        @click="cancel"
      />
      <UButton
        icon="siemens:upload"
        :label="t('projects.upload.start')"
        :loading="uploading"
        :disabled="!file || invalidType"
        data-testid="upload-start"
        @click="upload"
      />
    </template>
  </UModal>
</template>
