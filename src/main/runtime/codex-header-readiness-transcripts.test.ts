import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  replayTranscript,
  type TranscriptReplayFrame
} from './agent-transcript-replay-test-harness'
import {
  findCodexFreshSessionReadyIndex,
  findCodexScreenReadyPromptIndex
} from './codex-terminal-readiness'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isKnownReadyPromptSettled,
  isQuietReadyScreenBody
} from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// codex-cli 0.157.1 recordings at 120x40 (see each .meta.json); STA-8628.
const PLAIN = 'codex-0157-plain-ready'
const EFFORT_OVERRIDE = 'codex-0157-effort-override-embedded-warning'
const CONFIG_OVERRIDE = 'codex-0157-config-override-embedded-warning'
const NO_DAEMON = 'codex-0157-no-daemon-effort-override'
// Fresh CODEX_HOME: the provisional header stays up while Codex installs and starts its daemon.
const FRESH_HOME = 'codex-0157-fresh-home-daemon-install'
const ALL_FIXTURES = [PLAIN, EFFORT_OVERRIDE, CONFIG_OVERRIDE, NO_DAEMON, FRESH_HOME]

async function finalFrame(
  name: string,
  cols: number,
  rows: number
): Promise<TranscriptReplayFrame> {
  let last: TranscriptReplayFrame | null = null
  for await (const frame of replayTranscript(readRuntimeFixture(name), cols, rows)) {
    last = frame
  }
  if (!last) {
    throw new Error(`empty fixture ${name}`)
  }
  return last
}

function screenShowsLoadingHeader(screenLines: string[]): boolean {
  const screen = screenLines.join('\n').toLowerCase()
  return screen.includes('openai codex') && /(?:model|directory):\s+loading/.test(screen)
}

// Codex's default status row opens with `<model> <effort> ·`; only the live chat paints it.
const LIVE_STATUS_ROW_RE = /\b(?:default|minimal|low|medium|high|xhigh) ·/

function screenShowsProvisionalStartup(screenLines: string[]): boolean {
  return (
    screenShowsLoadingHeader(screenLines) &&
    !screenLines.some((line) => LIVE_STATUS_ROW_RE.test(line.toLowerCase()))
  )
}

