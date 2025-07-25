import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { Readable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import sharp from 'sharp'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'
import { log } from './utils.js'
import { EOL } from 'node:os'

const instructions = await readFile(new URL('./instructions.md', import.meta.url), { encoding: 'utf-8' })

const externalUrlToImageId = async externalUrl => {
  const response = await fetch(externalUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch image from external URL: ${externalUrl}`)
  }
  const mimeType = response.headers.get('content-type')
  if (!mimeType) {
    throw new Error(`No content type found for image at URL: ${externalUrl}`)
  }
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Invalid content type for image at URL: ${externalUrl} - Expected image/* but got ${mimeType}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  if (buffer.length > (1024 ** 2)) {
    throw new Error(`Image at URL: ${externalUrl} is larger than 1MB - Image must be 1MB or smaller`)
  }
  const metadata = await sharp(buffer).metadata()
  const convertFormat = !(
    ['avif', 'webp'].includes(metadata.format) ||
    ((metadata.format === 'heif') && (metadata.compression === 'av1'))
  )
  const convertSize = (metadata.height > 640) || (metadata.width > 640)
  let body
  if (convertSize || convertFormat) {
    let transformer = sharp()
    if (convertSize) {
      transformer = transformer.resize({ width: 640, height: 640, fit: sharp.fit.inside, withoutEnlargement: true })
    }
    if (convertFormat) {
      transformer = transformer.toFormat('avif', { quality: 50, lossless: false, chromaSubsampling: '4:2:0', bitdepth: 8 })
    }
    body = Readable.from(buffer).pipe(transformer)
  } else {
    body = buffer
  }
  const format = (
    convertFormat ||
    (metadata.format === 'avif') ||
    ((metadata.format === 'heif') && (metadata.compression === 'av1'))
  )
    ? 'avif'
    : 'webp'
  return await uploadObject({
    body,
    mimeType: `image/${format}`
  })
}

const ImageIdSchema = z.string().uuid().describe('Randomly generated version 4 UUID to serve as an identifier for an image linked to a todo item. Do not expose to end users in client responses. Use to identify links between todo items and images. Cannot be modified after creation.')

const TodoSchema = {
  id: z.string().uuid().describe('Randomly generated version 4 UUID that serves as an identifier for the todo item. **Do not expose to end users in client responses.** Used to identify links between todo items and images. Cannot be modified after creation. Type: string.'),
  description: z.string().min(1).max(256).describe('Description of the todo item. Can be modified after creation. Type: string. Maximum length: 256 characters.'),
  created: z.number().int().describe('Unix timestamp in milliseconds representing when the todo item was created, relative to the Unix Epoch. Cannot be modified after creation. Type: integer.'),
  completed: z.boolean().default(false).describe('Completion status of the todo item. Can be modified after creation. Type: boolean. Default: false.'),
  images: z.array(ImageIdSchema).min(1).max(6).optional().describe('List of randomly generated version 4 UUIDs that serve as identifiers for images linked to the todo item. Between 0 and 6 (inclusive) images can be linked to a todo item. This field will be omitted if there are no linked images. **Do not expose to end users in client responses.** Used to identify links between todo items and images. Cannot be modified after creation. Type: array of strings. Optional.')
}

const jsonToText = json =>
  Object.keys(TodoSchema)
    .filter(key => key in json)
    .map(key => `${key}: ${Array.isArray(json[key]) ? `[${json[key].join(', ')}]` : json[key]}`)
    .join(EOL)

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
  let response
  try {
    response = await getObject(imageId)
  } catch (error) {
    if (error.code === 'NoSuchKey') throw new Error(`Image: ${imageId} not found`)
    throw error
  }

  const chunks = []
  for await (const chunk of response.Body) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  const metadata = await sharp(buffer).metadata()
  const convertFormat = metadata.format !== 'webp'
  const convertSize = (metadata.height > 160) || (metadata.width > 160)
  let base64
  if (convertSize || convertFormat) {
    let transformer = sharp()
    if (convertSize) {
      transformer = transformer.resize({ width: 160, height: 160, fit: sharp.fit.inside, withoutEnlargement: true })
    }
    if (convertFormat) {
      transformer = transformer.toFormat('webp', { quality: 50, alphaQuality: 50, lossless: false, nearLossless: false, smartSubsample: false })
    }
    const chunks = []
    for await (const chunk of Readable.from(buffer).pipe(transformer)) {
      chunks.push(chunk)
    }
    base64 = Buffer.concat(chunks).toString('base64')
  } else {
    base64 = buffer.toString('base64')
  }

  return [
    {
      type: 'text',
      text: `Below is image ${imageId}.`,
      annotations: {
        audience: ['assistant']
      }
    },
    {
      type: 'image',
      data: base64,
      mimeType: 'image/webp',
      annotations: {
        audience: ['user', 'assistant']
      }
    }
  ]
}

const structureTodoItemAndImageContent = async item => {
  const content = structureTodoItemContent(item)
  if (item.images) {
    await Promise.all(item.images.map(async imageId => {
      const imageContent = await structureImageContent(imageId)
      content.push(...imageContent)
    }))
  }
  return content
}

const handlerWrapper = (name, handler) => async (...args) => {
  const requestId = args[1].requestInfo.headers['Todo-Request-Id']
  try {
    log({ level: 'info', event: 'mcp.tool.start', tool: name, params: args[0], requestId })
    const result = await handler(...args)
    log({ level: 'info', event: 'mcp.tool.end', tool: name, requestId })
    return result
  } catch (error) {
    log({ level: 'error', event: 'mcp.tool.error', tool: name, error, requestId })
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: ${error.message || `${error}`}`
        }
      ]
    }
  }
}

