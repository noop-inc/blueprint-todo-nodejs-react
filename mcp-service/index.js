import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import { getServerAndTransport } from './mcp.js'
import { randomUUID } from 'node:crypto'
import { log } from './utils.js'
import { EOL } from 'node:os'

morgan.token('requestId', req => req.headers['Todo-Request-Id'])
morgan.token('requestBody', req => req.body)
morgan.token('responseBody', (req, res) => res.body)

const app = express()
app.use((req, res, next) => {
  req.headers['Todo-Request-Id'] = randomUUID()
  next()
})
app.use(cors())
app.use(express.json())

app.use((req, res, next) => {
  const originalSend = res.send.bind(res)
  const originalJson = res.json.bind(res)
  res.send = (...args) => {
    try {
      res.body = JSON.parse(JSON.stringify(args[0]))
    } catch (error) {
      res.body = null
    }
    originalSend(...args)
  }
  res.json = (...args) => {
    try {
      res.body = JSON.parse(JSON.stringify(args[0]))
    } catch (error) {
      res.body = null
    }
    originalJson(...args)
  }
  next()
})

app.use(morgan(
  (tokens, req, res) =>
    `${JSON.stringify({
      level: 'info',
      event: 'mcp.request',
      method: tokens.method(req, res),
      url: tokens.url(req, res),
      requestBody: tokens.requestBody(req, res) || null,
      requestId: tokens.requestId(req, res) || null
    })}${EOL}`,
  { immediate: true }
))

app.use(morgan((tokens, req, res) =>
  `${JSON.stringify({
    level: 'info',
    event: 'mcp.response',
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseFloat(tokens.status(req, res)),
    contentLength: parseFloat(tokens.res(req, res, 'content-length')),
    responseTime: parseFloat(tokens['response-time'](req, res)),
    responseBody: tokens.responseBody(req, res) || null,
    requestId: tokens.requestId(req, res) || null
  })}${EOL}`
))

app.get('/favicon.ico', (req, res) => {
  res.status(204).end()
})

const mcpServers = new Set()
const mcpTransports = new Set()

// Handles MCP server requests
app.post('/mcp', async (req, res) => {
  const requestId = req.headers['Todo-Request-Id'] || null
  try {
    const { mcpServer, mcpTransport } = getServerAndTransport()
    mcpServers.add(mcpServer)
    mcpTransports.add(mcpTransport)
    res.once('close', async () => {
      log({ level: 'info', event: 'mcp.request.close', requestId })
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        log({ level: 'error', event: 'mcp.transport.close.error', error, requestId })
      }
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        log({ level: 'error', event: 'mcp.server.close.error', error, requestId })
      }
    })
    await mcpServer.connect(mcpTransport)
    await mcpTransport.handleRequest(req, res, req.body)
  } catch (error) {
    log({ level: 'error', event: 'mcp.post.error', error, requestId })
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || `${error}` || 'Internal server error'
        },
        id: null
      })
    }
  }
})

app.get('/mcp', async (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed'
    },
    id: null
  })
})

app.delete('/mcp', async (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed'
    },
    id: null
  })
})

const port = 3000
const server = app.listen(port, error => {
  if (error) {
    log({ level: 'error', event: 'mcp.server.error', error })
  } else {
    log({ level: 'info', event: 'mcp.server.running', port })
  }
})

process.once('SIGTERM', async () => {
  log({ level: 'info', event: 'mcp.server.signal', signal: 'SIGTERM' })
  if (mcpTransports.size) {
    log({ level: 'info', event: 'mcp.transports.cleanup' })
    await Promise.all(Array.from(mcpTransports).map(async mcpTransport => {
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        log({ level: 'error', event: 'mcp.transports.cleanup.error', error })
      }
    }))
  }
  if (mcpServers.size) {
    log({ level: 'info', event: 'mcp.servers.cleanup' })
    await Promise.all(Array.from(mcpServers).map(async mcpServer => {
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        log({ level: 'error', event: 'mcp.servers.cleanup.error', error })
      }
    }))
  }
  server.close(error => {
    if (error) {
      log({ level: 'error', event: 'mcp.server.closed.error', error })
    } else {
      log({ level: 'info', event: 'mcp.server.closed' })
    }
    process.exit(error ? 1 : 0)
  })
})
