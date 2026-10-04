// Why both shapes: 0.150-0.157 paint `model: loading` in a box, 0.158 a bare `loading` under the title.
const CODEX_HEADER_LOADING_RE = /(?:model|directory):\s+loading|^\s*loading\s*$/m
// Why a line cap: 0.158 draws no box, so nothing else ends its header before the chat.
const CODEX_HEADER_LINES = 6
// Why the whole line: a pager, a `cat`ed transcript, or chat can quote the placeholder mid-line.
const CODEX_EMPTY_COMPOSER_RE = /^› ask codex to do anything\s*$/
// Why not "working": reasoning summaries replace it, and a remapped key still ends this way.
const CODEX_BUSY_STATUS_MARKER = 'to interrupt)'
// Why only a tip: it is the one line Codex draws between its status row and the composer (120x40 corpus).
const CODEX_STATUS_TIP_PREFIX = '└ tip:'
// Why: the welcome animation scatters braille dots over empty cells, the composer row included.
const BRAILLE_CELL_RE = /[\u2800-\u28ff]/g
// Why the column-0 marker: the composer and every submitted prompt row open with it.
const CODEX_PROMPT_PREFIX = '› '
// Why: the hint row paints with the composer, before the session (and its status row) is configured.
const CODEX_SHORTCUTS_HINT = 'for shortcuts'

// Why the header only: chat below it can mention "OpenAI Codex" or `model: loading`.
function findCodexHeader(screen: string): { index: number; text: string } | null {
  const index = screen.indexOf('openai codex')
  if (index === -1) {
    return null
  }
  const boxEnd = screen.indexOf('╰', index)
  const text = screen
    .slice(index, boxEnd === -1 ? undefined : boxEnd)
    .split('\n', CODEX_HEADER_LINES)
    .join('\n')
  return { index, text }
}

/** The 0.150-0.157 header, which only a grid reassembles (see isCodexScreenHeaderReady). */
export function findCodexScreenReadyPromptIndex(screen: string): number | null {
  const header = findCodexHeader(screen)
  return header !== null &&
    header.text.includes('model:') &&
    header.text.includes('directory:') &&
    !CODEX_HEADER_LOADING_RE.test(header.text)
    ? header.index
    : null
}

// Why the text copy: 0.157 leaves its alternate screen while it starts its daemon, so the live
// screen shows no header then, while the text copy keeps the provisional one until the live chat
// paints its footer after it (a later model repaint rewrites only the value, never the label).
// Why `·`: every live footer row draws one (status row, `← for agents · ?`, `⚠ N warning · f2`);
// startup dialogs draw one too, which is why startup-dialog-blocked-signals.ts matches them first.
export function isCodexProvisionalStartupText(normalized: string): boolean {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return false
  }
  const loading = /model:\s+loading/.exec(normalized.slice(headerIndex))
  return loading !== null && !normalized.includes('·', headerIndex + loading.index)
}

// Why: Codex repaints its whole screen, header included, once a startup dialog closes, and the
// dialog never draws the header; 0.158's header has no labels, so the header alone marks it answered.
export function findCodexHeaderIndex(normalized: string): number | null {
  const index = normalized.lastIndexOf('openai codex (v')
  return index === -1 ? null : index
}

/**
 * Tier 1b, codex panes only: the empty composer with no busy status row just above it and no
 * header load. Codex 0.158 dropped `model:`/`directory:`, and a long session scrolls the header
 * away, so this is its only version-stable rest body. No dialog check: every Codex dialog
 * replaces the composer, while an answer ending "Would you like to…?" must not block the lane.
 * The mid-turn guard is the caller's quiescence, fed by the ~100 ms title spinner and status
 * timer; `tui.animations=false` (set by a screen reader), `tui.effects.progress=false`, or a
 * `tui.terminal_title` without activity/spinner removes it.
 */
export function isCodexComposerReadyScreen(screen: string): boolean {
  const lines = screen.split('\n')
  const composer = lines.findLastIndex((line) => CODEX_EMPTY_COMPOSER_RE.test(line))
  if (composer === -1 || hasBusyStatusRowAbove(lines, composer)) {
    return false
  }
  const header = findCodexHeader(screen)
  return header === null || !CODEX_HEADER_LOADING_RE.test(header.text)
}

/**
 * Tier 1, the 0.159+ fresh-session screen: the label-less header (`>_ OpenAI Codex (vX)` over a
 * bare cwd row), loaded, then an empty composer with no busy row above it, no turn between them,
 * and the footer status row under it. Why no quiescence: the title spinner keeps output flowing
 * ~2 s past the configured composer while MCP servers start (codex-0-160-0-ready). Why the status
 * row: the composer paints ~1 s before the session is configured, and a trust dialog can replace
 * it in that window (codex-0-160-0-trust-dialog). Why no turn: a submitted prompt paints its `› `
 * row under the header, and the header cannot scroll away while that row stays on screen.
 */
export function findCodexFreshSessionReadyIndex(screen: string): number | null {
  const header = findCodexHeader(screen)
  if (header === null || CODEX_HEADER_LOADING_RE.test(header.text)) {
    return null
  }
  const lines = screen.slice(header.index).replace(BRAILLE_CELL_RE, ' ').split('\n')
  const composer = lines.findLastIndex((line) => CODEX_EMPTY_COMPOSER_RE.test(line))
  if (composer === -1 || hasBusyStatusRowAbove(lines, composer)) {
    return null
  }
  const hasTurn = lines.slice(1, composer).some((line) => line.startsWith(CODEX_PROMPT_PREFIX))
  const hasStatusRow = lines
    .slice(composer + 1)
    .some((line) => line.trim() !== '' && !line.includes(CODEX_SHORTCUTS_HINT))
  return hasTurn || !hasStatusRow ? null : header.index
}

// Why only the row above the composer: a finished answer (or one above 0.158's timestamp) can quote it.
function hasBusyStatusRowAbove(lines: readonly string[], composer: number): boolean {
  const above = lines.slice(0, composer).filter((line) => line.trim() !== '')
  const row = above.at(-1)?.trimStart().startsWith(CODEX_STATUS_TIP_PREFIX)
    ? above.at(-2)
    : above.at(-1)
  return row?.includes(CODEX_BUSY_STATUS_MARKER) ?? false
}
