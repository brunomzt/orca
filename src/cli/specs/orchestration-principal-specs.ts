import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const identity = ['principal', 'run', 'capability-file']
const write = [...identity, 'expected-generation', 'retry-request']
const route = '--principal <id> --run <id> --capability-file <private-path>'
const generation = '--expected-generation <n>'
const definitions = [
  {
    verb: 'principal-create',
    summary: 'Create a terminal-less coordinator and write its private capability file',
    usage:
      '--provider <claude|codex> --manager-session-id <id> --child-id <id> --project <name> --root-path <path> --objective <text> --speed standard --capability-file <new-private-path> [--generation <n>] [--run <id>] [--retry-request <id>]',
    flags: [
      'provider',
      'manager-session-id',
      'child-id',
      'project',
      'root-path',
      'objective',
      'speed',
      'capability-file',
      'generation',
      'run',
      'retry-request'
    ]
  },
  {
    verb: 'principal-show',
    summary: 'Show a coordinator and its retirement blockers',
    usage: `${route}`,
    flags: identity
  },
  {
    verb: 'principal-reconnect',
    summary: 'Reconnect the same native child and inspect pending work',
    usage: `${route} ${generation} --provider <claude|codex> --manager-session-id <id> --child-id <id>`,
    flags: [...write, 'provider', 'manager-session-id', 'child-id']
  },
  {
    verb: 'principal-recovering',
    summary: 'Mark a lost coordinator as recovering',
    usage: `${route} ${generation} [--reason <text>]`,
    flags: [...write, 'reason']
  },
  {
    verb: 'principal-replace',
    summary: 'Replace a recovering child after loss and rotate its capability',
    usage: `${route} ${generation} --child-id <new-id> --reason loss --new-capability-file <new-private-path> [--retry-request <id>]`,
    flags: [...write, 'child-id', 'reason', 'new-capability-file']
  },
  {
    verb: 'principal-retire',
    summary: 'Request retirement or finish retiring a drained coordinator',
    usage: `${route} ${generation} [--request]`,
    flags: [...write, 'request']
  },
  {
    verb: 'run-intake',
    summary: 'Close or reopen a coordinator Run for new tasks and workers',
    usage: `${route} ${generation} (--close | --open)`,
    flags: [...write, 'close', 'open']
  }
]

export const ORCHESTRATION_PRINCIPAL_COMMAND_SPECS: CommandSpec[] = definitions.map(
  (definition) => ({
    path: ['orchestration', definition.verb],
    summary: definition.summary,
    usage: `orca orchestration ${definition.verb} ${definition.usage} [--json]`,
    allowedFlags: [...GLOBAL_FLAGS, ...definition.flags],
    notes: [
      'Set ORCA_COORDINATOR_ROUTING=principal and remove terminal, pane, and agent-session identity from the environment.',
      'Capability files require a private directory and owner-only file permissions. Secrets are never printed.',
      ...(definition.verb === 'principal-show' || definition.verb === 'principal-retire'
        ? [
            'An already-retired principal supports an id-only read or same-generation retirement retry without --capability-file.'
          ]
        : [])
    ]
  })
)
