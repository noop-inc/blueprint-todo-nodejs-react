# Noop Todo App MCP Server

Demonstration of running an MCP server on the Noop Developer Platform within both local development and production cloud environments. Utilizes the Streamable HTTP transport mechanism to facilitate bidirectional communication between MCP servers and clients.

This server provides the ability to interface with a todo list. This todo list can contain multiple todo items. Each todo item can be optionally linked to up to 6 images. Todo items are managed in a DynamoDB table. Images are stored in an S3 bucket.

## Todo Item Schema

- `id`: Randomly generated version 4 UUID to serve as identifier for todo item. **Do not expose to end users in client responses.** Use to identify links between todo items and images. Cannot be updated after creation. Type: string.
- `description`: Description of todo item. Can be updated after creation. Type: string.
- `created`: Unix timestamp in milliseconds representing when the todo item was created in reference to the Unix Epoch. Cannot be updated after creation. Type: integer.
- `completed`: Completion status of todo item. Can be updated after creation. Type: boolean. Default: false.
- `images`: List of randomly generated version 4 UUIDs to serve as identifiers for for images linked to todo item. Includes file extension of image as suffix. Maximum of 6 images can be linked to todo item. **Do not expose to end users in client responses.** Use to identify links between todo items and images. Cannot be updated after creation. Type: array of strings. Optional.

**Example Todo Item:**

```json
{
  "id": "1fa54e5f-a96d-4319-bfd6-46d5ef3e6db",
  "description": "Buy milk",
  "created": 1720987654321,
  "completed": false,
  "images": [
    "ccd32848-3b91-4b67-9b6d-1b2b49b1a3c8.webp",
    "53629d04-5f83-4ccf-b2b8-105e139e4ee2.webp"
  ]
}
```

## Tools

- `list-todos`: Requires no input. Returns a list of all todo items and linked images.
- `get-todo`: Requires todo item id as input. Returns requested todo item and linked images.
- `create-todo`: Requires description as input. Can optionally include a list of up to 6 external URLs for images. Each image must be smaller than 100KB. If no external URLs are provided, select between 0 and 3 (inclusive) images from `https://images.unsplash.com` appended with the query string `?w=360&h=240&fit=crop&fm=webp&auto=compress`. Returns created todo item and linked images.
- `update-todo`: Requires todo item id as input. Can optionally include updated `description` and `completed` values. Returns updated todo item and linked images.
- `delete-todo`: Requires todo item id as input. Deletes requested todo item and linked images. Returns confirmation that the requested todo item and linked images have been deleted.
- `get-image`: Requires image id as input. Returns requested image and linked todo item.

**Note:**

- Fields marked "Do not expose to end users in client responses" should not be shown in UI unless required for linking.
- If more than 6 images are provided, a descriptive error message will be returned.
- If required fields are missing or invalid (e.g., description missing, too many images, image too large), a descriptive error message will be returned.
- If todo item or image is not found, a descriptive error message will be returned.
