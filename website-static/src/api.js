const throwError = async response => {
  if (response.headers.get('content-type') === 'application/json') {
    const body = await response.json()
    throw body
  } else {
    const body = await response.text()
    throw new Error(body)
  }
}

const handleFetch = async (...args) => {
  const response = await window.fetch(...args)
  if (!response.ok) await throwError(response)
  return response
}

export const fetchAllTodos = async () => {
  const response = await handleFetch('/api/todos')
  return await response.json()
}

export const fetchTodo = async id => {
  const response = await handleFetch(`/api/todos/${id}`)
  return await response.json()
}

export const createTodo = async (description, images) => {
  const formData = new FormData()
  formData.append('description', description)
  images.forEach(({ file }) => {
    formData.append('image', file)
  })
  const response = await handleFetch(
    '/api/todos/',
    { method: 'POST', body: formData }
  )
  return await response.json()
}

export const updateTodo = async item => {
  const response = await handleFetch(
    `/api/todos/${item.id}`,
    {
      method: 'PUT',
      body: JSON.stringify(item),
      headers: {
        'Content-Type': 'application/json'
      }
    }
  )
  return await response.json()
}

export const deleteTodo = async id => {
  const response = await handleFetch(
    `/api/todos/${id}`,
    { method: 'DELETE' }
  )
  return await response.json()
}
