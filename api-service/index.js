import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import sharp from 'sharp'
import { Readable } from 'node:stream'
import busboy from 'busboy'
import { randomUUID } from 'node:crypto'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'
import { log } from './utils.js'
import { EOL } from 'node:os'

const streamToImageId = async (stream, filename) => {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  if (buffer.length > (1024 ** 2)) {
    throw new Error(`Image with filename: ${filename} is larger than 1MB - Image must be 1MB or smaller`)
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

morgan.token('requestId', req => req.headers['Todo-Request-Id'])
morgan.token('requestBody', req => req.body)

const app = express()
app.use((req, res, next) => {
  req.headers['Todo-Request-Id'] = randomUUID()
  next()
})
app.use(cors())
app.use(express.json())

app.use(morgan(
  (tokens, req, res) =>
    `${JSON.stringify({
      level: 'info',
      event: 'api.request',
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
    event: 'api.response',
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseFloat(tokens.status(req, res)),
    contentLength: parseFloat(tokens.res(req, res, 'content-length')),
    responseTime: parseFloat(tokens['response-time'](req, res)),
    requestId: tokens.requestId(req, res) || null
  })}${EOL}`
))

app.get('/favicon.ico', (req, res) => {
  res.status(204).end()
})

// get image
//
// Param `imageId` corresponds to the key of an image file in S3
app.get('/api/images/:imageId', async (req, res) => {
  try {
    const params = req.params
    const imageId = params.imageId
    let response
    try {
      response = await getObject(imageId)
    } catch (error) {
      if (error.code === 'NoSuchKey') throw new Error(`Image: ${imageId} not found`)
      throw error
    }
    res.set('Content-Type', response.ContentType)
    response.Body.pipe(res)
  } catch (error) {
    log({ level: 'error', event: 'api.image.get.error', error, requestId: req.headers['Todo-Request-Id'] })
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error getting image',
        stack: error.stack || null
      })
    }
  }
})

// get all todos
app.get('/api/todos', async (req, res) => {
  try {
    const items = await scanTable()
    res.json(items)
  } catch (error) {
    log({ level: 'error', event: 'api.todos.get.error', error, requestId: req.headers['Todo-Request-Id'] })
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error getting todos',
        stack: error.stack || null
      })
    }
  }
})

// create new todo
//
// Payload (req.body):
//   description / type: String / required
//   images / type: File/Buffer / optional
app.post('/api/todos', async (req, res) => {
  try {
    // Uploads images to S3, returns array of S3 keys for uploaded files
    const imagePromises = []
    const body = {}
    const bb = busboy({
      headers: req.headers,
      // Limit Uploads to 6 files, max size 1MB each per todo
      limits: { fileSize: (1024 ** 2), files: 6 }
    })
    await new Promise((resolve, reject) => {
      bb.on('file', (name, file, { filename, mimeType }) => {
        if (!mimeType.startsWith('image/')) {
          return reject(new Error(`Invalid content type for image with filename: ${filename} - Expected image/* but got ${mimeType}`))
        }
        imagePromises.push(streamToImageId(file, filename))
      })
      bb.on('field', (name, value) => {
        if (name === 'description') {
          if (!value?.length) {
            return reject(new Error('Description is required'))
          }
          if (value.length > 256) {
            return reject(new Error('Description cannot exceed 256 characters'))
          }
        }
        body[name] = value
      })
      bb.once('error', reject)
      bb.once('close', resolve)
      req.pipe(bb)
    })
    const images = await Promise.all(imagePromises)
    const newTodo = {
      created: Date.now(),
      completed: false,
      description: body.description
    }
    // If images were included with todo includes array of S3 keys for images with todo
    if (images.length) newTodo.images = images
    const item = await putItem(newTodo)
    res.json(item)
  } catch (error) {
    log({ level: 'error', event: 'api.todos.create.error', error, requestId: req.headers['Todo-Request-Id'] })
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error creating todo',
        stack: error.stack || null
      })
    }
  }
})

// get todo
//
// Param `todoId` corresponds to the id of a todo stored in DynamoDB
app.get('/api/todos/:todoId', async (req, res) => {
  try {
    const params = req.params
    const todoId = params.todoId
    const item = await getItem(todoId)
    if (!item?.id) throw new Error(`Todo item: ${todoId} not found`)
    res.json(item)
  } catch (error) {
    log({ level: 'error', event: 'api.todo.get.error', error, requestId: req.headers['Todo-Request-Id'] })
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error getting todo',
        stack: error.stack || null
      })
    }
  }
})

// update todo
//
// Param `todoId` corresponds to the id of a todo stored in DynamoDB
//
// Payload (req.body):
//   description / type: String / optional
//   completed / type: Boolean / optional
app.put('/api/todos/:todoId', async (req, res) => {
  try {
    const params = req.params
    const todoId = params.todoId
    const existingItem = await getItem(todoId)
    if (!existingItem?.id) throw new Error(`Todo item: ${todoId} not found`)
    const body = req.body
    if ('description' in body) {
      if (!body.description?.length) {
        throw new Error('Description is required')
      }
      if (body.description.length > 256) {
        throw new Error('Description cannot exceed 256 characters')
      }
    }
    const newItem = { ...existingItem, ...body }
    const item = await putItem(newItem)
    res.json(item)
  } catch (error) {
    log({ level: 'error', event: 'api.todo.update.error', error, requestId: req.headers['Todo-Request-Id'] })
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error updating todo',
        stack: error.stack || null
      })
    }
  }
})

// delete todo
//
// Param `todoId` corresponds to the id of a todo stored in DynamoDB
app.delete('/api/todos/:todoId', async (req, res) => {
  try {
    const params = req.params
    const todoId = params.todoId
    // Gets todo to be deleted from DynamoDB
    const item = await getItem(todoId)
    if (!item?.id) throw new Error(`Todo item: ${todoId} not found`)
    const images = item.images || []
    // If todo has associated images in S3, then delete those images
    await Promise.all([
      deleteItem(todoId),
      ...images.map(async imageId => await deleteObject(imageId))
    ])
    // Returns delete todo's id to indicate it was successfully deleted
    res.json({ id: todoId })
  } catch (error) {
    log({ level: 'error', event: 'api.todo.delete.error', error, requestId: req.headers['Todo-Request-Id'] })
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error deleting todo',
        stack: error.stack || null
      })
    }
  }
})

const port = 3000
const server = app.listen(port, error => {
  if (error) {
    log({ level: 'error', event: 'api.server.error', error })
  } else {
    log({ level: 'info', event: 'api.server.running', port })
  }
})

process.once('SIGTERM', async () => {
  log({ level: 'info', event: 'api.server.signal', signal: 'SIGTERM' })
  server.close(error => {
    if (error) {
      log({ level: 'error', event: 'api.server.closed.error', error })
    } else {
      log({ level: 'info', event: 'api.server.closed' })
    }
    process.exit(error ? 1 : 0)
  })
})