describe('Codex 0.157 header readiness from captured bytes', () => {
  it.each([EFFORT_OVERRIDE, CONFIG_OVERRIDE])(
    '%s: the line-folded wait text never shows a ready header',
    async (name) => {
      const { waitText } = await finalFrame(name, 120, 40)
      // Why: the cell-diff repaint folds to `dirctory:` — the STA-8628 timeout.
      expect(waitText.toLowerCase()).toContain('dirctory:')
      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    }
  )

  it.each(ALL_FIXTURES)(
    '%s: the screen never adds readiness while loading, and is ready at the final screen',
    async (name) => {
      let sawLoadingHeader = false
      let last: TranscriptReplayFrame | null = null
      for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
        if (screenShowsLoadingHeader(frame.screenLines)) {
          sawLoadingHeader = true
          expect(isQuietReadyScreenBody('', 'codex', () => frame.screenLines)).toBe(false)
        }
        last = frame
      }
      // Presence precondition: a loading frame was actually exercised.
      expect(sawLoadingHeader).toBe(true)
      expect(last).not.toBeNull()
      expect(isQuietReadyScreenBody(last!.waitText, 'codex', () => last!.screenLines)).toBe(true)
    }
  )

  // Why: 0.157 discards input typed during its daemon start, behind the provisional header.
  it.each(ALL_FIXTURES)(
    '%s: never ready while the screen shows the provisional `model: loading` startup screen',
    async (name) => {
      let sawTextOnlyReadiness = false
      for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
        if (screenShowsProvisionalStartup(frame.screenLines)) {
          sawTextOnlyReadiness ||= isKnownReadyPromptPreview(frame.waitText)
          expect(isQuietReadyScreenBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
            false
          )
          expect(isKnownReadyPromptBody(frame.waitText, null, () => frame.screenLines, true)).toBe(
            false
          )
        }
      }
      // Presence precondition for the text-copy fixtures: the text rules alone would say ready here.
      if (name === PLAIN || name === FRESH_HOME) {
        expect(sawTextOnlyReadiness).toBe(true)
      }
    }
  )

  // Why these sizes: grids out of step with the 120x40 recording garble the header (review of #23475).
  describe.each([
    [120, 40],
    [80, 24],
    [30, 50],
    [108, 30],
    [60, 5]
  ])('at %ix%i the screen never takes a settled header away from the text rules', (cols, rows) => {
    it.each(ALL_FIXTURES)('%s', async (name) => {
      let settledFrames = 0
      for await (const frame of replayTranscript(readRuntimeFixture(name), cols, rows)) {
        if (isKnownReadyPromptSettled(frame.waitText)) {
          settledFrames += 1
          expect(isQuietReadyScreenBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
            true
          )
        }
      }
      // Presence precondition: the text-copy fixtures reach a settled header.
      if (name === PLAIN || name === FRESH_HOME || name === NO_DAEMON) {
        expect(settledFrames).toBeGreaterThan(0)
      }
    })
  })

  it('keeps the text rules when there is no live screen', async () => {
    const { waitText } = await finalFrame(PLAIN, 120, 40)
    expect(isQuietReadyScreenBody(waitText, 'codex', () => null)).toBe(
      isKnownReadyPromptPreview(waitText)
    )
    expect(isQuietReadyScreenBody(waitText, 'codex', () => null)).toBe(true)
  })

  it('does not read a mid-turn composer as ready', () => {
    const screenLines = [
      '› Summarize the repository layout',
      '• Working (12s • esc to interrupt)',
      '› Ask Codex to do anything',
      '  GPT-6-Sol high · ~/repo/app'
    ]
    expect(isQuietReadyScreenBody(screenLines.join('\n'), 'codex', () => screenLines)).toBe(false)
  })

  it('does not settle when a blocking dialog is painted below the header', () => {
    const screenLines = [
      '│ >_ OpenAI Codex (v0.157.1)                               │',
      '│ model:       GPT-6-Sol high   /model to change           │',
      '│ directory:   ~/repo/app                                  │',
      'Do you trust the contents of this directory?',
      'Press enter to continue'
    ]
    expect(isQuietReadyScreenBody('', 'codex', () => screenLines)).toBe(false)
  })

  it('reads only the header box, not chat below it that mentions Codex', () => {
    const screenLines = [
      '╭──────────────────────────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.157.1)                               │',
      '│ model:       GPT-6-Sol high   /model to change           │',
      '│ directory:   ~/repo/app                                  │',
      '╰──────────────────────────────────────────────────────────╯',
      '› Why does OpenAI Codex print model: loading at startup?'
    ]
    expect(isQuietReadyScreenBody('', 'codex', () => screenLines)).toBe(true)
  })

  it('never reads a non-codex screen, even one showing the Codex header', () => {
    const screenLines = [
      '│ >_ OpenAI Codex (v0.157.1)                               │',
      '│ model:       GPT-6-Sol high   /model to change           │',
      '│ directory:   ~/repo/app                                  │'
    ]
    const readScreenLines = vi.fn(() => screenLines)
    expect(isQuietReadyScreenBody('', 'claude', readScreenLines)).toBe(false)
    expect(readScreenLines).not.toHaveBeenCalled()
    expect(isQuietReadyScreenBody('', 'codex', readScreenLines)).toBe(true)
  })

  describe('at the 80x24 default grid the header garbles and today’s answer stands', () => {
    it.each(ALL_FIXTURES)('%s', async (name) => {
      const { screenLines, waitText } = await finalFrame(name, 80, 24)
      expect(isQuietReadyScreenBody(waitText, 'codex', () => screenLines)).toBe(
        isKnownReadyPromptPreview(waitText)
      )
    })
  })

  describe('through the runtime', () => {
    async function codexPane(name: string, size?: { cols: number; rows: number }) {
      return createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: readRuntimeFixture(name),
        size
      })
    }

    it.each(ALL_FIXTURES)(
      '%s: a tui-idle wait settles from the live screen',
      async (name) => {
        const { runtime, handle } = await codexPane(name, { cols: 120, rows: 40 })
        // Why 8s: quiescence (3s) plus the 2s poll re-reading the grid.
        await expect(
          runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 8_000 })
        ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
      },
      15_000
    )

    it('does not settle while Codex is still installing its daemon behind the provisional screen', async () => {
      const data = readRuntimeFixture(FRESH_HOME)
      const install = data.indexOf('Installing daemon')
      // Presence precondition: the cut keeps the provisional header and stops before the live chat.
      expect(install).toBeGreaterThan(0)
      const provisional = data.slice(0, data.indexOf('\n', install) + 1)
      expect(provisional).toMatch(/model:.*loading/)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: provisional,
        size: { cols: 120, rows: 40 }
      })
      // Why 6s: past the 3s quiescence, so the quiet lane's provisional veto is what holds.
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 6_000 })
      ).rejects.toThrow(/timeout/)
    }, 15_000)

    // Why no bytes: worker-start waits on a pane that has printed nothing yet, which is when the
    // runtime asks for a visible-screen read instead of its own text copy.
    it('does not settle from a visible-screen read of the provisional screen', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: '',
        size: { cols: 120, rows: 40 }
      })
      const readVisibleScreen = vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
        handle,
        status: 'running',
        tail: [
          '╭──────────────────────────────────────────╮',
          '│ >_ OpenAI Codex (v0.157.0)               │',
          '│ model:       loading   /model to change  │',
          '│ directory:   ~/repo/app                  │',
          '╰──────────────────────────────────────────╯',
          '› Ask Codex to do anything',
          '  ? for shortcuts'
        ],
        truncated: false,
        nextCursor: null,
        source: 'screen'
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).rejects.toThrow(/timeout/)
      // Presence precondition: the visible-screen probe actually ran.
      expect(readVisibleScreen).toHaveBeenCalled()
    }, 15_000)

    // Why: restored bytes set no lastOutputAt, so the quiet lane has no clock to wait out.
    it('settles a restored Codex pane from its header, as main did', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: ''
      })
      runtime.seedTerminalRestoreTail(TRANSCRIPT_PANE_PTY_ID, {
        text: [
          '╭──────────────────────────────────────────╮',
          '│ >_ OpenAI Codex (v0.157.1)               │',
          '│ model:       gpt-6-sol high   /model to change │',
          '│ directory:   ~/repo/app                  │',
          '╰──────────────────────────────────────────╯',
          '› Ask Codex to do anything',
          '  gpt-6-sol high · ~/repo/app'
        ].join('\r\n')
      })
      // Why no screen: the visible-screen probe must not be what settles the wait.
      vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
        handle,
        status: 'running',
        tail: [],
        truncated: false,
        nextCursor: null,
        source: 'screen-unavailable'
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
    }, 15_000)

    it('keeps timing out on the garbled 80x24 default grid, as before', async () => {
      const { runtime, handle } = await codexPane(EFFORT_OVERRIDE)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 6_000 })
      ).rejects.toThrow(/timeout/)
    }, 15_000)
  })
})

