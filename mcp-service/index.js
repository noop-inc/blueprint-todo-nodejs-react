import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import compression from 'compression'
import { getServerAndTransport } from './mcp.js'
import { randomUUID } from 'node:crypto'

morgan.token('requestId', req => req.headers['Todo-Request-Id'])

const app = express()
app.use((req, res, next) => {
  req.headers['Todo-Request-Id'] = randomUUID()
  next()
})
app.use(compression())
app.use(cors())
app.use(express.json())

app.use(morgan(
  (tokens, req, res) =>
    `${JSON.stringify({
      event: 'mcp.request',
      requestId: tokens.requestId(req, res),
      method: tokens.method(req, res),
      url: tokens.url(req, res)
    })}\n`,
  { immediate: true }
))

app.use(morgan((tokens, req, res) =>
  `${JSON.stringify({
    event: 'mcp.response',
    requestId: tokens.requestId(req, res),
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseFloat(tokens.status(req, res)),
    contentLength: parseFloat(tokens.res(req, res, 'content-length')),
    responseTime: parseFloat(tokens['response-time'](req, res))
  })}\n`
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
      console.log(`${JSON.stringify({ event: 'mcp.request.close', requestId: req.headers['Todo-Request-Id'] })}\n`)
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        console.log(`${JSON.stringify({ event: 'mcp.transport.close.error', requestId: req.headers['Todo-Request-Id'], code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })}\n`)
      }
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        console.log(`${JSON.stringify({ event: 'mcp.server.close.error', requestId: req.headers['Todo-Request-Id'], code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })}\n`)
      }
    })
    await mcpServer.connect(mcpTransport)
    await mcpTransport.handleRequest(req, res, req.body)
  } catch (error) {
    console.log(`${JSON.stringify({ event: 'mcp.post.error', requestId: req.headers['Todo-Request-Id'], code: error.code || 'Error', rror: error.message || `${error}`, stack: error.stack })}\n`)
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
    console.log(`${JSON.stringify({ event: 'mcp.server.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })}\n`)
  } else {
    console.log(`${JSON.stringify({ event: 'mcp.server.running', port })}\n`)
  }
})

process.once('SIGTERM', async () => {
  console.log(`${JSON.stringify({ event: 'mcp.server.signal', signal: 'SIGTERM' })}\n`)
  if (mcpTransports.size) {
    console.log(`${JSON.stringify({ event: 'mcp.transports.cleanup' })}\n`)
    for (const mcpTransport of mcpTransports) {
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        console.log(`${JSON.stringify({ event: 'mcp.transports.cleanup.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })}\n`)
      }
    }
  }
  if (mcpServers.size) {
    console.log(`${JSON.stringify({ event: 'mcp.servers.cleanup' })}\n`)
    for (const mcpServer of mcpServers) {
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        console.log(`${JSON.stringify({ event: 'mcp.servers.cleanup.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })}\n`)
      }
    }
  }
  server.close(error => {
    if (error) {
      console.log(`${JSON.stringify({ event: 'mcp.server.closed.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack })}\n`)
    } else {
      console.log(`${JSON.stringify({ event: 'mcp.server.closed' })}\n`)
    }
    process.exit(error ? 1 : 0)
  })
})
