import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import compression from 'compression'
import sharp from 'sharp'
import { Readable } from 'node:stream'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'
import busboy from 'busboy'
import { randomUUID } from 'node:crypto'

const streamToImageId = async stream => {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
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
      transformer = transformer.toFormat('avif', { quality: 50, lossless: false, chromaSubsampling: '4:2:0', bitdepth: 8 })
    }
  }
  const format = (
    convertFormat ||
    (metadata.format === 'avif') ||
    ((metadata.format === 'heif') && (metadata.compression === 'av1'))
  )
    ? 'avif'
    : 'webp'
  return await uploadObject({
    body: transformer ? Readable.from(buffer).pipe(transformer) : buffer,
    mimeType: `image/${format}`
  })
}

morgan.token('id', req => req.id)

const app = express()
app.use((req, res, next) => {
  req.id = randomUUID()
  next()
})
app.use(compression())
app.use(cors())
app.use(express.json())

app.use(morgan((tokens, req, res) =>
  JSON.stringify({
    event: 'api.request',
    requestId: tokens.id(req, res),
    method: tokens.method(req, res),
    url: tokens.url(req, res)
  })
))

app.use(morgan((tokens, req, res) =>
  JSON.stringify({
    event: 'api.response',
    requestId: tokens.id(req, res),
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

// get image
//
// Param `imageId` corresponds to the key of an image file in S3
app.get('/api/images/:imageId', async (req, res) => {
  try {
    const params = req.params
    const imageId = params.imageId
    const response = await getObject(imageId)
    res.set('Content-Type', response.ContentType)
    res.set('Cache-Control', 'max-age=31536000')
    response.Body.pipe(res)
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.image.get.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error getting image',
        stack: error.stack
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
    console.log(JSON.stringify({ event: 'api.todos.get.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error getting todos',
        stack: error.stack
      })
    }
  }
})

// create new todo
//
// Payload (req.body):
//   description / type: String / required
//
// Files (req.files):
//   images / type: File/Buffer / optional
app.post('/api/todos', async (req, res) => {
  try {
    // Uploads images to S3, returns array of S3 keys for uploaded files
    const imagePromises = []
    const body = {}
    const bb = busboy({
      headers: req.headers,
      // Limit Uploads to 6 files, max size 1MB each per todo
      limits: { fileSize: (1028 ** 2), files: 6 }
    })
    await new Promise((resolve, reject) => {
      bb.on('file', (name, file, { filename, mimeType }) => {
        if (!mimeType.startsWith('image/')) {
          return reject(new Error(`Invalid content type for image: ${filename}. Expected image/* but got ${mimeType}.`))
        }
        imagePromises.push(streamToImageId(file))
      })
      bb.on('field', (name, value) => {
        body[name] = value
      })
      bb.once('error', reject)
      bb.once('close', resolve)
      req.pipe(bb)
    })
    const images = await Promise.all(imagePromises)
    const description = body.description
    const newTodo = {
      description,
      created: Date.now(),
      completed: false
    }
    // If images were included with todo includes array of S3 keys for images with todo
    if (images.length) newTodo.images = images
    const item = await putItem(newTodo)
    res.json(item)
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.todos.create.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error creating todo',
        stack: error.stack
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
    res.json(item)
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.todo.get.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error getting todo',
        stack: error.stack
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
    const body = req.body
    const newItem = { ...existingItem, ...body }
    const item = await putItem(newItem)
    res.json(item)
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.todo.update.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error updating todo',
        stack: error.stack
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
    const images = item.images || []
    // If todo has associated images in S3, then delete those images
    await Promise.all([
      deleteItem(todoId),
      ...images.map(async imageId => await deleteObject(imageId))
    ])
    // Returned delete todo's id to indicate it was successfully deleted
    res.json({ id: todoId })
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.todo.delete.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    if (!res.headersSent) {
      res.status(500).json({
        code: error.code || 'Error',
        message: error.message || 'Error deleting todo',
        stack: error.stack
      })
    }
  }
})

const port = 3000
const server = app.listen(port, error => {
  if (error) {
    console.log(JSON.stringify({ event: 'api.server.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
  } else {
    console.log(JSON.stringify({ event: 'api.server.running', port }))
  }
})

process.once('SIGTERM', async () => {
  console.log(JSON.stringify({ event: 'api.server.signal', signal: 'SIGTERM' }))
  server.close(error => {
    if (error) {
      console.log(JSON.stringify({ event: 'api.server.closed.error', code: error.code || 'Error', error: error.message || `${error}`, stack: error.stack }))
    } else {
      console.log(JSON.stringify({ event: 'api.server.closed' }))
    }
    process.exit(error ? 1 : 0)
  })
})
