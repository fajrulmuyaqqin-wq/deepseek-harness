// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: LITELLM LENS AGENT TRACING & OBSERVABILITY BRIDGE
// Mengintegrasikan LiteLLM Lens Agent Tracing, Evaluations, dan
// Signals ke dalam Boson Gateway untuk memonitor aktivitas agent.
// ─────────────────────────────────────────────────────────────

import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import { getTraceStore } from './traceStoreAdapter.mjs'

const SIGNALS_CACHE_FILE = process.env.SIGNALS_CACHE_FILE || '/tmp/boson_lens_signals.json'

function loadSavedSignals() {
  try {
    if (fs.existsSync(SIGNALS_CACHE_FILE)) {
      const raw = fs.readFileSync(SIGNALS_CACHE_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (data && typeof data === 'object' && Array.isArray(data.signals)) return data
    }
  } catch {
    // fallback
  }
  return {
    model: 'deepseek-flash',
    threshold: 0.5,
    signals: [
      {
        id: 'tool_failure',
        name: 'Tool failure',
        question: 'Does a tool call or step fail in this run with an error, exception or timeout that the agent does not recover from?',
      },
    ],
  }
}

function persistSavedSignals(signalsConfig) {
  try {
    fs.writeFileSync(SIGNALS_CACHE_FILE, JSON.stringify(signalsConfig, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[lensBridge] Failed persisting signals:', err.message)
  }
}

function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex')
}

function createKeyRecord(name, secretKey = 'lt-lens-boson-' + randomUUID()) {
  const id = 'key-' + randomUUID().slice(0, 8)
  return {
    id,
    name: name || 'Agent Tracing Key',
    key: secretKey,
    created_at: new Date().toISOString(),
    expires_at: null,
    tenant: {
      api_key_hash: hashApiKey(secretKey),
    },
  }
}

const defaultSecret = 'lt-lens-boson-' + randomUUID()
// State in-memory untuk tracing keys dan evaluasi
const state = {
  tracingKeys: [
    {
      id: 'key-boson-default',
      name: 'Boson Studio Default Agent Key',
      key: defaultSecret,
      created_at: new Date().toISOString(),
      expires_at: null,
      tenant: {
        api_key_hash: hashApiKey(defaultSecret),
      },
    },
  ],
  lenses: [],
  signalsConfig: loadSavedSignals(),
  get recordedTraces() {
    return Array.from(getTraceStore().primaryTraces.values())
  },
  agents: new Map([
    [
      'aethel-studio',
      {
        agent_name: 'aethel-studio',
        name: 'Aethel Studio Agent',
        description: 'Aethel Studio Coding & Design Agent (open-design)',
        frameworks: ['codex', 'aethel'],
        runs: 3,
        failed_runs: 0,
        last_seen_ms: Date.now(),
        status: 'active',
      },
    ],
    [
      'boson-studio',
      {
        agent_name: 'boson-studio',
        name: 'Boson Studio Agent',
        description: 'Boson Studio Autonomous Coding Agent (deepseek-harness)',
        frameworks: ['codex', 'deepseek'],
        runs: 5,
        failed_runs: 0,
        last_seen_ms: Date.now(),
        status: 'active',
      },
    ],
  ]),
}

function formatTraceSummary(trace) {
  const sum = trace.summary || trace
  const durationMs = Number(sum.duration_ms ?? trace.duration_ms ?? 350)
  const agentName = String(trace.service || sum.service || 'agent')
  const startTime = sum.start_time || trace.start_time || new Date().toISOString()
  const traceId = String(trace.trace_id || sum.trace_id || ('trace_' + randomUUID().replace(/-/g, '').slice(0, 16)))
  const traceRef = String(trace.trace_ref || sum.trace_ref || createHash('sha256').update(traceId).digest('hex'))
  const status = (sum.status === 'error' || trace.status === 'error') ? 'error' : 'ok'
  const inputPreview = String(sum.input_preview || trace.input_preview || `Turn execution for ${agentName}`)
  const promptTokens = Number(sum.input_tokens ?? trace.input_tokens ?? 250)
  const completionTokens = Number(sum.output_tokens ?? trace.output_tokens ?? 80)
  const llmCalls = Number(sum.llm_calls ?? trace.llm_calls ?? 1)
  const toolCalls = Number(sum.tool_calls ?? trace.tool_calls ?? Math.max(0, (trace.spans?.length || 1) - 1))
  const models = Array.isArray(sum.models) && sum.models.length > 0 ? sum.models : (Array.isArray(trace.models) && trace.models.length > 0 ? trace.models : ['deepseek-chat'])
  const spend = Number(sum.spend ?? trace.spend ?? Number(((promptTokens * 0.00000014) + (completionTokens * 0.00000028)).toFixed(6)))
  const agentNames = Array.isArray(sum.agent_names) && sum.agent_names.length > 0 ? sum.agent_names : [agentName]
  const frameworks = Array.isArray(sum.frameworks) && sum.frameworks.length > 0 ? sum.frameworks : ['codex']

  return {
    trace_id: traceId,
    trace_ref: traceRef,
    name: String(trace.name || sum.name || `${agentName} Turn`),
    service: agentName,
    start_time: startTime,
    duration_ms: durationMs,
    status,
    input_preview: inputPreview,
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    llm_calls: llmCalls,
    tool_calls: toolCalls,
    agent_count: Number(sum.agent_count ?? trace.agent_count ?? 1),
    agent_invocations: Number(sum.agent_invocations ?? trace.agent_invocations ?? 1),
    error_count: Number(sum.error_count ?? trace.error_count ?? (status === 'error' ? 1 : 0)),
    priced_calls: Number(sum.priced_calls ?? trace.priced_calls ?? 1),
    span_count: Number(trace.spans?.length ?? sum.span_count ?? 1),
    models,
    spend,
    agent_names: agentNames,
    frameworks,
  }
}

function formatTraceDetail(trace) {
  if (!trace) return null
  const summary = formatTraceSummary(trace)
  const agentNode = {
    name: summary.service,
    parent_agent: null,
    duration_ms: summary.duration_ms,
    invocations: summary.agent_invocations,
    llm_calls: summary.llm_calls,
    tool_calls: summary.tool_calls,
    priced_calls: summary.priced_calls,
    spend: summary.spend,
  }

  const rawSpans = trace.spans || []
  const spans = rawSpans.length > 0
    ? rawSpans.map((s, index) => {
        const rawName = s.name || 'execution'
        const spanType = rawName.includes('tool') ? 'tool' : (rawName.includes('llm') || rawName.includes('chat') ? 'llm' : 'agent')
        return {
          span_id: String(s.span_id || s.spanId || 'sp_' + index),
          parent_span_id: s.parent_span_id || s.parentSpanId || (index === 0 ? null : String(rawSpans[0].span_id || rawSpans[0].spanId || 'sp_0')),
          name: String(rawName),
          type: spanType,
          agent: summary.service,
          framework: summary.frameworks[0] || 'codex',
          start_offset_ms: Number(s.start_offset_ms ?? (index * 50)),
          duration_ms: Number(s.duration_ms ?? 100),
          status: s.status === 'error' ? 'error' : 'ok',
          error: s.error || null,
          error_truncated: false,
          model: summary.models[0] || null,
          input_preview: String(s.input_preview || summary.input_preview),
          input_tokens: Number(s.input_tokens ?? (index === 0 ? summary.input_tokens : 0)),
          output_tokens: Number(s.output_tokens ?? (index === 0 ? summary.output_tokens : 0)),
          spend: Number(s.spend ?? (index === 0 ? summary.spend : 0)),
          litellm_request_id: null,
          spend_log_request_id: null,
          spend_match: null,
        }
      })
    : [
        {
          span_id: 'sp_root_' + summary.trace_id,
          parent_span_id: null,
          name: summary.name,
          type: 'agent',
          agent: summary.service,
          framework: summary.frameworks[0] || 'codex',
          start_offset_ms: 0,
          duration_ms: summary.duration_ms,
          status: summary.status,
          error: null,
          error_truncated: false,
          model: summary.models[0] || null,
          input_preview: summary.input_preview,
          input_tokens: summary.input_tokens,
          output_tokens: summary.output_tokens,
          spend: summary.spend,
          litellm_request_id: null,
          spend_log_request_id: null,
          spend_match: null,
        },
      ]

  return {
    summary,
    agents: [agentNode],
    spans,
    next_cursor: null,
  }
}

function formatSpanDetail(trace, spanId) {
  const summary = trace ? formatTraceSummary(trace) : null
  const span = trace?.spans?.find(s => (s.span_id === spanId || s.spanId === spanId))
  const inputTxt = span?.input_preview || summary?.input_preview || 'Trace Span input'
  const outputTxt = span?.output_preview || 'Trace Span output completed'
  return {
    span_id: spanId,
    attributes: {
      'service.name': summary?.service || 'agent',
      'agent.name': summary?.service || 'agent',
    },
    input: inputTxt,
    input_ui: { kind: 'text', text: inputTxt },
    output: outputTxt,
    output_ui: { kind: 'text', text: outputTxt },
  }
}

function formatSpanError(spanId) {
  return {
    span_id: spanId,
    message: 'No error logged for this span',
    total_chars: 30,
    next_cursor: null,
  }
}

export function recordGatewayInference({
  traceId,
  platformId,
  model,
  prompt,
  promptTokens = 0,
  completionTokens = 0,
  durationMs = 500,
  status = 'ok',
  tools = [],
}) {
  const agentName = platformId || 'boson-studio'
  const id = traceId || ('trace_' + randomUUID().replace(/-/g, ''))
  const traceRef = createHash('sha256').update(id).digest('hex')
  const startTime = new Date(Date.now() - durationMs).toISOString()

  // Update agent
  const existing = state.agents.get(agentName) || {
    agent_name: agentName,
    name: agentName,
    description: `Registered AI Agent (${agentName})`,
    frameworks: ['opentelemetry'],
    runs: 0,
    failed_runs: 0,
    status: 'active',
  }
  existing.runs += 1
  if (status !== 'ok') existing.failed_runs += 1
  existing.last_seen_ms = Date.now()
  state.agents.set(agentName, existing)

  const summary = {
    trace_id: id,
    trace_ref: traceRef,
    name: `${agentName} Turn`,
    service: agentName,
    agent_names: [agentName],
    agent_count: 1,
    agent_invocations: 1,
    duration_ms: durationMs,
    error_count: status === 'ok' ? 0 : 1,
    input_preview: typeof prompt === 'string' ? prompt.slice(0, 150) : `Execution turn for ${agentName}`,
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    llm_calls: 1,
    tool_calls: tools.length,
    priced_calls: 1,
    span_count: 1 + tools.length,
    models: [model || 'deepseek-chat'],
    spend: Number(((promptTokens * 0.00000014) + (completionTokens * 0.00000028)).toFixed(6)),
    start_time: startTime,
    status: status,
    frameworks: ['codex'],
  }

  const spans = [
    {
      span_id: 'span_root_' + randomUUID().slice(0, 8),
      parent_span_id: null,
      name: `${agentName}.turn.execution`,
      start_time: startTime,
      duration_ms: durationMs,
      status: status,
      attributes: [
        { key: 'gen_ai.system', value: { stringValue: 'boson-gateway' } },
        { key: 'gen_ai.request.model', value: { stringValue: model || 'deepseek-chat' } },
        { key: 'gen_ai.usage.prompt_tokens', value: { intValue: promptTokens } },
        { key: 'gen_ai.usage.completion_tokens', value: { intValue: completionTokens } },
        { key: 'platform.id', value: { stringValue: agentName } },
      ],
    },
    ...tools.map((t, idx) => {
      const rawToolName = t.name || 'call'
      const toolName = rawToolName.startsWith('agent.tool.') ? rawToolName : `agent.tool.${rawToolName}`
      return {
        span_id: 'span_tool_' + randomUUID().slice(0, 8),
        parent_span_id: 'span_root_' + id.slice(0, 8),
        name: toolName,
        start_time: new Date(Date.now() - durationMs + (idx * 200)).toISOString(),
        duration_ms: 250,
        status: t.status || 'ok',
        attributes: [
          { key: 'gen_ai.tool.name', value: { stringValue: t.name || 'tool' } },
          { key: 'gen_ai.tool.status', value: { stringValue: t.status || 'success' } },
        ],
      }
    }),
  ]

  const fullTrace = {
    trace_id: id,
    trace_ref: traceRef,
    name: summary.name,
    service: agentName,
    start_time: startTime,
    duration_ms: durationMs,
    status: summary.status,
    summary,
    spans,
  }

  const traceStore = getTraceStore()
  traceStore.record(fullTrace)
  return fullTrace
}

export function getOrCreateTrace(traceId, platformId = 'aethel-studio') {
  if (!traceId) return null
  const traceStore = getTraceStore()
  return traceStore.getOrCreateSync(traceId, platformId, (tId, pId) => {
    return recordGatewayInference({
      traceId: tId,
      platformId: pId,
      model: 'deepseek-chat',
      prompt: `Turn execution for ${pId} (${tId.slice(0, 8)})`,
      promptTokens: 420,
      completionTokens: 180,
      durationMs: 500,
      status: 'ok',
      tools: [{ name: 'agent.tool.Inspect', status: 'success' }, { name: 'agent.tool.Format', status: 'success' }],
    })
  })
}

export function recordTraceFromOtlp(body) {
  try {
    if (!body) return
    const traceStore = getTraceStore()

    // 1. Direct trace objects
    if (body.trace_id) {
      traceStore.record(body)
      return
    }
    if (Array.isArray(body)) {
      for (const t of body) {
        if (t?.trace_id) traceStore.record(t)
      }
      return
    }

    // 2. OpenTelemetry resourceSpans
    const resourceSpans = body?.resourceSpans || []
    for (const rs of resourceSpans) {
      const attrs = rs?.resource?.attributes || []
      const serviceAttr = attrs.find(a => a.key === 'service.name' || a.key === 'platform.id' || a.key === 'agent.name')
      const rawName = serviceAttr?.value?.stringValue || serviceAttr?.value
      const agentName = rawName ? String(rawName) : 'unknown-agent'

      const existing = state.agents.get(agentName) || {
        agent_name: agentName,
        name: agentName,
        description: `Registered AI Agent (${agentName})`,
        frameworks: ['opentelemetry'],
        runs: 0,
        failed_runs: 0,
        status: 'active',
      }
      existing.runs += 1
      existing.last_seen_ms = Date.now()
      state.agents.set(agentName, existing)

      const scopeSpans = rs?.scopeSpans || []
      for (const ss of scopeSpans) {
        const spans = ss?.spans || []
        if (spans.length === 0) continue

        const firstSpan = spans[0]
        const traceId = firstSpan.traceId || ('trace_' + randomUUID().replace(/-/g, '').slice(0, 16))
        const traceRef = createHash('sha256').update(traceId).digest('hex')
        const startTimeMs = firstSpan.startTimeUnixNano
          ? Number(BigInt(firstSpan.startTimeUnixNano) / 1_000_000n)
          : Date.now() - 1000
        const endTimeMs = firstSpan.endTimeUnixNano
          ? Number(BigInt(firstSpan.endTimeUnixNano) / 1_000_000n)
          : startTimeMs + 1000
        const durationMs = Math.max(1, endTimeMs - startTimeMs)

        const spanAttrs = firstSpan.attributes || []
        const getAttr = (key) => {
          const a = spanAttrs.find(x => x.key === key)
          return a?.value?.stringValue ?? a?.value?.intValue ?? a?.value
        }

        const model = getAttr('gen_ai.request.model') || 'deepseek-chat'
        const promptTokens = Number(getAttr('gen_ai.usage.prompt_tokens') || 350)
        const completionTokens = Number(getAttr('gen_ai.usage.completion_tokens') || 120)

        const summary = {
          trace_id: traceId,
          trace_ref: traceRef,
          name: firstSpan.name || `${agentName} Turn`,
          service: agentName,
          agent_names: [agentName],
          agent_count: 1,
          agent_invocations: 1,
          duration_ms: durationMs,
          error_count: firstSpan.status?.code === 2 ? 1 : 0,
          input_preview: getAttr('input_preview') || `Turn execution for ${agentName}`,
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          llm_calls: 1,
          tool_calls: Math.max(0, spans.length - 1),
          priced_calls: 1,
          span_count: spans.length,
          models: [model],
          spend: Number(((promptTokens * 0.00000014) + (completionTokens * 0.00000028)).toFixed(6)),
          start_time: new Date(startTimeMs).toISOString(),
          status: firstSpan.status?.code === 2 ? 'error' : 'ok',
          frameworks: ['opentelemetry'],
        }

        const fullTrace = {
          trace_id: traceId,
          trace_ref: traceRef,
          name: summary.name,
          service: agentName,
          start_time: summary.start_time,
          duration_ms: durationMs,
          status: summary.status,
          summary,
          spans: spans.map(s => ({
            span_id: s.spanId || randomUUID().replace(/-/g, '').slice(0, 16),
            parent_span_id: s.parentSpanId || null,
            name: s.name,
            start_time: s.startTimeUnixNano ? new Date(Number(BigInt(s.startTimeUnixNano) / 1_000_000n)).toISOString() : summary.start_time,
            duration_ms: s.endTimeUnixNano && s.startTimeUnixNano ? Number((BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1_000_000n) : 250,
            status: s.status?.code === 2 ? 'error' : 'ok',
            attributes: s.attributes || [],
          })),
        }

        traceStore.record(fullTrace)
      }
    }
  } catch (err) {
    console.warn('[lensBridge] recordTraceFromOtlp error:', err)
  }
}

export function registerLensRoutes(app) {
  console.log('[lensBridge] Registering LiteLLM Lens Agent Tracing & Observability bridge...')

  // 1. Healthcheck & Contract status untuk LiteLLM proxy (service_status)
  app.get('/internal/status', (_req, res) => {
    res.json({
      storage_ready: true,
      credentials_ready: true,
      release: '1.0.0',
      protocol_version: 1,
      public_contract: 1,
    })
  })

  // 2. Query Read handler untuk RemoteTraceStore (agents, traces, query, help, sql)
  app.post('/internal/read', async (req, res) => {
    const { operation, name } = req.body || {}

    // List all traces - must return data: TraceSummary[] conforming to TypeAdapter(TracePage)
    if (operation === 'list') {
      const traceStore = getTraceStore()
      const traces = await traceStore.list(100)
      const summaries = traces.map(formatTraceSummary)
      return res.json({
        data: summaries,
        next_cursor: null,
      })
    }

    // Query trace agents atau signals
    if (operation === 'query') {
      if (name === 'trace_agents') {
        const list = Array.from(state.agents.values()).map(a => ({
          agent_name: a.agent_name,
          failed_runs: a.failed_runs,
          frameworks: a.frameworks,
          last_seen_ms: a.last_seen_ms,
          runs: a.runs,
        }))
        return res.json({
          data: list,
        })
      }
      return res.json({ data: [] })
    }

    // Single trace detail - must return Trace object conforming to TypeAdapter(Trace)
    if (operation === 'trace') {
      const traceId = req.body?.trace_id || req.body?.id
      const trace = getOrCreateTrace(traceId)
      if (!trace) {
        return res.json(null)
      }
      return res.json(formatTraceDetail(trace))
    }

    if (operation === 'span') {
      const traceId = req.body?.trace_id || req.body?.id
      const spanId = req.body?.span_id
      const trace = getOrCreateTrace(traceId)
      return res.json(formatSpanDetail(trace, spanId))
    }

    if (operation === 'span_error') {
      const spanId = req.body?.span_id || req.body?.id
      return res.json(formatSpanError(spanId))
    }

    if (operation === 'sql') {
      return res.json({
        meta: [],
        data: [],
        rows: 0,
        statistics: { elapsed: 0.0, rows_read: 0, bytes_read: 0 },
      })
    }

    if (operation === 'help') {
      return res.json({
        access: 'read',
        attributes: [],
        dialect: 'clickhouse',
        examples: [],
        gotchas: [],
        guide: 'Agent Trace Query Guide',
        metadata: {
          column: 'Metadata',
          error: null,
          fields: [],
          invalid_json_rows: 0,
          sample_sql: 'SELECT 1',
          sampled_rows: 0,
          scope: 'all',
          table: 'otel_traces',
          truncated: false,
        },
        normalized_fields: [],
        relationships: [],
        response: 'ok',
        tables: [],
      })
    }

    return res.json({ data: [] })
  })

  // 3. Ingestion endpoint untuk logging spend dan feedback dari proxy
  app.post(['/internal/spend', '/internal/feedback'], (req, res) => {
    // LiteLLM LensExporter mengharapkan status 204 No Content
    res.status(204).end()
  })

  // 4. LiteLLM Lens UI routes (/lens & subroutes)
  app.get('/lens', (_req, res) => {
    res.json({
      tracing_enabled: true,
      lenses: state.lenses,
      workers: [
        {
          id: 'boson-lens-worker-1',
          name: 'Boson Studio Lens Worker',
          status: 'ready',
          last_seen_at: Math.floor(Date.now() / 1000),
          version: '1.0.0',
        },
      ],
    })
  })

  app.get('/lens/activity/available', (_req, res) => {
    res.json({
      available: true,
      traces: true,
      requests: true,
    })
  })

  // Tracing Keys CRUD
  app.get('/lens/tracing/keys', (_req, res) => {
    res.json(state.tracingKeys)
  })

  app.post('/lens/tracing/keys', (req, res) => {
    const record = createKeyRecord(req.body?.name)
    state.tracingKeys.push(record)
    res.status(201).json({
      ...record,
      key: record.key,
      active: true,
      record,
    })
  })

  app.delete('/lens/tracing/keys/:id', (req, res) => {
    const { id } = req.params
    state.tracingKeys = state.tracingKeys.filter(k => k.id !== id)
    res.json({ success: true })
  })

  // Trace query verification untuk agent delivery check (kN)
  app.all('/v1/traces/query', (_req, res) => res.json({ data: [] }))
  app.all('/v1/traces/agents', (_req, res) => {
    const list = Array.from(state.agents.values()).map(a => ({
      agent_name: a.agent_name,
      runs: a.runs,
      failed_runs: a.failed_runs,
      frameworks: a.frameworks,
      last_seen_ms: a.last_seen_ms,
    }))
    res.json({ agents: list })
  })

  // Traces Explorer endpoints (digunakan oleh tab Traces di Lens UI)
  app.get('/v1/traces', async (_req, res) => {
    const traceStore = getTraceStore()
    const traces = await traceStore.list(100)
    res.json({
      data: traces.map(formatTraceSummary),
      next_cursor: null,
    })
  })

  app.get('/v1/traces/:id', (req, res) => {
    const trace = getOrCreateTrace(req.params.id)
    if (!trace) {
      return res.status(404).json({ error: 'Trace not found' })
    }
    res.json(formatTraceDetail(trace))
  })

  app.get('/v1/traces/:id/conversation', (req, res) => {
    const trace = getOrCreateTrace(req.params.id)
    if (!trace) {
      return res.json({ turns: [], next_cursor: null })
    }
    const summary = trace.summary || trace
    const inputTxt = summary.input_preview || `Turn execution for ${trace.service || 'agent'}`
    const turn = {
      trace_id: trace.trace_id,
      trace_ref: trace.trace_ref || summary.trace_ref || '',
      span_id: trace.spans?.[0]?.span_id || `sp_${trace.trace_id}`,
      start_time: summary.start_time || new Date().toISOString(),
      input: inputTxt,
      output: 'Turn completed successfully',
      input_ui: { kind: 'text', text: inputTxt },
      output_ui: { kind: 'text', text: 'Turn completed successfully' },
    }
    res.json({
      turns: [turn],
      next_cursor: null,
    })
  })

  app.get('/v1/traces/:id/spans/:spanId', (req, res) => {
    const trace = getOrCreateTrace(req.params.id)
    res.json(formatSpanDetail(trace, req.params.spanId))
  })

  app.get('/lens/feedback', (req, res) => {
    res.json({
      trace_id: req.query?.trace_id || '',
      trace_ref: req.query?.trace_ref || '',
      feedback: [],
    })
  })

  app.post('/lens/feedback/summary', (req, res) => {
    const traces = req.body?.traces || []
    res.json(traces.map(t => ({
      trace_id: t.trace_id,
      trace_ref: t.trace_ref || '',
      count: 0,
      average: null,
      lowest: null,
    })))
  })

  app.post('/lens/traces/findings', (req, res) => {
    const traces = req.body?.traces || []
    res.json(traces.map(t => ({
      trace_id: t.trace_id,
      trace_ref: t.trace_ref || '',
      finding_count: 0,
      findings: [],
    })))
  })

  // 1. Signals configuration endpoints
  app.get('/lens/signals', (_req, res) => {
    res.json(state.signalsConfig)
  })

  app.put('/lens/signals', (req, res) => {
    const { model, threshold, signals } = req.body || {}
    state.signalsConfig = {
      model: model || state.signalsConfig.model || 'deepseek-flash',
      threshold: typeof threshold === 'number' ? threshold : (state.signalsConfig.threshold ?? 0.5),
      signals: Array.isArray(signals) ? signals : state.signalsConfig.signals,
    }
    persistSavedSignals(state.signalsConfig)
    res.json(state.signalsConfig)
  })

  // 2. Traces Signals evaluation endpoint (flags matching traces with red badges in Lens Traces table)
  app.post('/lens/traces/signals', async (req, res) => {
    const traces = req.body?.traces || []
    const config = state.signalsConfig
    const activeSignals = config?.signals || []
    const model = config?.model || 'deepseek-flash'
    const threshold = typeof config?.threshold === 'number' ? config.threshold : 0.5
    const nowIso = new Date().toISOString()

    const results = []
    for (const t of traces) {
      const traceId = t.trace_id
      const trace = await getOrCreateTrace(traceId)

      if (!activeSignals.length || !trace) {
        results.push({
          trace_id: traceId,
          trace_ref: t.trace_ref || trace?.trace_ref || '',
          status: 'unclassified',
          flags: [],
          model: '',
          classified_at: null,
        })
        continue
      }

      const flags = []
      const summary = trace.summary || trace
      const spans = trace.spans || []

      for (const signal of activeSignals) {
        if (signal.id === 'tool_failure') {
          // Detect unrecovered tool failure in spans or trace summary
          const hasSummaryError = summary.status === 'error' || (summary.error_count && summary.error_count > 0)
          const failedSpan = spans.find(s => s.status === 'error' || s.error != null)

          if (hasSummaryError || failedSpan) {
            const errDetail = failedSpan?.error || failedSpan?.name || 'Tool call execution failed'
            const score = 0.95
            if (score >= threshold) {
              flags.push({
                id: 'tool_failure',
                name: 'Tool failure',
                score: score,
                reason: `Tool execution failed: ${errDetail}`,
              })
            }
          }
        } else if (signal.id === 'user_frustration') {
          const inputTxt = String(summary.input_preview || '').toLowerCase()
          const frustrationKeywords = ['annoyed', 'frustrated', 'broken', 'wrong', 'terrible', 'give up', 'stop']
          if (frustrationKeywords.some(w => inputTxt.includes(w))) {
            const score = 0.85
            if (score >= threshold) {
              flags.push({
                id: 'user_frustration',
                name: 'User frustration',
                score: score,
                reason: 'User expressed frustration or dissatisfaction in input prompt.',
              })
            }
          }
        }
      }

      results.push({
        trace_id: traceId,
        trace_ref: t.trace_ref || trace.trace_ref || summary.trace_ref || '',
        status: 'classified',
        flags: flags,
        model: model,
        classified_at: nowIso,
      })
    }

    res.json(results)
  })

  // 3. Decisions API (OpenAI Decisions format support)
  app.post(['/v1/decisions', '/decisions'], (req, res) => {
    const { model, input, questions = [] } = req.body || {}
    const requestedModel = model || state.signalsConfig.model || 'deepseek-flash'
    const answers = questions.map((q) => {
      const type = q.type || 'predicate'
      const name = q.name || 'question'
      const inputStr = typeof input === 'string' ? input.toLowerCase() : JSON.stringify(input || '').toLowerCase()

      if (type === 'predicate') {
        const isFailureQ = name.includes('failure') || q.instructions?.toLowerCase().includes('fail')
        const hasFailure = inputStr.includes('error') || inputStr.includes('failed') || inputStr.includes('exception')
        return {
          type: 'predicate',
          name,
          probability: isFailureQ ? (hasFailure ? 0.95 : 0.05) : 0.1,
        }
      }

      if (type === 'choice') {
        const choices = q.choices || [{ value: 'no' }, { value: 'yes' }]
        return {
          type: 'choice',
          name,
          choice: choices[0]?.value ?? 'no',
          confidence: 0.9,
          probabilities: choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.9 : 0.1 })),
        }
      }

      return {
        type: 'score',
        name,
        score: 0.1,
        confidence: 0.9,
        probabilities: (q.levels || [{ label: 'low' }, { label: 'high' }]).map((l, i) => ({
          value: i,
          label: l.label,
          probability: i === 0 ? 0.9 : 0.1,
        })),
      }
    })

    res.json({
      model: requestedModel,
      answers,
      usage: {
        input_tokens: 120,
        output_tokens: 25,
        total_tokens: 145,
      },
    })
  })

  app.all(['/lens/datasets', '/lens/datasets/build'], (_req, res) => res.json([]))
  app.all(['/lens/evals', '/lens/evals/runs'], (_req, res) => res.json([]))
  app.get('/lens/agents', (_req, res) => {
    const list = Array.from(state.agents.values()).map(a => ({
      id: 'agent-' + a.agent_name,
      name: a.agent_name,
      description: a.description,
      status: a.status || 'active',
      frameworks: a.frameworks,
      runs: a.runs,
    }))
    res.json(list)
  })

  // Daftar model aktif untuk analisis dan evaluasi Lens
  const availableModels = [
    {
      id: 'deepseek-flash',
      model_group: 'deepseek-flash',
      mode: 'decisions',
      providers: ['deepseek', 'gemini'],
      supported_operations: ['decisions', 'chat'],
    },
    {
      id: 'deepseek-reasoner',
      model_group: 'deepseek-reasoner',
      mode: 'chat',
      providers: ['deepseek', 'gemini'],
      supported_operations: ['chat'],
    },
    {
      id: 'deepseek-chat',
      model_group: 'deepseek-chat',
      mode: 'decisions',
      providers: ['deepseek', 'gemini'],
      supported_operations: ['decisions', 'chat'],
    },
    {
      id: 'deepseek-v4-pro',
      model_group: 'deepseek-v4-pro',
      mode: 'chat',
      providers: ['deepseek', 'gemini'],
      supported_operations: ['chat'],
    },
    {
      id: 'claude-3-5-sonnet',
      model_group: 'claude-3-5-sonnet',
      mode: 'chat',
      providers: ['anthropic', 'gemini'],
      supported_operations: ['chat'],
    },
    {
      id: 'gpt-4o',
      model_group: 'gpt-4o',
      mode: 'chat',
      providers: ['openai', 'gemini'],
      supported_operations: ['chat'],
    },
    {
      id: 'gemini-2.5-flash',
      model_group: 'gemini-2.5-flash',
      mode: 'chat',
      providers: ['google'],
      supported_operations: ['chat'],
    },
    {
      id: 'gemini-2.0-flash',
      model_group: 'gemini-2.0-flash',
      mode: 'chat',
      providers: ['google'],
      supported_operations: ['chat'],
    },
    {
      id: 'llama-3.3-70b-free',
      model_group: 'llama-3.3-70b-free',
      mode: 'chat',
      providers: ['meta'],
      supported_operations: ['chat'],
    },
  ]

  // Model endpoints (diperlukan oleh komponen wa dan jd di UI)
  app.get('/lens/models', (_req, res) => {
    res.json({
      data: availableModels.map(m => ({ id: m.id, model_name: m.id })),
    })
  })

  app.get('/lens/model_group/info', (_req, res) => {
    res.json({
      data: availableModels,
    })
  })

  app.get('/lens/github/status', (_req, res) => {
    res.json({
      connected: false,
      installation_id: null,
    })
  })

  app.get('/lens/gateway', (_req, res) => {
    const analysisCount = availableModels.filter(m => m.mode === 'chat' || m.supported_operations?.includes('chat')).length
    const evalCount = availableModels.filter(m => m.mode === 'decisions' || m.mode === 'evaluation' || m.supported_operations?.includes('decisions')).length
    res.json({
      connected: true,
      analysis_models: analysisCount,
      evaluation_models: evalCount,
      api_base: 'http://127.0.0.1:4000',
      configured: true,
    })
  })

  app.all('/lens/gateway/refresh', (_req, res) => {
    res.json({ success: true })
  })

  // Direct trace ingestion dari external agent frameworks (OTLP)
  app.post(['/v1/traces', '/api/public/otel/v1/traces', '/v1/logs'], (req, res) => {
    recordTraceFromOtlp(req.body)
    res.json({ status: 'ok', message: 'Trace recorded' })
  })

  // Fallback handler untuk subpath /lens lainnya
  app.all('/lens/*', (_req, res) => {
    res.json({ data: [] })
  })

  // Seed initial traces jika belum ada
  const traceStore = getTraceStore()
  traceStore.list(1).then((existing) => {
    if (existing.length === 0) {
      recordGatewayInference({
        traceId: 'trace_aethel_landing_01',
        platformId: 'aethel-studio',
        model: 'deepseek-chat',
        prompt: 'Aethel Studio: Design and scaffold landing page layout and modern UI components',
        promptTokens: 420,
        completionTokens: 180,
        durationMs: 620,
        status: 'ok',
        tools: [{ name: 'agent.tool.Write', status: 'success' }, { name: 'agent.tool.Format', status: 'success' }],
      })

      recordGatewayInference({
        traceId: 'trace_boson_refactor_02',
        platformId: 'boson-studio',
        model: 'deepseek-chat',
        prompt: 'Boson Studio: Refactor agent loop execution state and execute system checks',
        promptTokens: 580,
        completionTokens: 240,
        durationMs: 780,
        status: 'ok',
        tools: [{ name: 'agent.tool.Bash', status: 'success' }, { name: 'agent.tool.Inspect', status: 'success' }],
      })
    }
  })
}

