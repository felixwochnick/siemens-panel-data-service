<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { DropdownMenuItem } from '@nuxt/ui'
import { arrangeLines, clampWidth, DEFAULT_COLUMN_WIDTH, fitColumnWidth } from '~/utils/sheet/model'
import type { ColumnFilters, SheetColumn, SheetItem, SheetLine, SortState } from '~/utils/sheet/model'
import {
  cellSelection,
  inRange,
  isNavigationKey,
  moveFocus,
  rangeOf,
  selectAll,
  selectColumns,
  selectionSize,
  selectionText,
  selectRows,
} from '~/utils/sheet/selection'
import type { CellPos, SheetSelection } from '~/utils/sheet/selection'
import { csvBlob, downloadBlob, writeXlsx } from '~/utils/sheet/export'

/*
 * Tabellenansicht „wie Excel“, nur lesen: Gitterlinien, Zeilennummern, feste Kopfzeile (erste Spalte optional fest),
 * Filter je Spalte in der Kopfzeile, Sortieren per Klick, Suche über alle Spalten, Zellbereich markieren (Maus ziehen,
 * Umschalt+Klick, Umschalt+Pfeile) und Strg+C als TSV, Spaltenbreite ziehen (Doppelklick: passend), virtuelles
 * Scrollen für zehntausende Zeilen, Export der gefilterten und sortierten Zeilen als .xlsx oder CSV.
 *
 * Kopieren: ein Zellbereich ohne Kopfzeile (passt in bestehende Zeilen); ganze Spalten (Strg+Leertaste, Strg+A oder
 * die Ecke links oben) mit Kopfzeile (wird meist als eigene Tabelle eingefügt).
 *
 * Kindzeilen (Adern unter ihrem Kabel bzw. Schirm) stehen eingerückt unter der Hauptzeile und sind auf-/zuklappbar.
 * Der Export enthält alle passenden Zeilen, auch zugeklappte.
 */
const props = withDefaults(defineProps<{
  /** eindeutiger Name, unter dem Spaltenbreiten und Fixierung im Browser gemerkt werden */
  id: string
  columns: SheetColumn[]
  items: SheetItem[]
  /** Name des Tabellenblatts im .xlsx */
  sheetName: string
  /** Dateiname des Exports je Format */
  fileName: (extension: 'xlsx' | 'csv') => string
  loading?: boolean
  /** Text, wenn die Tabelle keine Zeilen hat */
  emptyText?: string
  /** Sprungziel: Schlüssel einer Zeile, die markiert und in den sichtbaren Bereich gerollt wird */
  highlight?: string | null
}>(), { loading: false, emptyText: undefined, highlight: null })

const emit = defineEmits<{
  /** Doppelklick oder Enter auf einer Zelle */
  activate: [payload: { line: SheetLine, column: SheetColumn }]
}>()

defineSlots<{
  /** eigene Darstellung einer Zelle (Standard: der Text) */
  cell?: (props: { line: SheetLine, column: SheetColumn, value: string }) => unknown
  /** zusätzliche Knöpfe in der Werkzeugleiste */
  toolbar?: () => unknown
}>()

const { t } = useI18n()
const toast = useToast()

const ROW_HEIGHT = 32
const HEADER_HEIGHT = 72
const NUMBER_WIDTH = 56

// ── Breiten und Fixierung (je Tabelle im Browser gemerkt) ──────────────────────
const storedWidths = useLocalStorage<Record<string, number>>(`pds-sheet-widths:${props.id}`, {}, { initOnMounted: true })
const pinFirst = useLocalStorage(`pds-sheet-pin:${props.id}`, false, { initOnMounted: true })

const widths = computed(() => props.columns.map(column => clampWidth(storedWidths.value[column.key] ?? column.width ?? DEFAULT_COLUMN_WIDTH)))
const offsets = computed(() => {
  const result: number[] = []
  let left = NUMBER_WIDTH
  for (const width of widths.value) {
    result.push(left)
    left += width
  }
  return result
})
const totalWidth = computed(() => NUMBER_WIDTH + widths.value.reduce((sum, width) => sum + width, 0))

