<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import { RESULT_TABS } from '~~/shared/types/api'
import type { AnalysisInfo, CableRow, CablesResponse, ConnectionRow, ConnectionsResponse, ResultTab, ShieldRow, ShieldsResponse, TextRow, TextsResponse } from '~~/shared/types/api'
import type { SheetColumn, SheetItem, SheetLine } from '~/utils/sheet/model'
import { exportFileName } from '~/utils/sheet/export'

/*
 * Ergebnisse einer erfolgreichen Analyse in vier Tabs (Verbindungen, Kabel, Schirme, Texte) mit Zählern. Jeder Tab
 * lädt seine Zeilen einmal komplett (nur im Browser; 20 000 Zeilen gehören nicht in die Seite vom Server) und zeigt
 * sie im DataSheet. Kabel wie der EPLAN-Kabelnavigator (Kabel, darunter die Adern), Schirme mit ihren Adern; ein Klick
 * auf eine Ader springt zur Verbindung im Tab Verbindungen. Der aktive Tab steht in der Adresse (?tab=).
 */
const props = defineProps<{ analysis: AnalysisInfo, projectName: string }>()
const { t } = useI18n()
const { errorText } = useLabels()
const route = useRoute()
const router = useRouter()

const isTab = (value: unknown): value is ResultTab => typeof value === 'string' && (RESULT_TABS as readonly string[]).includes(value)
const tab = computed<ResultTab>({
  get: () => (isTab(route.query.tab) ? route.query.tab : 'connections'),
  set: value => void router.replace({ query: { ...route.query, tab: value === 'connections' ? undefined : value } }),
})

// ── Daten je Tab (flach gehalten: 20 000 Zeilen ohne tiefe Reaktivität) ──────
interface TabData {
  connections: ConnectionRow[]
  cables: CableRow[]
  shields: ShieldRow[]
  texts: TextRow[]
}
const data = shallowRef<Partial<TabData>>({})
/** Sprungziel im Tab Verbindungen (Schlüssel der Zeile) */
const highlight = ref<string | null>(null)
const loading = ref<Partial<Record<ResultTab, boolean>>>({})
const failures = ref<Partial<Record<ResultTab, string>>>({})
let generation = 0

async function load(which: ResultTab) {
  if (data.value[which] || loading.value[which]) return
  const id = props.analysis.id
  const current = generation
  loading.value = { ...loading.value, [which]: true }
  failures.value = { ...failures.value, [which]: undefined }
  try {
    const response = await $fetch<ConnectionsResponse | CablesResponse | ShieldsResponse | TextsResponse>(`/api/analyses/${id}/${which}`)
    if (current !== generation) return
    data.value = { ...data.value, [which]: response.rows }
  }
  catch (error) {
    if (current === generation) failures.value = { ...failures.value, [which]: errorText(error) }
  }
  finally {
    if (current === generation) loading.value = { ...loading.value, [which]: false }
  }
}

// Schirme zeigen ihre Adern mit Quelle und Ziel: dafür auch die Verbindungen laden
const needed = computed<ResultTab[]>(() => (tab.value === 'shields' ? ['shields', 'connections'] : [tab.value]))
onMounted(() => {
  watch([() => props.analysis.id, needed], ([id], [previousId]) => {
    if (previousId !== undefined && id !== previousId) {
      generation++
      data.value = {}
      loading.value = {}
      failures.value = {}
      highlight.value = null
    }
    for (const which of needed.value) void load(which)
  }, { immediate: true })
})

// ── Tabs mit Zählern ─────────────────────────────────────────────────────────
const counts = computed(() => props.analysis.counts)
const tabs = computed<TabsItem[]>(() => RESULT_TABS.map(value => ({
  label: t(`results.tabs.${value}`),
  value,
  badge: counts.value ? { label: String(counts.value[value]), color: 'neutral' as const, variant: 'subtle' as const } : undefined,
  slot: value,
})))

const yes = computed(() => t('results.yes'))
const flag = (value: boolean) => (value ? yes.value : '')

const column = (tabName: ResultTab, key: string, width: number, kind?: 'flag'): SheetColumn => ({ key, label: t(`results.columns.${tabName}.${key}`), width, kind })

