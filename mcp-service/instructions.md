# Noop Todo App MCP Server

Demonstration of running an MCP server on the Noop Developer Platform within both local development and production cloud environments. Utilizes the Streamable HTTP transport mechanism to facilitate bidirectional communication between MCP servers and clients.

This server provides the ability to interface with a todo list. This todo list can contain multiple todo items. Each todo item can be optionally linked to up to 6 images. Todo items are managed in a DynamoDB table. Images are stored in an S3 bucket.

## Todo Item Schema

- `id`: Randomly generated version 4 UUID to serve as an identifier for the todo item. **Do not expose to end users in client responses.** Use to identify links between todo items and images. Cannot be updated after creation. Type: string.
- `description`: Description of todo item. Can be updated after creation. Type: string.
- `created`: Unix timestamp in milliseconds representing when the todo item was created in reference to the Unix Epoch. Cannot be updated after creation. Type: number.
- `completed`: Completion status of todo item. Can be updated after creation. Type: boolean. Default: false.
- `images`: List of randomly generated version 4 UUIDs to serve as identifiers for images linked to the todo item. Includes file extension of image as a suffix. A maximum of 6 images can be linked to a todo item. **Do not expose to end users in client responses.** Use to identify links between todo items and images. Cannot be updated after creation. Type: array of strings. Optional.

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

- `list-todos`: Requires no input. Returns a list of all todo items and their linked images.
- `get-todo`: Requires atodo item id as input. Returns the requested todo item and its linked images.
- `create-todo`: Requires a description as input. Can optionally include a list of up to 6 external URLs for images. If no external URLs are provided, select between 0 and 6 (inclusive) images from `https://images.unsplash.com`. Only select images from `https://images.unsplash.com` that are relevant to the provided `description` field. If no relevant images exist, do not provide any images from Unsplash. Returns the created todo item and its linked images.
- `update-todo`: Requires a todo item id as input. Can optionally include an updated `description` and/or `completed` value. Returns the updated todo item and its linked images.
- `delete-todo`: Requires a todo item id as input. Deletes the requested todo item and its linked images. Returns a confirmation that the requested todo item and its linked images have been deleted.
- `get-image`: Requires an image id as input. Returns the requested image and its linked todo item.

**Note:**

- Fields marked "do not expose to end users in client responses" should not be shown in the UI unless required for linking.
- If more than 6 images are provided, a descriptive error message will be returned.
- If required fields are missing or invalid (e.g., description missing, too many images, image too large), a descriptive error message will be returned.
- If a todo item or image is not found, a descriptive error message will be returned.