// ── Filter, Suche, Sortierung, Zuklappen ─────────────────────────────────────
// Eingaben sofort im Feld, angewendet entprellt (Tippen bleibt auch bei 20 000 Zeilen flüssig)
const search = ref('')
const searchQuery = ref('')
const filterInput = ref<ColumnFilters>({})
const filters = shallowRef<ColumnFilters>({})
watchDebounced(search, value => (searchQuery.value = value), { debounce: 200 })
watchDebounced(filterInput, value => (filters.value = value), { debounce: 200 })
const sort = ref<SortState | null>(null)
const collapsed = ref<ReadonlySet<string>>(new Set())

const arranged = computed(() => arrangeLines(props.items, props.columns, {
  filters: filters.value,
  search: searchQuery.value,
  sort: sort.value,
  collapsed: collapsed.value,
}))
const lines = computed(() => arranged.value.lines)
const hasTree = computed(() => props.items.some(item => item.children?.length))
const filtered = computed(() => !!search.value.trim() || Object.values(filterInput.value).some(value => !!value && value !== 'all'))

function resetFilters() {
  search.value = ''
  searchQuery.value = ''
  filterInput.value = {}
  filters.value = {}
}

function toggleSort(index: number) {
  const current = sort.value
  if (current?.column !== index) sort.value = { column: index, direction: 'asc' }
  else if (current.direction === 'asc') sort.value = { column: index, direction: 'desc' }
  else sort.value = null
}

function sortIcon(index: number) {
  if (sort.value?.column !== index) return 'siemens:sort'
  return sort.value.direction === 'asc' ? 'siemens:sort-ascending' : 'siemens:sort-descending'
}

function ariaSort(index: number) {
  if (sort.value?.column !== index) return 'none'
  return sort.value.direction === 'asc' ? 'ascending' : 'descending'
}