// ── Verbindungen ─────────────────────────────────────────────────────────────
const connectionColumns = computed<SheetColumn[]>(() => [
  column('connections', 'page', 170),
  column('connections', 'definition', 165),
  column('connections', 'designation', 215),
  column('connections', 'source', 210),
  column('connections', 'destination', 210),
  column('connections', 'cable', 160),
  column('connections', 'wireNumber', 110),
  column('connections', 'crossSection', 110),
  column('connections', 'wireType', 130),
  column('connections', 'length', 90),
  column('connections', 'partNumbers', 170),
  column('connections', 'hashMark', 120, 'flag'),
  column('connections', 'twisted', 120, 'flag'),
  column('connections', 'shielded', 120, 'flag'),
])
const connectionItems = computed<SheetItem[]>(() => (data.value.connections ?? []).map(row => ({
  key: `c${row.idx}`,
  cells: [
    row.page, row.definition, row.designation, row.source, row.destination, row.cable, row.wireNumber, row.crossSection,
    row.wireType, row.length, row.partNumbers, flag(row.hashMark), flag(row.twisted), flag(row.shielded),
  ],
})))

// ── Kabel (Kabelnavigator) ───────────────────────────────────────────────────
const cableColumns = computed<SheetColumn[]>(() => [
  column('cables', 'name', 190),
  column('cables', 'definition', 190),
  column('cables', 'page', 170),
  column('cables', 'source', 210),
  column('cables', 'destination', 210),
  column('cables', 'type', 150),
  column('cables', 'wireCountAndCrossSection', 160),
  column('cables', 'length', 90),
  column('cables', 'wireNumber', 110),
  column('cables', 'crossSection', 110),
  column('cables', 'partNumbers', 170),
])
const cableItems = computed<SheetItem[]>(() => (data.value.cables ?? []).map(cable => ({
  key: `k${cable.idx}`,
  cells: [
    cable.name, cable.definition, cable.page, cable.source, cable.destination, cable.type, cable.wireCountAndCrossSection,
    cable.length, '', '', cable.partNumbers,
  ],
  // Auch in den Aderzeilen der Kabelname, damit der Filter „Kabel“ die Adern mitnimmt (wie in der alten Excel)
  children: cable.wires.map(wire => ({
    key: `k${cable.idx}w${wire.idx}`,
    cells: [cable.name, wire.definition, wire.page, wire.source, wire.destination, '', '', wire.length, wire.wireNumber, wire.crossSection, wire.partNumbers],
  })),
})))
/** Ader → Verbindung (Sprungziel bei Doppelklick oder Enter); 3D-Adern haben keine */
const cableTargets = computed(() => new Map<string, number>((data.value.cables ?? []).flatMap(cable => cable.wires
  .filter(wire => wire.connectionIdx !== null)
  .map(wire => [`k${cable.idx}w${wire.idx}`, wire.connectionIdx!] as const))))

// ── Schirme ──────────────────────────────────────────────────────────────────
const shieldColumns = computed<SheetColumn[]>(() => [
  column('shields', 'page', 170),
  column('shields', 'name', 190),
  column('shields', 'type', 150),
  column('shields', 'wireCountAndCrossSection', 160),
  column('shields', 'wireCount', 120),
  column('shields', 'wires', 460),
])
/** Kurzbezeichnung einer Ader wie in der alten Excel: „WH: Quelle → Ziel“ */
function wireLabel(connection: ConnectionRow | undefined, idx: number) {
  if (!connection) return `#${idx + 1}`
  const route = `${connection.source} → ${connection.destination}`
  return connection.wireNumber ? `${connection.wireNumber}: ${route}` : route
}
const shieldItems = computed<SheetItem[]>(() => {
  const byIdx = new Map((data.value.connections ?? []).map(row => [row.idx, row]))
  return (data.value.shields ?? []).map(shield => ({
    key: `s${shield.idx}`,
    cells: [shield.page, shield.name, shield.type, shield.wireCountAndCrossSection, String(shield.connectionIdx.length), ''],
    children: shield.connectionIdx.map((idx) => {
      const connection = byIdx.get(idx)
      return { key: `s${shield.idx}c${idx}`, cells: [connection?.page ?? '', shield.name, '', '', '', wireLabel(connection, idx)] }
    }),
  }))
})
/** Ader eines Schirms → Verbindung */
const shieldTargets = computed(() => new Map<string, number>((data.value.shields ?? []).flatMap(shield => shield.connectionIdx.map(idx => [`s${shield.idx}c${idx}`, idx] as const))))