const mcpTools = {
  listTodos: {
    config: {
      title: 'List Todo Items',
      description: 'Returns all todo items and their linked images.',
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
        await Promise.all(items.map(async item => {
          const itemContent = await structureTodoItemAndImageContent(item)
          content.push(...itemContent)
        }))
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
  retrieveTodo: {
    config: {
      title: 'Retrieve Todo Item',
      description: 'Retrieves a todo item by id. Returns the requested todo item and its linked images.',
      inputSchema: {
        todoId: TodoSchema.id
      },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'Retrieve Todo Item'
      }
    },
    handler: async ({ todoId }) => {
      const item = await getItem(todoId)
      if (!item?.id) throw new Error(`Todo item: ${todoId} not found.`)
      const structuredContent = item
      const content = await structureTodoItemAndImageContent(item)
      return { content, structuredContent }
    }
  },
  addTodo: {
    config: {
      title: 'Add Todo Item',
      description: 'Adds a todo item and its linked images. Only the `description` and `images` fields can be provided. Returns the added todo item and its linked images.',
      inputSchema: {
        description: TodoSchema.description,
        images: z.array(z.string().url().describe('External URL for image linked to the todo item.')).min(1).max(6).optional().describe('List of external URLs for images linked to todo item. Each image must be smaller than 1MB. If no external URLs are provided, select between 0 and 6 (inclusive) images from `https://images.unsplash.com` appended with the query string value `?w=640&h=640&fit=max&auto=compress&q=50&fm=avif`. Only select images from `https://images.unsplash.com` that are relevant to the provided `description` field. If no relevant images exist, do not provide any images from Unsplash.')
      },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Add Todo Item'
      }
    },
    handler: async ({ description, images: files }) => {
      if (!description?.length) {
        throw new Error('Description is required')
      }
      if (description.length > 256) {
        throw new Error('Description cannot exceed 256 characters')
      }
      const images = []
      if (files) {
        if (files.length > 6) {
          throw new Error('Cannot link more than 6 images to todo item')
        }
        await Promise.all(
          files.map(async file => {
            images.push(await externalUrlToImageId(file))
          })
        )
      }
      const newTodo = {
        created: Date.now(),
        completed: false,
        description
      }
      if (images.length) newTodo.images = images
      const item = await putItem(newTodo)
      const structuredContent = item
      const content = await structureTodoItemAndImageContent(item, true)
      return { content, structuredContent }
    }
  },
  modifyTodo: {
    config: {
      title: 'Modify Todo Item',
      description: 'Modifies a todo item by id. Only the `description` and `completed` fields can be modified. Returns the modified todo item and its linked images.',
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
        title: 'Modify Todo Item'
      }
    },
    handler: async ({ todoId, ...body }) => {
      if ('description' in body) {
        if (!body.description?.length) {
          throw new Error('Description is required')
        }
        if (body.description.length > 256) {
          throw new Error('Description cannot exceed 256 characters')
        }
      }
      const existingItem = await getItem(todoId)
      if (!existingItem?.id) throw new Error(`Todo item: ${todoId} not found.`)
      const updatedItem = { ...existingItem, ...body }
      const item = await putItem(updatedItem)
      const structuredContent = item
      const content = await structureTodoItemAndImageContent(item)
      return { content, structuredContent }
    }
  },
  removeTodo: {
    config: {
      title: 'Remove Todo Item',
      description: 'Requires a todo item id as input. Removes the requested todo item and its linked images. Returns a confirmation that the requested todo item and its linked images have been removed.',
      inputSchema: { todoId: TodoSchema.id },
      outputSchema: { id: TodoSchema.id, deleted: z.boolean() },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Remove Todo Item'
      }
    },
    handler: async ({ todoId }) => {
      const item = await getItem(todoId)
      if (!item?.id) throw new Error(`Todo item: ${todoId} not found.`)
      const images = item.images || []
      await Promise.all([
        deleteItem(todoId),
        ...images.map(async imageId => await deleteObject(imageId))
      ])
      return {
        content: [
          {
            type: 'text',
            text: `Todo item ${todoId} has been removed`,
            annotations: {
              audience: ['assistant']
            }
          },
          ...images.map(imageId => ({
            type: 'text',
            text: `Image ${imageId} has been removed`,
            annotations: {
              audience: ['assistant']
            }
          }))
        ],
        structuredContent: { id: todoId, deleted: true }
      }
    }
  },
  retrieveImage: {
    config: {
      title: 'Retrieve Image',
      description: 'Retrieves an image by id. Returns the requested image and its linked todo item.',
      inputSchema: {
        imageId: ImageIdSchema
      },
      outputSchema: TodoSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'Retrieve Image'
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

const servers = new Map()
const transports = new Map()

const cleanup = async requestId => {
  try {
    const transport = transports.get(requestId)
    if (transport) await transport.close()
    transports.delete(requestId)
  } catch (error) {
    log({ level: 'error', event: 'mcp.transport.cleanup.error', error, requestId })
  }
  try {
    const server = servers.get(requestId)
    if (server) await server.close()
    servers.delete(requestId)
  } catch (error) {
    log({ level: 'error', event: 'mcp.server.cleanup.error', error, requestId })
  }
}

export const handleMcpRequest = async (req, res) => {
  const requestId = req.headers['Todo-Request-Id'] || null
  res.once('close', async () => {
    log({ level: 'info', event: 'mcp.request.closed', requestId })
    await cleanup(requestId)
  })
  const server = new McpServer(
    {
      name: 'noop-todo-app-mcp-server',
      title: 'Noop Todo App MCP Server',
      version: '0.0.0'
    },
    {
      instructions
    }
  )
  servers.set(requestId, server)
  for (const [name, { config, handler }] of Object.entries(mcpTools)) {
    server.registerTool(name, config, handlerWrapper(name, handler))
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  })
  transports.set(requestId, transport)
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

export const cleanupMcpServers = async () => {
  log({ level: 'info', event: 'mcp.server.cleanup' })
  await Promise.all(Array.from(transports.keys()).map(async requestId => await cleanup(requestId)))
  await Promise.all(Array.from(servers.keys()).map(async requestId => await cleanup(requestId)))
}