function toggleCollapsed(key: string) {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

function collapseAll(state: boolean) {
  collapsed.value = state ? new Set(props.items.filter(item => item.children?.length).map(item => item.key)) : new Set()
}

const flagItems = computed(() => [
  { label: t('sheet.flag.all'), value: 'all' },
  { label: t('sheet.flag.yes'), value: 'yes' },
  { label: t('sheet.flag.no'), value: 'no' },
])

// ── Virtuelles Scrollen ──────────────────────────────────────────────────────
const scroller = useTemplateRef<HTMLDivElement>('scroller')
const virtualizer = useVirtualizer(computed(() => ({
  count: lines.value.length,
  getScrollElement: () => scroller.value,
  estimateSize: () => ROW_HEIGHT,
  overscan: 12,
  // Die Zeilen beginnen unter der (festen) Kopfzeile
  scrollMargin: HEADER_HEIGHT,
  scrollPaddingStart: HEADER_HEIGHT,
  getItemKey: (index: number) => lines.value[index]?.item.key ?? index,
})))
// Sichtbare Zeilen mit ihrer Anzeige-Zeile (nur diese werden gerendert)
const visibleRows = computed(() => virtualizer.value.getVirtualItems().map(row => ({ index: row.index, key: row.key, start: row.start, line: lines.value[row.index]! })))
const contentHeight = computed(() => HEADER_HEIGHT + virtualizer.value.getTotalSize())

/** Zeile (und, wenn nötig, Spalte) in den sichtbaren Bereich holen */
function reveal(pos: CellPos, align: 'auto' | 'center' = 'auto') {
  virtualizer.value.scrollToIndex(pos.row, { align })
  const element = scroller.value
  if (!element) return
  const fixed = NUMBER_WIDTH + (pinFirst.value ? widths.value[0] ?? 0 : 0)
  if (pinFirst.value && pos.col === 0) return
  const left = offsets.value[pos.col]! - fixed
  const right = offsets.value[pos.col]! + widths.value[pos.col]! - element.clientWidth
  if (element.scrollLeft > left) element.scrollLeft = left
  else if (element.scrollLeft < right) element.scrollLeft = Math.min(left, right)
}

// ── Auswahl ──────────────────────────────────────────────────────────────────
const selection = ref<SheetSelection | null>(null)
const range = computed(() => (selection.value ? rangeOf(selection.value) : null))
const focusPos = computed(() => selection.value?.focus ?? null)
const size = computed(() => (selection.value ? selectionSize(selection.value, lines.value.length, props.columns.length) : null))
const dragging = ref(false)

// Neue Daten (anderer Stand) heben Auswahl und Zuklappen auf; Filter bleiben wie in Excel stehen
watch(() => props.items, () => {
  selection.value = null
  collapsed.value = new Set()
})

function posOf(target: EventTarget | null): CellPos | null {
  const cell = (target as HTMLElement | null)?.closest<HTMLElement>('[data-r][data-c]')
  if (!cell) return null
  return { row: Number(cell.dataset.r), col: Number(cell.dataset.c) }
}

function focusGrid() {
  scroller.value?.focus({ preventScroll: true })
}

function onCellDown(event: MouseEvent) {
  if (event.button !== 0) return
  const pos = posOf(event.target)
  if (!pos) return
  // Knöpfe in Zellen (Aufklappen, Sprung) behalten ihren Klick
  if ((event.target as HTMLElement).closest('button, a')) return
  event.preventDefault()
  focusGrid()
  if (event.shiftKey && selection.value) selection.value = { ...selection.value, focus: pos, wholeColumns: false }
  else selection.value = cellSelection(pos)
  dragging.value = true
}

function onCellOver(event: MouseEvent) {
  if (!dragging.value || !selection.value) return
  const pos = posOf(event.target)
  if (pos && (pos.row !== selection.value.focus.row || pos.col !== selection.value.focus.col))
    selection.value = { ...selection.value, focus: pos, wholeColumns: false }
}

useEventListener('mouseup', () => (dragging.value = false))

function onRowNumberDown(event: MouseEvent, row: number) {
  if (event.button !== 0) return
  event.preventDefault()
  focusGrid()
  const cols = props.columns.length
  if (event.shiftKey && selection.value) selection.value = selectRows({ ...selection.value, focus: { row, col: cols - 1 } }, cols)
  else selection.value = selectRows(cellSelection({ row, col: 0 }), cols)
}

function onCornerClick() {
  focusGrid()
  selection.value = selectAll(lines.value.length, props.columns.length)
}

function onCellDouble(event: MouseEvent) {
  const pos = posOf(event.target)
  const line = pos && lines.value[pos.row]
  if (pos && line) emit('activate', { line, column: props.columns[pos.col]! })
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    // Ohne Clipboard-API (z. B. kein sicherer Kontext): über ein verstecktes Textfeld
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    focusGrid()
    return ok
  }
}

async function copySelection() {
  if (!selection.value || !lines.value.length) return
  const text = selectionText(lines.value, props.columns, selection.value)
  const copied = size.value!
  if (await writeClipboard(text))
    toast.add({ title: t(selection.value.wholeColumns ? 'sheet.copiedWithHeader' : 'sheet.copied', { rows: copied.rows, cols: copied.cols }), color: 'success', icon: 'siemens:copy', duration: 2000 })
  else
    toast.add({ title: t('sheet.copyFailed'), color: 'error', icon: 'siemens:circle-error' })
}

