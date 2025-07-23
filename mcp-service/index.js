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
  const originalSend = res.send
  const originalJson = res.json
  res.send = (body, ...args) => {
    try {
      res.body = JSON.parse(JSON.stringify(body))
    } catch (error) {
      res.body = null
    }
    originalSend.apply(res, body, ...args)
  }
  res.json = (body, ...args) => {
    try {
      res.body = JSON.parse(JSON.stringify(body))
    } catch (error) {
      res.body = null
    }
    originalJson.apply(res, body, ...args)
  }
  next()
})

app.use(morgan(
  (tokens, req, res) =>
    `${JSON.stringify({
      event: 'mcp.request',
      requestId: tokens.requestId(req, res) || null,
      method: tokens.method(req, res),
      url: tokens.url(req, res),
      requestBody: tokens.requestBody(req, res) || null
    })}${EOL}`,
  { immediate: true }
))

app.use(morgan((tokens, req, res) =>
  `${JSON.stringify({
    event: 'mcp.response',
    requestId: tokens.requestId(req, res) || null,
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseFloat(tokens.status(req, res)),
    contentLength: parseFloat(tokens.res(req, res, 'content-length')),
    responseTime: parseFloat(tokens['response-time'](req, res)),
    responseBody: tokens.responseBody(req, res) || null
  })}${EOL}`
))

app.get('/favicon.ico', (req, res) => {
  res.status(204).end()
})

const mcpServers = new Set()
const mcpTransports = new Set()

app.post('/mcp', async (req, res) => {
  try {
    const { mcpServer, mcpTransport } = getServerAndTransport()
    mcpServers.add(mcpServer)
    mcpTransports.add(mcpTransport)
    res.once('close', async () => {
      log({ event: 'mcp.request.close', requestId: req.headers['Todo-Request-Id'] })
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        log({ event: 'mcp.transport.close.error', requestId: req.headers['Todo-Request-Id'], code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })
      }
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        log({ event: 'mcp.server.close.error', requestId: req.headers['Todo-Request-Id'], code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })
      }
    })
    await mcpServer.connect(mcpTransport)
    await mcpTransport.handleRequest(req, res, req.body)
  } catch (error) {
    log({ event: 'mcp.post.error', requestId: req.headers['Todo-Request-Id'], code: error.code || 'Error', rror: error.message || `${error}`, stack: error.stack })
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
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed'
    },
    id: null
  }))
})

app.delete('/mcp', async (req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed'
    },
    id: null
  }))
})

const port = 3000
const server = app.listen(port, error => {
  if (error) {
    log({ event: 'mcp.server.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })
  } else {
    log({ event: 'mcp.server.running', port })
  }
})

process.once('SIGTERM', async () => {
  log({ event: 'mcp.server.signal', signal: 'SIGTERM' })
  if (mcpTransports.size) {
    log({ event: 'mcp.transports.cleanup' })
    await Promise.all(mcpTransports.map(async mcpTransport => {
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        log({ event: 'mcp.transports.cleanup.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })
      }
    }))
  }
  if (mcpServers.size) {
    log({ event: 'mcp.servers.cleanup' })
    await Promise.all(mcpServers.map(async mcpServer => {
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        log({ event: 'mcp.servers.cleanup.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })
      }
    }))
  }
  server.close(error => {
    if (error) {
      log({ event: 'mcp.server.closed.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })
    } else {
      log({ event: 'mcp.server.closed' })
    }
    process.exit(error ? 1 : 0)
  })
})
