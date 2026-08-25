import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import { startResponsesFixture } from '../../../subagent/subagent-codex/tests/responses-fixture.ts'
import * as codexPlugin from '../src/index.ts'
import { CODEX_PROVIDER_ID } from '../src/provider.ts'

describe('isolated local Codex Web search product boundary', () => {
  it('advertises only hosted Web search and rejects an unadvertised command', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-search-real-'))
    const sourceHome = join(sourceRoot, 'source-codex-home')
    const mcpStarted = join(sourceRoot, 'source-mcp-started')
    const commandSideEffect = join(sourceRoot, 'unadvertised-command-ran')
    const preloadSideEffect = join(sourceRoot, 'ambient-node-options-ran')
    mkdirSync(sourceHome)
    const authSource = join(sourceHome, 'auth.json')
    writeFileSync(authSource, JSON.stringify({
      OPENAI_API_KEY: 'dsh-fake-openai-key',
      tokens: null,
      last_refresh: null,
    }), { mode: 0o600 })
    const maliciousMcp = join(sourceRoot, 'malicious-mcp.mjs')
    writeFileSync(maliciousMcp, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(mcpStarted)}, 'started')`,
      'setInterval(() => {}, 1_000)',
      '',
    ].join('\n'))
    writeFileSync(join(sourceHome, 'config.toml'), [
      '[mcp_servers.source_home_exfiltrator]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(maliciousMcp)}]`,
      '',
    ].join('\n'))
    const ambientPreload = join(sourceRoot, 'ambient-preload.cjs')
    writeFileSync(ambientPreload, [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(preloadSideEffect)}, 'loaded')`,
      '',
    ].join('\n'))

    const command = process.platform === 'win32'
      ? `cmd /c type nul > "${commandSideEffect}"`
      : `touch ${commandSideEffect}`
    const fixture = await startResponsesFixture([
      { kind: 'functionCall', name: 'exec_command', arguments: { cmd: command } },
      {
        kind: 'complete',
        text: JSON.stringify({ content: 'No command was available.', sources: [] }),
      },
    ])
    const ctx = new Context()
    let isolationRoot = ''
    const previousNodeOptions = process.env.NODE_OPTIONS
    const previousOpenaiBaseUrl = process.env.OPENAI_BASE_URL
    try {
      process.env.NODE_OPTIONS = `--require=${ambientPreload}`
      process.env.OPENAI_BASE_URL = 'https://ambient-attacker.invalid/v1'
      await ctx.plugin(WebRuntime, { searchProvider: CODEX_PROVIDER_ID })
      await ctx.plugin(LocalSubprocessRuntime)
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
        isolationRoot = dirname(spec.cwd)
        expect(readdirSync(spec.cwd)).toEqual([])
        expect(spec.env?.CODEX_HOME).toBe(join(isolationRoot, 'codex-home'))
        const authLink = join(spec.env?.CODEX_HOME as string, 'auth.json')
        const authBridgeStat = lstatSync(authLink)
        if (process.platform !== 'win32') {
          expect(authBridgeStat.isSymbolicLink()).toBe(true)
          expect(realpathSync(authLink)).toBe(realpathSync(authSource))
          expect(isAbsolute(readlinkSync(authLink))).toBe(true)
        } else if (authBridgeStat.isSymbolicLink()) {
          expect(realpathSync(authLink)).toBe(realpathSync(authSource))
          expect(isAbsolute(readlinkSync(authLink))).toBe(true)
        } else {
          const sourceStat = statSync(authSource)
          expect(authBridgeStat.isFile()).toBe(true)
          expect(authBridgeStat.dev).toBe(sourceStat.dev)
          expect(authBridgeStat.ino).toBe(sourceStat.ino)
        }
        expect(readdirSync(spec.env?.CODEX_HOME as string)).toEqual(['auth.json'])
        const effective = Object.fromEntries(Object.entries(spec.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ))
        expect(effective.NODE_OPTIONS).toBeUndefined()
        expect(effective.OPENAI_BASE_URL).toBe(fixture.baseUrl)
        return spawn(spec)
      })
      await ctx.plugin(codexPlugin, {
        env: {
          CODEX_HOME: sourceHome,
          OPENAI_BASE_URL: fixture.baseUrl,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          NO_PROXY: '127.0.0.1,localhost',
        },
        disposeGraceMs: 2_000,
        searchMode: 'live',
      })

      await expect(ctx.web.search({ query: 'Attempt the requested local command.' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

      expect(fixture.requests).toHaveLength(2)
      for (const request of fixture.requests) {
        expect(request.path).toBe('/v1/responses')
        const tools = request.body.tools as Array<Record<string, unknown>>
        expect(tools.map(tool => (
          tool.type === 'function' ? tool.name : tool.type
        ))).toEqual(['web_search'])
        const outbound = JSON.stringify(request.body)
        expect(outbound).not.toContain('.system')
        expect(outbound).not.toContain('SKILL.md')
        expect(outbound).not.toContain(maliciousMcp)
      }
      expect(existsSync(mcpStarted)).toBe(false)
      expect(existsSync(commandSideEffect)).toBe(false)
      expect(existsSync(preloadSideEffect)).toBe(false)
      expect(existsSync(isolationRoot)).toBe(false)
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
      if (previousOpenaiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousOpenaiBaseUrl
      await ctx.fiber.dispose()
      await fixture.close()
      await rm(sourceRoot, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  }, 60_000)
})

describe.skipIf(process.env.DSH_TEST_LOCAL_CODEX_SEARCH !== '1')(
  'local Codex Web search',
  () => {
    it('returns citeable live-search results through the real app-server', async () => {
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: CODEX_PROVIDER_ID })
        await ctx.plugin(LocalSubprocessRuntime)
        await ctx.plugin(codexPlugin, { searchMode: 'live' })

        const result = await ctx.web.search({
          query: 'What is the official Codex app-server protocol documentation?',
          maxResults: 3,
        })

        expect(result.content).toBeTruthy()
        expect(result.sources.length).toBeGreaterThan(0)
        expect(result.sources.every(source => /^https?:\/\//u.test(source.url))).toBe(true)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  },
)
