import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { Readable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import sharp from 'sharp'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'

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
    throw new Error(`Invalid content type for image at URL: ${externalUrl}. Expected image/* but got ${mimeType}.`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const metadata = await sharp(buffer).metadata()
  const convertFormat = !(
    ['avif', 'webp'].includes(metadata.format) ||
    ((metadata.format === 'heif') && (metadata.compression === 'av1'))
  )
  const convertSize = (metadata.height > 640) || (metadata.width > 640)
  let transformer
  if (convertSize || convertFormat) {
    transformer = sharp()
    if (convertSize) {
      transformer = transformer.resize({ width: 640, height: 640, fit: sharp.fit.inside, withoutEnlargement: true })
    }
    if (convertFormat) {
      transformer = transformer.toFormat('webp')
    }
  }
  return await uploadObject({
    stream: transformer ? Readable.from(buffer).pipe(transformer) : buffer,
    mimeType: `image/${(convertFormat || (metadata.format === 'webp')) ? 'webp' : 'avif'}`
  })
}

const ImageIdSchema = z.string().describe('Randomly generated version 4 UUID to serve as an identifier for an image linked to a todo item. A maximum of 6 images can be linked to a todo item. Do not expose to end users in client responses. Use to identify links between todo items and images. Cannot be updated after creation.')

const TodoSchema = {
  id: z.string().describe('Randomly generated version 4 UUID to serve as an identifier for the todo item. Do not expose to end users in client responses. Use to identify links between todo items and images. Cannot be updated after creation.'),
  description: z.string().describe('Description of the todo item. Can be updated after creation.'),
  created: z.number().describe('Unix timestamp in milliseconds representing when the todo item was created in reference to the Unix Epoch. Cannot be updated after creation.'),
  completed: z.boolean().default(false).describe('Completion status of the todo item. Can be updated after creation. Default: false.'),
  images: z.array(ImageIdSchema).min(1).max(6).optional().describe('List of randomly generated version 4 UUIDs to serve as identifiers for images linked to the todo item. Includes file extension of image as a suffix. A maximum of 6 images can be linked to a todo item. Do not expose to end users in client responses. Use to identify links between todo items and images. Cannot be updated after creation. Optional.')
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
  const chunks = []
  const transformer = sharp()
    .resize({ width: 160, height: 160, fit: sharp.fit.inside, withoutEnlargement: true })
    .toFormat('jpeg')
  for await (const chunk of response.Body.pipe(transformer)) {
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
      mimeType: 'image/jpeg',
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
  listTodos: {
    config: {
      title: 'List Todo Items',
      description: 'List all todo items and their linked images. Returns all todo items and their linked images.',
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
  getTodo: {
    config: {
      title: 'Get Todo Item',
      description: 'Get a todo item by id and its linked images. Returns the requested todo item and its linked images.',
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
  createTodo: {
    config: {
      title: 'Create Todo Item',
      description: 'Create a todo item and its linked images. Only the `description` and `images` fields can be provided. Returns the created todo item and its linked images.',
      inputSchema: {
        description: TodoSchema.description,
        images: z.array(z.string().describe('External URL for image linked to the todo item.')).min(1).max(6).optional().describe('List of external URLs for images linked to todo item. If no external URLs are provided, select between 0 and 6 (inclusive) images from `https://images.unsplash.com` appended with the query string value `?w=640&h=640&fit=max&auto=compress&q=50&fm=avif`. Only select images from `https://images.unsplash.com` that are relevant to the provided `description` field. If no relevant images exist, do not provide any images from Unsplash.')
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
        throw new Error('Cannot link more than 6 images to todo item')
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
  updateTodo: {
    config: {
      title: 'Update Todo Item',
      description: 'Update a todo item by id. Only `description` and the `completed` fields can be updated. Returns updated todo item and its linked images.',
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
  deleteTodo: {
    config: {
      title: 'Delete Todo Item',
      description: 'Delete a todo item by id and its linked images. Returns a confirmation that the requested todo item and its linked images have been deleted.',
      inputSchema: { todoId: TodoSchema.id },
      outputSchema: { id: TodoSchema.id, deleted: z.boolean() },
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
        ...images.map(async imageId => await deleteObject(imageId))
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
  getImage: {
    config: {
      title: 'Get Image',
      description: 'Get an image by id and its linked todo item. Returns the requested image and its linked todo item.',
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

export const getServerAndTransport = () => {
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
  for (const [name, { config, handler }] of Object.entries(mcpTools)) {
    mcpServer.registerTool(name, config, handlerWrapper(handler))
  }
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  })
  return { mcpServer, mcpTransport }
}
