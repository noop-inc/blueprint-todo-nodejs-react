import express from 'express'
import multer from 'multer'
import morgan from 'morgan'
import { lookup } from 'mime-types'
import cors from 'cors'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { scanTable, getItem, putItem, deleteItem } from './dynamodb.js'
import { getObject, uploadObject, deleteObject } from './s3.js'

const app = express()
app.use(cors())
app.use(express.json())

app.use(morgan((tokens, req, res) =>
  JSON.stringify({
    event: 'api.request',
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: parseFloat(tokens.status(req, res)),
    contentLength: parseFloat(tokens.res(req, res, 'content-length')),
    responseTime: parseFloat(tokens['response-time'](req, res))
  })
))

// Limit Uploads to 6 files
const upload = multer({
  limits: { files: 6 }
})
const uploader = upload.array('image', 6)

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
    const contentType = response.ContentType || lookup(imageId)
    res.setHeader('Content-Type', contentType)
    response.Body.pipe(res)
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.image.get.error', error: error.message }))
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Error getting image'
        }
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
    console.log(JSON.stringify({ event: 'api.todos.get.error', error: error.message }))
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Error getting todos'
        }
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
app.post('/api/todos', uploader, async (req, res) => {
  try {
    const files = req?.files || []
    // Uploads images to S3, returns array of S3 keys for uploaded files
    const images = await Promise.all(
      files.map(async ({ buffer, mimetype, originalname }) => {
        if (!mimetype.startsWith('image/')) {
          throw new Error(`Invalid content type for image: ${originalname}. Expected image/* but got ${mimetype}.`)
        }

        const metadata = await sharp(buffer).metadata()
        const convertFormat = metadata.type !== 'webp'
        const convertSize = (metadata.height > 640) || (metadata.width > 640)

        let transformer
        if (convertSize || convertFormat) {
          transformer = sharp()
          if (convertSize) {
            transformer = transformer.resize({ width: 640, height: 640, fit: sharp.fit.inside })
          }
          if (convertFormat) {
            transformer = transformer.toFormat('webp')
          }
        }

        const readableStream = Readable.from(buffer)
        return await uploadObject({
          buffer: transformer ? readableStream.pipe(transformer) : readableStream,
          mimetype: 'image/webp'
        })
      })
    )
    const body = req.body
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
    console.log(JSON.stringify({ event: 'api.todos.create.error', error: error.message }))
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Error creating todo'
        }
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
    console.log(JSON.stringify({ event: 'api.todo.get.error', error: error.message }))
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Error getting todo'
        }
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
    console.log(JSON.stringify({ event: 'api.todo.update.error', error: error.message }))
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Error updating todo'
        }
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
      ...images.map(imageId => deleteObject(imageId))
    ])
    // Returned delete todo's id to indicate it was successfully deleted
    res.json({ id: todoId })
  } catch (error) {
    console.log(JSON.stringify({ event: 'api.todo.delete.error', error: error.message }))
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Error deleting todo'
        }
      })
    }
  }
})

const port = 3000
const server = app.listen(port, error => {
  if (error) {
    console.log(JSON.stringify({ event: 'api.server.error', error: error.message }))
  } else {
    console.log(JSON.stringify({ event: 'api.server.running', port }))
  }
})

process.once('SIGTERM', async () => {
  console.log(JSON.stringify({ event: 'api.server.signal', signal: 'SIGTERM' }))
  server.close(error => {
    if (error) {
      console.log(JSON.stringify({ event: 'api.server.closed.error', error: error.message }))
    } else {
      console.log(JSON.stringify({ event: 'api.server.closed' }))
    }
    process.exit(error ? 1 : 0)
  })
})
