import express from 'express'
import morgan from 'morgan'
import { lookup } from 'mime-types'
import cors from 'cors'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'

const instructions = await readFile(new URL('./instructions.md', import.meta.url), { encoding: 'utf-8' })

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

const ImageIdSchema = z.string().describe('Randomly generated version 4 UUID to serve as identifier for image linked to todo item. Includes file extension of image as suffix. Do not expose to end users in client responses. Use to identify links between todo items and images. Cannot be updated after creation.')

const TodoSchema = {
  id: z.string().describe('Randomly generated version 4 UUID to serve as identifier for todo item. Do not expose to end users in client responses. Use to identify links between todo items and images. Cannot be updated after creation.'),
  description: z.string().describe('Description of todo item. Can be updated after creation.'),
  created: z.number().describe('Unix timestamp in milliseconds representing when the todo item was created in reference to the Unix Epoch. Cannot be updated after creation.'),
  completed: z.boolean().default(false).describe('Completion status of todo item. Can be updated after creation.'),
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
      text: `Below is todo item ${item.id}`,
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

const handlerWrapper = handler => async (...args) => {
  try {
    return await handler(...args)
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
  'list-todos': {
    config: {
      title: 'List Todo Items',
      description: 'List all todo items and linked images. Returns all todo items and linked images.',
      inputSchema: {},
      outputSchema: { items: z.array(z.object(TodoSchema)) },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'List Todo Items'
      }
    },
    handler: async () => {
      const items = await scanTable()
      const structuredContent = { items }
      const content = []
      if (items.length) {
        for (const item of items) {
          content.push(...(await structureTodoItemAndImageContent(item)))
        }
      } else {
        content.push({
          type: 'text',
          text: 'There are no todo items',
          annotations: {
            audience: ['assistant']
          }
        })
      }
      return { content, structuredContent }
    }
  },
  'get-todo': {
    config: {
      title: 'Get Todo Item',
      description: 'Get todo item by id and linked images. Returns requested todo item and linked images.',
      inputSchema: { todoId: TodoSchema.id },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'Get Todo Item'
      }
    },
    handler: async ({ todoId }) => {
      const item = await getItem(todoId)
      const structuredContent = item
      const content = await structureTodoItemAndImageContent(item)
      return { content, structuredContent }
    }
  },
  'create-todo': {
    config: {
      title: 'Create Todo Item',
      description: 'Create todo item and linked images. Only `description` and `images` field can be provided. Returns created todo item and linked images.',
      inputSchema: {
        description: TodoSchema.description,
        images: z.array(z.string().describe('External URL for image linked to todo item.')).min(1).max(6).optional().describe('List of external URLs for images linked to todo item. If no external URLs are provided, select between 0 and 3 (inclusive) images from `https://images.unsplash.com` appended with the query string `?w=360&h=240&fit=crop&fm=webp&auto=compress`.')
      },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Create Todo Item'
      }
    },
    handler: async ({ description, images: files = [] }) => {
      if (files.length > 6) {
        throw new Error('Cannot link more than 6 images to a todo item')
      }
      const images = await Promise.all(
        files.map(async file => await externalUrlToImageId(file))
      )
      const newTodo = {
        description,
        created: Date.now(),
        completed: false
      }
      if (images.length) newTodo.images = images
      const item = await putItem(newTodo)
      const structuredContent = item
      const content = await structureTodoItemAndImageContent(item)
      return { content, structuredContent }
    }
  },
  'update-todo': {
    config: {
      title: 'Update Todo Item',
      description: 'Update todo item by id. Only `description` and `completed` fields can be updated. Returns updated todo item and linked images.',
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
        title: 'Update Todo Item'
      }
    },
    handler: async ({ todoId, ...body }) => {
      const existingItem = await getItem(todoId)
      const updatedItem = { ...existingItem, ...body }
      const item = await putItem(updatedItem)
      const structuredContent = item
      const content = await structureTodoItemAndImageContent(item)
      return { content, structuredContent }
    }
  },
  'delete-todo': {
    config: {
      title: 'Delete Todo Item',
      description: 'Delete todo item by id and linked images. Returns confirmation that requested todo item and linked images have been deleted.',
      inputSchema: { todoId: TodoSchema.id },
      outputSchema: z.object({ id: TodoSchema.id, deleted: z.boolean() }),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Delete Todo Item'
      }
    },
    handler: async ({ todoId }) => {
      const item = await getItem(todoId)
      const images = item.images || []
      await Promise.all([
        deleteItem(todoId),
        ...images.map(imageId => deleteObject(imageId))
      ])
      return {
        content: [
          {
            type: 'text',
            text: `Todo item ${todoId} has been deleted`,
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
        ],
        structuredContent: { id: todoId, deleted: true }
      }
    }
  },
  'get-image': {
    config: {
      title: 'Get Image',
      description: 'Get image by id and linked todo item. Returns requested image and linked todo item.',
      inputSchema: { imageId: ImageIdSchema },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'Get Image'
      }
    },
    handler: async ({ imageId }) => {
      const content = await structureImageContent(imageId)
      const items = await scanTable()
      const item = items.find(item => item.images?.includes(imageId))
      const structuredContent = item
      content.push(...structureTodoItemContent(item))
      return { content, structuredContent }
    }
  }
}

const mcpServers = new Set()
const mcpTransports = new Set()

const getServerAndTransport = () => {
  const mcpServer = new McpServer(
    {
      name: 'noop-todo-app-mcp-server',
      title: 'Noop Todo App MCP Server',
      version: '0.0.0'
    },
    {
      instructions
    }
  )
  mcpServers.add(mcpServer)
  for (const [name, { config, handler }] of Object.entries(mcpTools)) {
    mcpServer.registerTool(name, config, handlerWrapper(handler))
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