// codex-cli 0.160.0 recordings at 120x40 through /usr/bin/script (see each .meta.json). 0.159+
// dropped the `model:`/`directory:` labels the 0.150-0.157 header rule keys on.
const READY_0160 = 'codex-0-160-0-ready'
// workspace-write, so no `permissions:` header row, and a `⚠ 1 warning` on the hint row.
const READY_0160_SANDBOXED = 'codex-0-160-0-ready-sandboxed'
const BUSY_0160 = 'codex-0-160-0-busy-turn'
// Never answered: the empty composer paints ~1.1 s before this dialog replaces it.
const TRUST_0160 = 'codex-0-160-0-trust-dialog'
const READY_0160_FIXTURES = [READY_0160, READY_0160_SANDBOXED]

const EMPTY_COMPOSER_RE = /^› ask codex to do anything\s*$/m
const BARE_LOADING_ROW_RE = /^\s*loading\s*$/m
const BUSY_STATUS_RE = /to interrupt\)/

function screenOf(frame: TranscriptReplayFrame): string {
  return frame.screenLines.join('\n').toLowerCase()
}

function isTierOneReady(frame: TranscriptReplayFrame): boolean {
  return isKnownReadyPromptBody(frame.waitText, 'codex', () => frame.screenLines, true)
}

async function allFrames(name: string): Promise<TranscriptReplayFrame[]> {
  const frames: TranscriptReplayFrame[] = []
  for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
    frames.push(frame)
  }
  return frames
}

