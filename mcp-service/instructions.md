# Noop Todo App MCP Server

Demonstration of running an MCP server on the Noop Developer Platform within both local development and production cloud environments. Utilizes the Streamable HTTP transport mechanism to facilitate bidirectional communication between MCP servers and clients.

This server provides the ability to interface with a todo list. This todo list can contain multiple todo items. Each todo item can be optionally linked to up to 6 images. Todo items are managed in a DynamoDB table. Images are stored in an S3 bucket.

## Todo Item Schema

- `id`: Randomly generated version 4 UUID that serves as an identifier for the todo item. **Do not expose to end users in client responses.** Used to identify links between todo items and images. Cannot be updated after creation. Type: string.
- `description`: Description of the todo item. Can be updated after creation. Type: string. Maximum length: 256 characters.
- `created`: Unix timestamp in milliseconds representing when the todo item was created, relative to the Unix Epoch. Cannot be updated after creation. Type: integer.
- `completed`: Completion status of the todo item. Can be updated after creation. Type: boolean. Default: false.
- `images`: List of randomly generated version 4 UUIDs that serve as identifiers for images linked to the todo item. Between 0 and 6 (inclusive) images can be linked to a todo item. This field will be omitted if there are no linked images. **Do not expose to end users in client responses.** Used to identify links between todo items and images. Cannot be updated after creation. Type: array of strings. Optional.

**Example Todo Item:**

```json
{
  "id": "1fa54e5f-a96d-4319-bfd6-46d5ef3e6db",
  "description": "Buy milk",
  "created": 1720987654321,
  "completed": false,
  "images": [
    "ccd32848-3b91-4b67-9b6d-1b2b49b1a3c8",
    "53629d04-5f83-4ccf-b2b8-105e139e4ee2"
  ]
}
```

## Tools

- `listTodos`: Returns all todo items and their linked images.
- `getTodo`: Gets a todo item by id. Returns the requested todo item and its linked images.
- `createTodo`: Creates a todo item and its linked images. Requires a description as input. Can optionally include a list of up to 6 external URLs for images. Each image must be smaller than 1MB. If no external URLs are provided, select between 0 and 6 (inclusive) images from `https://images.unsplash.com` appended with the query string value `?w=640&h=640&fit=max&auto=compress&q=50&fm=avif`. Only select images from `https://images.unsplash.com` that are relevant to the provided `description` field. If no relevant images exist, do not provide any images from Unsplash. Returns the created todo item and its linked images.
- `updateTodo`: Updates a todo item by id. Only the `description` and `completed` fields can be updated. Returns the updated todo item and its linked images.
- `deleteTodo`: Requires a todo item id as input. Deletes the requested todo item and its linked images. Returns a confirmation that the requested todo item and its linked images have been deleted.
- `getImage`: Gets an image by id. Returns the requested image and its linked todo item.

**Note:**

- Fields marked as 'do not expose to end users in client responses' should not be shown in the UI unless required for linking.
- If required fields are missing or invalid (e.g., description missing, description too long, too many images, image too large), a descriptive error message will be returned.
- If a todo item or image is not found, a descriptive error message will be returned.