// ── Texte ────────────────────────────────────────────────────────────────────
const textColumns = computed<SheetColumn[]>(() => [column('texts', 'page', 190), column('texts', 'text', 640)])
const textItems = computed<SheetItem[]>(() => (data.value.texts ?? []).map(row => ({ key: `t${row.idx}`, cells: [row.page, row.text] })))

// ── Sprung zur Verbindung ────────────────────────────────────────────────────
function jumpToConnection(idx: number) {
  // Neu setzen, damit derselbe Sprung zweimal hintereinander wirkt
  highlight.value = null
  tab.value = 'connections'
  void nextTick(() => (highlight.value = `c${idx}`))
}

function onActivate(targets: Map<string, number>, payload: { line: SheetLine }) {
  const idx = targets.get(payload.line.item.key)
  if (idx !== undefined) jumpToConnection(idx)
}

const tabLabel = (value: ResultTab) => t(`results.tabs.${value}`)
const fileName = (value: ResultTab) => (extension: 'xlsx' | 'csv') => exportFileName(props.projectName, tabLabel(value), props.analysis.id, extension)
const sheetLoading = (...which: ResultTab[]) => which.some(value => !!loading.value[value] || (!data.value[value] && !failures.value[value]))
const failureOf = (...which: ResultTab[]) => which.map(value => failures.value[value]).find(Boolean)
</script>

<template>
  <UTabs
    v-model="tab"
    :items="tabs"
    :unmount-on-hide="false"
    variant="link"
    :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0', content: 'pt-3' }"
    data-testid="result-tabs"
  >
    <template #connections>
      <UAlert
        v-if="failureOf('connections')"
        color="error"
        variant="subtle"
        icon="siemens:circle-error"
        :title="failureOf('connections')"
      />
      <SheetDataSheet
        v-else
        id="connections"
        :columns="connectionColumns"
        :items="connectionItems"
        :sheet-name="tabLabel('connections')"
        :file-name="fileName('connections')"
        :loading="sheetLoading('connections')"
        :empty-text="t('results.empty.connections')"
        :highlight="highlight"
      />
    </template>

    <template #cables>
      <UAlert
        v-if="failureOf('cables')"
        color="error"
        variant="subtle"
        icon="siemens:circle-error"
        :title="failureOf('cables')"
      />
      <SheetDataSheet
        v-else
        id="cables"
        :columns="cableColumns"
        :items="cableItems"
        :sheet-name="tabLabel('cables')"
        :file-name="fileName('cables')"
        :loading="sheetLoading('cables')"
        :empty-text="t('results.empty.cables')"
        @activate="onActivate(cableTargets, $event)"
      />
    </template>

    <template #shields>
      <UAlert
        v-if="failureOf('shields', 'connections')"
        color="error"
        variant="subtle"
        icon="siemens:circle-error"
        :title="failureOf('shields', 'connections')"
      />
      <SheetDataSheet
        v-else
        id="shields"
        :columns="shieldColumns"
        :items="shieldItems"
        :sheet-name="tabLabel('shields')"
        :file-name="fileName('shields')"
        :loading="sheetLoading('shields', 'connections')"
        :empty-text="t('results.empty.shields')"
        @activate="onActivate(shieldTargets, $event)"
      >
        <template #cell="{ line, column: col, value }">
          <button
            v-if="col.key === 'wires' && line.depth === 1"
            type="button"
            class="flex min-w-0 cursor-pointer items-center gap-1 text-(--ui-color-siemens) hover:underline"
            :title="t('results.jumpToConnection')"
            data-testid="shield-wire-link"
            @click="jumpToConnection(shieldTargets.get(line.item.key)!)"
          >
            <UIcon
              name="siemens:link"
              class="size-3.5 shrink-0"
            />
            <span class="truncate">{{ value }}</span>
          </button>
          <template v-else>
            {{ value }}
          </template>
        </template>
      </SheetDataSheet>
    </template>

    <template #texts>
      <UAlert
        v-if="failureOf('texts')"
        color="error"
        variant="subtle"
        icon="siemens:circle-error"
        :title="failureOf('texts')"
      />
      <SheetDataSheet
        v-else
        id="texts"
        :columns="textColumns"
        :items="textItems"
        :sheet-name="tabLabel('texts')"
        :file-name="fileName('texts')"
        :loading="sheetLoading('texts')"
        :empty-text="t('results.empty.texts')"
      />
    </template>
  </UTabs>
</template>