function onKeydown(event: KeyboardEvent) {
  // Nur das Gitter selbst; Filterfelder und Knöpfe behalten ihre Tasten
  if (event.target !== scroller.value) return
  const rows = lines.value.length
  const cols = props.columns.length
  if (!rows || !cols) return
  const ctrl = event.ctrlKey || event.metaKey
  const key = event.key

  if (ctrl && key.toLowerCase() === 'c') {
    event.preventDefault()
    void copySelection()
    return
  }
  if (ctrl && key.toLowerCase() === 'a') {
    event.preventDefault()
    selection.value = selectAll(rows, cols)
    return
  }
  if (key === ' ' && (ctrl || event.shiftKey)) {
    event.preventDefault()
    const current = selection.value ?? cellSelection({ row: 0, col: 0 })
    selection.value = ctrl ? selectColumns(current, rows) : selectRows(current, cols)
    return
  }
  if (key === 'Enter' && selection.value) {
    event.preventDefault()
    const line = lines.value[selection.value.focus.row]
    if (line?.expandable) toggleCollapsed(line.item.key)
    else if (line) emit('activate', { line, column: props.columns[selection.value.focus.col]! })
    return
  }
  if (!isNavigationKey(key)) return
  event.preventDefault()
  const current = selection.value?.focus ?? { row: 0, col: 0 }
  const pageRows = Math.max(1, Math.floor(((scroller.value?.clientHeight ?? 400) - HEADER_HEIGHT) / ROW_HEIGHT) - 1)
  const next = selection.value ? moveFocus(current, key, { rows, cols, pageRows }, ctrl) : current
  selection.value = event.shiftKey && selection.value
    ? { ...selection.value, focus: next, wholeColumns: false }
    : cellSelection(next)
  reveal(next)
}

// Zeilen fallen weg (Filter): Auswahl in den Grenzen halten
watch(() => lines.value.length, (rows) => {
  if (!selection.value) return
  if (!rows) selection.value = null
  else if (selection.value.focus.row >= rows || selection.value.anchor.row >= rows) selection.value = cellSelection({ row: Math.min(selection.value.focus.row, rows - 1), col: selection.value.focus.col })
})

// ── Sprungziel ───────────────────────────────────────────────────────────────
const flashKey = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined

async function jumpTo(key: string) {
  const find = () => lines.value.findIndex(line => line.item.key === key)
  if (find() < 0) {
    // Verborgen durch Filter oder zugeklappte Hauptzeile: freilegen
    const parent = props.items.find(item => item.children?.some(child => child.key === key))
    if (parent && collapsed.value.has(parent.key)) toggleCollapsed(parent.key)
    if (find() < 0) resetFilters()
  }
  await nextTick()
  const row = find()
  if (row < 0) return
  selection.value = selectRows(cellSelection({ row, col: 0 }), props.columns.length)
  flashKey.value = key
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashKey.value = null), 2500)
  // Erst rollen, wenn das Gitter sichtbar ist (der Tab wird eben erst gezeigt) und die Zeilen gerendert sind
  await nextTick()
  for (let frame = 0; frame < 30 && !scroller.value?.clientHeight; frame++) await new Promise(resolve => requestAnimationFrame(resolve))
  virtualizer.value.measure()
  virtualizer.value.scrollToIndex(row, { align: 'center' })
  focusGrid()
  // Auch die Seite rollen, falls das Gitter nur teilweise sichtbar ist
  await new Promise(resolve => requestAnimationFrame(resolve))
  scroller.value?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
}