describe('Codex 0.160 fresh-session readiness from captured bytes', () => {
  it.each(READY_0160_FIXTURES)(
    '0.160 ready: %s is tier-1 ready at its idle screen, which the pre-fix header rule misses',
    async (name) => {
      const last = await finalFrame(name, 120, 40)
      const screen = screenOf(last)
      expect(isTierOneReady(last)).toBe(true)
      expect(findCodexFreshSessionReadyIndex(screen)).not.toBeNull()
      // Negative control: the 0.150-0.158 rules find no ready header on this screen.
      expect(isKnownReadyPromptPreview(last.waitText)).toBe(false)
      expect(isKnownReadyPromptPreview(screen)).toBe(false)
      expect(findCodexScreenReadyPromptIndex(screen)).toBeNull()
    }
  )

  it.each([...READY_0160_FIXTURES, TRUST_0160])(
    '0.160 booting: %s is never ready while loading or before the session paints its status row',
    async (name) => {
      let bootComposerFrames = 0
      let configured = false
      for (const frame of await allFrames(name)) {
        const screen = screenOf(frame)
        // Why latched: a later effort repaint briefly garbles the row; the session stays configured.
        configured ||= frame.screenLines.some((line) => LIVE_STATUS_ROW_RE.test(line.toLowerCase()))
        if (BARE_LOADING_ROW_RE.test(screen) || !configured) {
          bootComposerFrames += EMPTY_COMPOSER_RE.test(screen) ? 1 : 0
          expect(isTierOneReady(frame)).toBe(false)
        }
      }
      // Presence precondition: the composer is painted before the session is configured.
      expect(bootComposerFrames).toBeGreaterThan(0)
    }
  )

  it('0.160 trust dialog: never ready, and blocked once the dialog owns the screen', async () => {
    const frames = await allFrames(TRUST_0160)
    for (const frame of frames) {
      expect(isTierOneReady(frame)).toBe(false)
    }
    const last = frames.at(-1)!
    // Presence precondition: the dialog was painted, not just parsed.
    expect(screenOf(last)).toContain('trust this folder?')
    expect(detectTerminalWaitBlockedReason(last.waitText)).not.toBeNull()
    expect(isQuietReadyScreenBody(last.waitText, 'codex', () => last.screenLines)).toBe(false)
  })

  it('0.160 busy: never ready from the submitted prompt through the last busy frame', async () => {
    const frames = await allFrames(BUSY_0160)
    const submitted = frames.findIndex((frame) =>
      screenOf(frame).includes('› run the shell command')
    )
    const lastBusy = frames.findLastIndex((frame) => BUSY_STATUS_RE.test(screenOf(frame)))
    // Presence preconditions: the cold start was ready, and the turn painted busy rows.
    expect(frames.slice(0, submitted).some(isTierOneReady)).toBe(true)
    expect(lastBusy).toBeGreaterThan(submitted)
    for (let index = submitted; index <= lastBusy; index += 1) {
      expect({ index, ready: isTierOneReady(frames[index]!) }).toEqual({ index, ready: false })
    }
  })

  it('0.160 busy: a busy row above the composer vetoes a fresh-session screen', () => {
    const screenLines = [
      ' >_ OpenAI Codex (v0.160.0)',
      '    ~/repo/app',
      '',
      '• Working (3s • esc to interrupt)',
      '› Ask Codex to do anything',
      '  GPT-6-Luna high · Context 0% used',
      '  ? for shortcuts'
    ]
    expect(isKnownReadyPromptBody('', 'codex', () => screenLines, true)).toBe(false)
    expect(isKnownReadyPromptBody('', 'codex', () => screenLines.toSpliced(3, 1), true)).toBe(true)
  })

  it('never reads the fresh-session screen of a non-codex pane', async () => {
    const last = await finalFrame(READY_0160, 120, 40)
    expect(isKnownReadyPromptBody(last.waitText, 'claude', () => last.screenLines, true)).toBe(
      false
    )
  })

  // Why: the 0.159+ rule must not change what the old header layouts settle on.
  it.each(['codex-0157-plain-ready', 'codex-0158-fresh-home-greeting'])(
    'old 0.157/0.158 layout: %s still settles a tui-idle wait',
    async (name) => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: readRuntimeFixture(name),
        size: { cols: 120, rows: 40 }
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 8_000 })
      ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
    },
    15_000
  )

  describe('through the runtime', () => {
    it.each(READY_0160_FIXTURES)(
      '0.160 ready: %s settles a tui-idle wait before the quiet lane could',
      async (name) => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'codex',
          launchAgent: 'codex',
          data: readRuntimeFixture(name),
          size: { cols: 120, rows: 40 }
        })
        // Why 2.5s: under the 3s quiescence, so only tier 1 can settle it.
        await expect(
          runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
        ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
      },
      15_000
    )

    it('0.160 trust dialog: stops a tui-idle wait instead of typing into it', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: readRuntimeFixture(TRUST_0160),
        size: { cols: 120, rows: 40 }
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).resolves.toMatchObject({ satisfied: false })
    }, 15_000)
  })
})
