import express from 'express'
import morgan from 'morgan'
import { lookup } from 'mime-types'
import cors from 'cors'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'

const app = express()
app.use(cors())
app.use(express.json())

app.use(morgan((tokens, req, res) =>
  JSON.stringify({
    event: 'mcp.request',
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseFloat(tokens.status(req, res)),
    contentLength: parseFloat(tokens.res(req, res, 'content-length')),
    responseTime: parseFloat(tokens['response-time'](req, res))
  })
))

app.get('/favicon.ico', (req, res) => {
  res.status(204).end()
})

const externalUrlToImageId = async externalUrl => {
  const response = await fetch(externalUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch image from external URL: ${externalUrl}`)
  }
  const mimetype = response.headers.get('content-type') || lookup(externalUrl)
  if (!mimetype) {
    throw new Error(`No content type found for image at URL: ${externalUrl}`)
  }
  if (!mimetype.startsWith('image/')) {
    throw new Error(`Invalid content type for image at URL: ${externalUrl}. Expected image/* but got ${mimetype}.`)
  }
  const oneHundredKBinBytes = 100 * 1024
  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > oneHundredKBinBytes) {
    throw new Error(`Image at URL: ${externalUrl} exceeds size limit of 100KB`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  if (buffer.byteLength > oneHundredKBinBytes) {
    throw new Error(`Image at URL: ${externalUrl} exceeds size limit of 100KB`)
  }
  return await uploadObject({ buffer, mimetype })
}

const ImageIdSchema = z.string().describe('Unique identifier for image linked to todo. Includes file extension of image as suffix. Do not expose to end users. Use to identify links between todos and images.')

const TodoSchema = {
  id: z.string().describe('Unique identifier for todo. Do not expose to end users. Use to identify links between todos and images.'),
  description: z.string().describe('Description of the todo.'),
  created: z.number().describe('Unix timestamp in milliseconds representing when the todo was created.'),
  completed: z.boolean().default(false).describe('Completion status of todo.'),
  images: z.array(ImageIdSchema).min(1).max(6).optional()
}

const jsonToText = json =>
  Object.keys(TodoSchema)
    .filter(key => key in json)
    .map(key => `${key}: ${Array.isArray(json[key]) ? `[${json[key].join(', ')}]` : json[key]}`)
    .join('\n')

const structureTodoItemContent = item =>
  [
    {
      type: 'text',
      text: `Below is todo ${item.id}`,
      annotations: {
        audience: ['assistant']
      }
    },
    {
      type: 'text',
      text: jsonToText(item),
      annotations: {
        audience: ['user', 'assistant']
      }
    }
  ]

const structureImageContent = async imageId => {
  const response = await getObject(imageId)
  const contentType = response.ContentType || lookup(imageId)
  const chunks = []
  for await (const chunk of response.Body) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  const base64 = buffer.toString('base64')
  return [
    {
      type: 'text',
      text: `Below is image ${imageId}`,
      annotations: {
        audience: ['assistant']
      }
    },
    {
      type: 'image',
      data: base64,
      mimeType: contentType,
      annotations: {
        audience: ['user', 'assistant']
      }
    }
  ]
}

const structureTodoItemAndImageContent = async item => {
  const content = []
  content.push(...structureTodoItemContent(item))
  for (const imageId of (item?.images || [])) {
    content.push(...(await structureImageContent(imageId)))
  }
  return content
}

const cbHandler = cd => async (...args) => {
  try {
    return await cd(...args)
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`
        }
      ]
    }
  }
}

const mcpTools = {
  listTodos: {
    config: {
      title: 'List Todos',
      description: 'List all todos and list linked images',
      inputSchema: {},
      outputSchema: { todoItems: z.array(z.object(TodoSchema)) },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'List Todos'
      }
    },
    cb: async () => {
      const todoItems = await scanTable()
      const structuredContent = { todoItems }
      const content = []

      if (todoItems.length) {
        for (const item of todoItems) {
          content.push(...(await structureTodoItemAndImageContent(item)))
        }
      } else {
        content.push({
          type: 'text',
          text: 'There are no todos',
          annotations: {
            audience: ['assistant']
          }
        })
      }
      return { content, structuredContent }
    }
  },
  getTodo: {
    config: {
      title: 'Get Todo',
      description: 'Get todo by id and get linked images',
      inputSchema: { todoId: TodoSchema.id },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'Get Todo'
      }
    },
    cb: async ({ todoId }) => {
      const todoItem = await getItem(todoId)
      const structuredContent = todoItem
      const content = await structureTodoItemAndImageContent(todoItem)
      return { content, structuredContent }
    }
  },
  createTodo: {
    config: {
      title: 'Create Todo',
      description: 'Create todo and create linked images',
      inputSchema: {
        description: TodoSchema.description,
        images: z.array(z.string().describe('External URL for image linked to todo.')).min(1).max(6).optional().describe('List of external URLs for images linked to todo. If no external URLs are provided, select between 0 and 3 (inclusive) relevant images from `https://images.unsplash.com` with the appended query string `?w=360&h=240&fit=crop&fm=webp&auto=compress`.')
      },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Create Todo'
      }
    },
    cb: async ({ description, images: files = [] }) => {
      const images = await Promise.all(
        files.map(async file => await externalUrlToImageId(file))
      )
      const newTodo = {
        description,
        created: Date.now(),
        completed: false
      }
      if (images.length) newTodo.images = images
      const todoItem = await putItem(newTodo)
      const structuredContent = todoItem
      const content = await structureTodoItemAndImageContent(todoItem)
      return { content, structuredContent }
    }
  },
  updateTodo: {
    config: {
      title: 'Update Todo',
      description: 'Update todo by id, only description and completed fields can be updated',
      inputSchema: {
        todoId: TodoSchema.id,
        description: TodoSchema.description.optional(),
        completed: TodoSchema.completed.optional()
      },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Update Todo'
      }
    },
    cb: async ({ todoId, ...body }) => {
      const existingItem = await getItem(todoId)
      const updatedItem = { ...existingItem, ...body }
      const todoItem = await putItem(updatedItem)
      const structuredContent = todoItem
      const content = await structureTodoItemAndImageContent(todoItem)
      return { content, structuredContent }
    }
  },
  deleteTodo: {
    config: {
      title: 'Delete Todo',
      description: 'Delete todo by id and delete linked images',
      inputSchema: { todoId: TodoSchema.id },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Delete Todo'
      }
    },
    cb: async ({ todoId }) => {
      const todoItem = await getItem(todoId)
      const images = todoItem.images || []
      await Promise.all([
        deleteItem(todoId),
        ...images.map(imageId => deleteObject(imageId))
      ])
      return {
        content: [
          {
            type: 'text',
            text: `Todo ${todoId} has been deleted`,
            annotations: {
              audience: ['assistant']
            }
          },
          ...images.map(imageId => ({
            type: 'text',
            text: `Image ${imageId} has been deleted`,
            annotations: {
              audience: ['assistant']
            }
          }))
        ]
      }
    }
  },
  getImage: {
    config: {
      title: 'Get Image',
      description: 'Get image by id and get linked todo',
      inputSchema: { imageId: ImageIdSchema },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'Get Image'
      }
    },
    cb: async ({ imageId }) => {
      const content = await structureImageContent(imageId)
      const todoItems = await scanTable()
      const todoItem = todoItems.find(todoItem => todoItem.images?.includes(imageId))
      content.push(...structureTodoItemContent(todoItem))
      return { content }
    }
  }
}

const mcpServers = new Set()
const mcpTransports = new Set()

const getServerAndTransport = () => {
  const mcpServer = new McpServer({
    name: 'Todo Application MCP Server',
    version: '0.0.0'
  })
  mcpServers.add(mcpServer)
  for (const [name, { config, cb }] of Object.entries(mcpTools)) {
    mcpServer.registerTool(name, config, cbHandler(cb))
  }
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  })
  mcpTransports.add(mcpTransport)
  const mcpCleanup = async () => {
    console.log(JSON.stringify({ event: 'mcp.request.close' }))
    try {
      await mcpTransport.close()
      mcpTransports.delete(mcpTransport)
    } catch (error) {
      console.log(JSON.stringify({ event: 'mcp.transport.close.error', error: error.message || `${error}` }))
    }
    try {
      await mcpServer.close()
      mcpServers.delete(mcpServer)
    } catch (error) {
      console.log(JSON.stringify({ event: 'mcp.server.close.error', error: error.message || `${error}` }))
    }
  }
  return { mcpServer, mcpTransport, mcpCleanup }
}

app.post('/mcp', async (req, res) => {
  try {
    const { mcpServer, mcpTransport, mcpCleanup } = getServerAndTransport()
    res.once('close', mcpCleanup)
    await mcpServer.connect(mcpTransport)
    await mcpTransport.handleRequest(req, res, req.body)
  } catch (error) {
    console.log(JSON.stringify({ event: 'mcp.post.error', error: error.message || `${error}` }))
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || 'Internal server error'
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
    console.log(JSON.stringify({ event: 'mcp.server.error', error: error.message || `${error}` }))
  } else {
    console.log(JSON.stringify({ event: 'mcp.server.running', port }))
  }
})

process.once('SIGTERM', async () => {
  console.log(JSON.stringify({ event: 'mcp.server.signal', signal: 'SIGTERM' }))
  if (mcpTransports.size) {
    console.log(JSON.stringify({ event: 'mcp.transports.cleanup' }))
    for (const mcpTransport of mcpTransports) {
      try {
        await mcpTransport.close()
        mcpTransports.delete(mcpTransport)
      } catch (error) {
        console.log(JSON.stringify({ event: 'mcp.transports.cleanup.error', error: error.message || `${error}` }))
      }
    }
  }
  if (mcpServers.size) {
    console.log(JSON.stringify({ event: 'mcp.servers.cleanup' }))
    for (const mcpServer of mcpServers) {
      try {
        await mcpServer.close()
        mcpServers.delete(mcpServer)
      } catch (error) {
        console.log(JSON.stringify({ event: 'mcp.servers.cleanup.error', error: error.message || `${error}` }))
      }
    }
  }
  server.close(error => {
    if (error) {
      console.log(JSON.stringify({ event: 'mcp.server.closed.error', error: error.message || `${error}` }))
    } else {
      console.log(JSON.stringify({ event: 'mcp.server.closed' }))
    }
    process.exit(error ? 1 : 0)
  })
})