watch(() => [props.highlight, props.items.length] as const, ([key, count]) => {
  if (key && count) void jumpTo(key)
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => clearTimeout(flashTimer))

// ── Spaltenbreite ziehen ─────────────────────────────────────────────────────
const resizing = ref<{ col: number, startX: number, startWidth: number } | null>(null)

function startResize(event: PointerEvent, col: number) {
  event.preventDefault()
  event.stopPropagation()
  resizing.value = { col, startX: event.clientX, startWidth: widths.value[col]! }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onResizeMove(event: PointerEvent) {
  const state = resizing.value
  if (!state) return
  const key = props.columns[state.col]!.key
  storedWidths.value = { ...storedWidths.value, [key]: clampWidth(state.startWidth + event.clientX - state.startX) }
}

function endResize() {
  resizing.value = null
}

function fitColumn(col: number) {
  const column = props.columns[col]!
  const values = (function* () {
    for (const line of lines.value) yield line.item.cells[col] ?? ''
  })()
  storedWidths.value = { ...storedWidths.value, [column.key]: fitColumnWidth(column.label, values) + (col === 0 && hasTree.value ? 28 : 0) }
}

function resetWidths() {
  storedWidths.value = {}
}

// ── Export ───────────────────────────────────────────────────────────────────
const exporting = ref(false)

async function exportAs(format: 'xlsx' | 'csv') {
  exporting.value = true
  try {
    // Alle passenden Zeilen in der angezeigten Reihenfolge, auch zugeklappte Adern
    const { lines: all } = arrangeLines(props.items, props.columns, { filters: filters.value, search: searchQuery.value, sort: sort.value })
    const sheet = { sheetName: props.sheetName, header: props.columns.map(column => column.label), rows: all.map(line => line.item.cells) }
    const blob = format === 'xlsx' ? await writeXlsx(sheet) : csvBlob(sheet)
    downloadBlob(blob, props.fileName(format))
  }
  catch {
    toast.add({ title: t('sheet.exportFailed'), color: 'error', icon: 'siemens:circle-error' })
  }
  finally {
    exporting.value = false
  }
}

const menuItems = computed<DropdownMenuItem[][]>(() => [
  [
    { label: t('sheet.exportXlsx'), description: t('sheet.exportXlsxHint'), icon: 'siemens:document-xls', onSelect: () => exportAs('xlsx') },
    { label: t('sheet.exportCsv'), description: t('sheet.exportCsvHint'), icon: 'siemens:document-text', onSelect: () => exportAs('csv') },
  ],
  [
    {
      label: pinFirst.value ? t('sheet.unpinFirst') : t('sheet.pinFirst'),
      icon: pinFirst.value ? 'siemens:pin-off' : 'siemens:pin',
      onSelect: () => (pinFirst.value = !pinFirst.value),
    },
    { label: t('sheet.resetWidths'), icon: 'siemens:resize', onSelect: resetWidths },
  ],
])

// ── Darstellung ──────────────────────────────────────────────────────────────
function cellStyle(col: number) {
  const style: Record<string, string> = { width: `${widths.value[col]}px` }
  if (col === 0 && pinFirst.value) style.left = `${NUMBER_WIDTH}px`
  return style
}

const cellId = (row: number, col: number) => `${props.id}-r${row}-c${col}`
const { width: viewWidth } = useElementSize(scroller)
const activeDescendant = computed(() => (focusPos.value ? cellId(focusPos.value.row, focusPos.value.col) : undefined))
</script>

<template>
  <div
    class="flex min-h-0 flex-col gap-2"
    :data-testid="`sheet-${props.id}`"
  >
    <!-- Werkzeugleiste: Suche, Zähler, Filter zurücksetzen, Auf-/Zuklappen, Export -->
    <div class="flex flex-wrap items-center gap-2">
      <UInput
        v-model="search"
        icon="siemens:search"
        size="sm"
        :placeholder="t('sheet.search')"
        :aria-label="t('sheet.search')"
        class="w-full sm:w-64"
        data-testid="sheet-search"
      />
      <span
        class="text-sm text-muted tabular-nums"
        aria-live="polite"
        data-testid="sheet-count"
      >{{ t('sheet.count', { shown: arranged.matched, total: arranged.total }) }}</span>
      <UButton
        v-if="filtered"
        color="tertiary"
        size="sm"
        icon="siemens:reset"
        :label="t('sheet.resetFilters')"
        data-testid="sheet-reset"
        @click="resetFilters"
      />
      <div class="ms-auto flex flex-wrap items-center gap-2">
        <span
          v-if="size && (size.rows > 1 || size.cols > 1)"
          class="hidden text-xs text-muted tabular-nums md:inline"
          data-testid="sheet-selection"
        >{{ t('sheet.selection', { rows: size.rows, cols: size.cols }) }}</span>
        <template v-if="hasTree">
          <UButton
            color="tertiary"
            size="sm"
            icon="siemens:chevron-down"
            :label="t('sheet.expandAll')"
            :ui="{ label: 'hidden lg:inline' }"
            :aria-label="t('sheet.expandAll')"
            data-testid="sheet-expand-all"
            @click="collapseAll(false)"
          />
          <UButton
            color="tertiary"
            size="sm"
            icon="siemens:chevron-up"
            :label="t('sheet.collapseAll')"
            :ui="{ label: 'hidden lg:inline' }"
            :aria-label="t('sheet.collapseAll')"
            data-testid="sheet-collapse-all"
            @click="collapseAll(true)"
          />
        </template>
        <slot name="toolbar" />
        <UDropdownMenu
          :items="menuItems"
          :content="{ align: 'end' }"
          :ui="{ content: 'w-72' }"
        >
          <UButton
            color="secondary"
            size="sm"
            icon="siemens:download"
            trailing-icon="siemens:chevron-down"
            :label="t('sheet.export')"
            :loading="exporting"
            :disabled="!props.items.length"
            data-testid="sheet-export"
          />
        </UDropdownMenu>
      </div>
    </div>

    <!-- Gitter -->
    <div
      ref="scroller"
      class="pds-sheet relative h-[max(20rem,calc(100dvh-16rem))] overflow-auto border border-default bg-default text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--ui-primary)"
      role="grid"
      tabindex="0"
      :aria-label="props.sheetName"
      :aria-rowcount="lines.length + 2"
      :aria-colcount="props.columns.length + 1"
      :aria-multiselectable="true"
      :aria-activedescendant="activeDescendant"
      :aria-busy="props.loading"
      data-testid="sheet-grid"
      @keydown="onKeydown"
    >
      <div
        class="relative"
        :style="{ width: `${totalWidth}px`, height: `${contentHeight}px`, minWidth: '100%' }"
      >
        <!-- Kopfzeile mit Filtern (fest) -->
        <div
          class="sticky top-0 z-20 flex flex-col"
          :style="{ width: `${totalWidth}px`, height: `${HEADER_HEIGHT}px` }"
          role="rowgroup"
        >
          <div
            class="flex h-9"
            role="row"
            aria-rowindex="1"
          >
            <div
              class="sheet-head sticky left-0 z-30 flex items-center justify-center border-r border-b border-default"
              :style="{ width: `${NUMBER_WIDTH}px` }"
              role="columnheader"
            >
              <button
                type="button"
                class="size-full cursor-cell text-xs font-semibold text-muted hover:text-highlighted"
                :title="t('sheet.selectAll')"
                :aria-label="t('sheet.selectAll')"
                data-testid="sheet-select-all"
                @click="onCornerClick"
              >
                {{ t('sheet.rowNumber') }}
              </button>
            </div>
            <div
              v-for="(column, c) in props.columns"
              :key="column.key"
              class="sheet-head relative flex shrink-0 items-center border-r border-b border-default"
              :class="c === 0 && pinFirst ? 'sticky z-25' : ''"
              :style="cellStyle(c)"
              role="columnheader"
              :aria-sort="ariaSort(c)"
              :aria-colindex="c + 2"
            >
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 px-2 text-left text-[13px] font-semibold text-highlighted hover:bg-(--ui-bg-accented)/60"
                :title="column.label"
                :data-testid="`sheet-sort-${column.key}`"
                @click="toggleSort(c)"
              >
                <span class="truncate">{{ column.label }}</span>
                <UIcon
                  :name="sortIcon(c)"
                  class="size-3.5 shrink-0"
                  :class="sort?.column === c ? 'text-(--ui-primary)' : 'text-dimmed'"
                />
              </button>
              <div
                class="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-(--ui-primary)/40"
                :class="resizing?.col === c ? 'bg-(--ui-primary)/60' : ''"
                role="separator"
                aria-orientation="vertical"
                :aria-label="t('sheet.resizeColumn', { column: column.label })"
                :data-testid="`sheet-resize-${column.key}`"
                @pointerdown="startResize($event, c)"
                @pointermove="onResizeMove"
                @pointerup="endResize"
                @pointercancel="endResize"
                @dblclick.stop="fitColumn(c)"
              />
            </div>
          </div>
          <div
            class="flex h-9"
            role="row"
            aria-rowindex="2"
          >
            <div
              class="sheet-head sticky left-0 z-30 flex items-center justify-center border-r border-b border-default"
              :style="{ width: `${NUMBER_WIDTH}px` }"
              role="columnheader"
            >
              <UIcon
                name="siemens:filter"
                class="size-4 text-dimmed"
                :aria-label="t('common.filter')"
              />
            </div>
            <div
              v-for="(column, c) in props.columns"
              :key="column.key"
              class="sheet-head flex shrink-0 items-center border-r border-b border-default px-1"
              :class="c === 0 && pinFirst ? 'sticky z-25' : ''"
              :style="cellStyle(c)"
              role="columnheader"
              :aria-colindex="c + 2"
            >
              <USelect
                v-if="column.kind === 'flag'"
                :model-value="filterInput[c] ?? 'all'"
                :items="flagItems"
                value-key="value"
                size="xs"
                class="w-full"
                :aria-label="t('sheet.filterLabel', { column: column.label })"
                :data-testid="`sheet-filter-${column.key}`"
                @update:model-value="filterInput = { ...filterInput, [c]: $event as string }"
              />
              <UInput
                v-else
                :model-value="filterInput[c] ?? ''"
                size="xs"
                :placeholder="t('sheet.filterPlaceholder')"
                class="w-full"
                :ui="{ base: 'font-normal' }"
                :aria-label="t('sheet.filterLabel', { column: column.label })"
                :data-testid="`sheet-filter-${column.key}`"
                @update:model-value="filterInput = { ...filterInput, [c]: String($event) }"
              />
            </div>
          </div>
        </div>

        <!-- Zeilen (nur die sichtbaren) -->
        <div
          role="rowgroup"
          @mousedown="onCellDown"
          @mouseover="onCellOver"
          @dblclick="onCellDouble"
        >
          <div
            v-for="row in visibleRows"
            :key="row.key"
            class="sheet-row absolute top-0 left-0 flex"
            :class="[
              row.line.depth === 0 && row.line.expandable ? 'sheet-group' : '',
              flashKey === row.line.item.key ? 'sheet-flash' : '',
            ]"
            :style="{ width: `${totalWidth}px`, height: `${ROW_HEIGHT}px`, transform: `translateY(${row.start}px)` }"
            role="row"
            :aria-rowindex="row.index + 3"
            :aria-level="hasTree ? row.line.depth + 1 : undefined"
            :aria-expanded="row.line.expandable ? !collapsed.has(row.line.item.key) : undefined"
            :data-key="row.line.item.key"
            data-testid="sheet-row"
          >
            <div
              class="sheet-cell sheet-number sticky left-0 z-10 flex shrink-0 cursor-e-resize items-center justify-end border-r border-b border-default px-2 text-xs text-muted tabular-nums select-none"
              :class="range && row.index >= range.top && row.index <= range.bottom ? 'sheet-number-active' : ''"
              :style="{ width: `${NUMBER_WIDTH}px` }"
              role="rowheader"
              @mousedown.stop="onRowNumberDown($event, row.index)"
            >
              {{ row.index + 1 }}
            </div>
            <div
              v-for="(column, c) in props.columns"
              :id="cellId(row.index, c)"
              :key="column.key"
              class="sheet-cell flex shrink-0 cursor-cell items-center overflow-hidden border-r border-b border-default px-2 whitespace-nowrap select-none"
              :class="[
                c === 0 && pinFirst ? 'sticky z-5' : '',
                column.kind === 'flag' ? 'justify-center' : '',
              ]"
              :style="cellStyle(c)"
              :data-r="row.index"
              :data-c="c"
              :data-selected="inRange(range, row.index, c) ? '' : undefined"
              :data-focus="focusPos && focusPos.row === row.index && focusPos.col === c ? '' : undefined"
              role="gridcell"
              :aria-colindex="c + 2"
              :aria-selected="inRange(range, row.index, c)"
              :title="row.line.item.cells[c] || undefined"
            >
              <template v-if="c === 0 && hasTree">
                <UButton
                  v-if="row.line.expandable"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  square
                  class="-ml-1 mr-0.5 shrink-0 p-0.5"
                  :icon="collapsed.has(row.line.item.key) ? 'siemens:chevron-right' : 'siemens:chevron-down'"
                  :aria-label="collapsed.has(row.line.item.key) ? t('sheet.expand') : t('sheet.collapse')"
                  data-testid="sheet-toggle"
                  @click.stop="toggleCollapsed(row.line.item.key)"
                />
                <span
                  v-else-if="row.line.depth === 1"
                  class="w-8 shrink-0"
                  aria-hidden="true"
                />
              </template>
              <span class="min-w-0 truncate">
                <slot
                  name="cell"
                  :line="row.line"
                  :column="column"
                  :value="row.line.item.cells[c] ?? ''"
                >{{ row.line.item.cells[c] }}</slot>
              </span>
            </div>
          </div>
        </div>

        <!-- Leer, gefiltert oder ladend -->
        <div
          v-if="!lines.length"
          class="sticky left-0 flex flex-col items-center justify-center gap-3 px-4 py-12 text-center text-muted"
          :style="{ width: viewWidth ? `${viewWidth}px` : '100%' }"
          data-testid="sheet-empty"
        >
          <template v-if="props.loading">
            <UIcon
              name="siemens:refresh"
              class="size-6 animate-spin"
            />
            {{ t('common.loading') }}
          </template>
          <template v-else-if="props.items.length">
            {{ t('sheet.noMatches') }}
            <UButton
              color="secondary"
              size="sm"
              icon="siemens:reset"
              :label="t('sheet.resetFilters')"
              @click="resetFilters"
            />
          </template>
          <template v-else>
            {{ props.emptyText ?? t('sheet.noRows') }}
          </template>
        </div>
      </div>
    </div>

    <p class="hidden text-xs text-muted md:block">
      {{ t('sheet.hint') }}
    </p>
  </div>
</template>

<style>
/* Stärke der Markierung; im dunklen Schema kräftiger, sonst verschwindet sie im Tiefblau */
.pds-sheet {
  --pds-sheet-selection: color-mix(in oklab, var(--ui-primary) 14%, transparent);
}

.dark .pds-sheet {
  --pds-sheet-selection: color-mix(in oklab, var(--ui-primary) 28%, transparent);
}
</style>

<style scoped>
/* Gitter wie in Excel: feste Kopf- und Nummernspalte brauchen deckende Hintergründe */
.sheet-head {
  background: var(--ui-bg-elevated);
}

.sheet-cell {
  background: var(--ui-bg);
}

.sheet-group .sheet-cell {
  background: color-mix(in oklab, var(--ui-bg-elevated) 70%, var(--ui-bg));
  font-weight: 600;
}

.sheet-number {
  background: var(--ui-bg-elevated);
}

.sheet-number-active {
  background: color-mix(in oklab, var(--ui-primary) 18%, var(--ui-bg-elevated));
  color: var(--ui-text-highlighted);
}

/* Markierung als Schatten über dem deckenden Hintergrund (bleibt bei fester erster Spalte deckend) */
.sheet-cell[data-selected] {
  box-shadow: inset 0 0 0 100vmax var(--pds-sheet-selection);
}

.sheet-cell[data-focus] {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.sheet-flash .sheet-cell {
  animation: sheet-flash 2.5s ease-out;
}

@keyframes sheet-flash {
  0%,
  40% {
    box-shadow: inset 0 0 0 100vmax color-mix(in oklab, var(--ui-warning) 35%, transparent);
  }

  100% {
    box-shadow: inset 0 0 0 100vmax transparent;
  }
}
</style>
